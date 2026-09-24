//! ES module loader: `N.runModule`, dynamic `import()`, `import.meta`.
//!
//! Modules are keyed by absolute URL. Loading a graph compiles the entry module, resolves
//! its static imports relative to the module URL (WHATWG URL parsing), fetches all
//! missing dependencies in parallel through `ScriptHost::fetch` (ids with the high bit
//! set), and instantiates + evaluates once every module in the graph is compiled.
//! Evaluation returns a promise (top-level await); the job's promise adopts it.

use std::collections::{HashMap, HashSet};

use common::protocol::{CacheMode, Destination, NetRequest, NetResponse};

use crate::cx::{self, v8_str};
use crate::runtime::MODULE_FETCH_BIT;
use crate::state::{RuntimeState, StatePtr};

enum Entry {
    Fetching,
    Ready(v8::Global<v8::Module>),
    Failed(v8::Global<v8::Value>),
}

struct Job {
    root: String,
    resolver: v8::Global<v8::PromiseResolver>,
    /// Resolve with the module namespace (dynamic import) instead of undefined.
    namespace: bool,
}

/// A specifier map of an import map: (normalized key, address or `None` if invalid),
/// sorted by key in descending code-unit order (longest prefixes first).
type SpecifierMap = Vec<(String, Option<String>)>;

/// An import map (<https://html.spec.whatwg.org/#import-maps>).
#[derive(Default)]
pub(crate) struct ImportMap {
    imports: SpecifierMap,
    /// (scope prefix URL, specifier map), sorted by prefix descending.
    scopes: Vec<(String, SpecifierMap)>,
}

impl ImportMap {
    /// Parse an import map's JSON text; relative addresses resolve against `base`.
    pub(crate) fn parse(text: &str, base: &url::Url) -> Result<ImportMap, String> {
        let v: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
        let obj = v
            .as_object()
            .ok_or("the top-level value must be a JSON object")?;
        let mut map = ImportMap::default();
        if let Some(imports) = obj.get("imports") {
            let m = imports
                .as_object()
                .ok_or("\"imports\" must be a JSON object")?;
            map.imports = specifier_map(m, base);
        }
        if let Some(scopes) = obj.get("scopes") {
            let m = scopes
                .as_object()
                .ok_or("\"scopes\" must be a JSON object")?;
            for (prefix, entries) in m {
                let Ok(prefix) = base.join(prefix) else {
                    continue;
                };
                let entries = entries
                    .as_object()
                    .ok_or("each scope must be a JSON object")?;
                map.scopes
                    .push((prefix.to_string(), specifier_map(entries, base)));
            }
            map.scopes.sort_by(|a, b| b.0.cmp(&a.0));
        }
        Ok(map)
    }

    /// Merge `other` into `self`; existing entries win.
    pub(crate) fn merge(&mut self, other: ImportMap) {
        for (k, v) in other.imports {
            if !self.imports.iter().any(|(e, _)| *e == k) {
                self.imports.push((k, v));
            }
        }
        self.imports.sort_by(|a, b| b.0.cmp(&a.0));
        for (prefix, entries) in other.scopes {
            match self.scopes.iter_mut().find(|(p, _)| *p == prefix) {
                Some((_, existing)) => {
                    for (k, v) in entries {
                        if !existing.iter().any(|(e, _)| *e == k) {
                            existing.push((k, v));
                        }
                    }
                    existing.sort_by(|a, b| b.0.cmp(&a.0));
                }
                None => self.scopes.push((prefix, entries)),
            }
        }
        self.scopes.sort_by(|a, b| b.0.cmp(&a.0));
    }

    /// Resolve `specifier` from a module/script with base URL `base` through the map;
    /// `None` if no entry applies.
    fn resolve(&self, base: &str, specifier: &str) -> Option<Result<String, String>> {
        let base_url = url::Url::parse(base).ok()?;
        let as_url = parse_url_like(specifier, &base_url);
        let normalized = as_url.clone().unwrap_or_else(|| specifier.to_string());
        for (prefix, entries) in &self.scopes {
            if (prefix == base || (prefix.ends_with('/') && base.starts_with(prefix.as_str())))
                && let Some(r) = imports_match(&normalized, as_url.as_deref(), entries)
            {
                return Some(r);
            }
        }
        imports_match(&normalized, as_url.as_deref(), &self.imports)
    }
}

/// A URL-like specifier (`/`, `./`, `../` or absolute) parsed against `base`.
fn parse_url_like(specifier: &str, base: &url::Url) -> Option<String> {
    if specifier.starts_with('/') || specifier.starts_with("./") || specifier.starts_with("../") {
        base.join(specifier).ok().map(|u| u.to_string())
    } else {
        url::Url::parse(specifier).ok().map(|u| u.to_string())
    }
}

fn specifier_map(m: &serde_json::Map<String, serde_json::Value>, base: &url::Url) -> SpecifierMap {
    let mut out: SpecifierMap = Vec::with_capacity(m.len());
    for (key, value) in m {
        if key.is_empty() {
            continue;
        }
        let key = parse_url_like(key, base).unwrap_or_else(|| key.clone());
        let address = value
            .as_str()
            .and_then(|v| parse_url_like(v, base))
            .filter(|a| !key.ends_with('/') || a.ends_with('/'));
        out.push((key, address));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

fn imports_match(
    normalized: &str,
    as_url: Option<&str>,
    map: &SpecifierMap,
) -> Option<Result<String, String>> {
    let special = |u: &str| {
        url::Url::parse(u)
            .is_ok_and(|u| matches!(u.scheme(), "http" | "https" | "ws" | "wss" | "ftp" | "file"))
    };
    for (key, address) in map {
        if key == normalized {
            return Some(
                address
                    .clone()
                    .ok_or_else(|| format!("the import map blocks \"{normalized}\"")),
            );
        }
        if key.ends_with('/') && normalized.starts_with(key.as_str()) && as_url.is_none_or(special)
        {
            let Some(address) = address else {
                return Some(Err(format!("the import map blocks \"{normalized}\"")));
            };
            let after = &normalized[key.len()..];
            let resolved = url::Url::parse(address).and_then(|a| a.join(after));
            return Some(match resolved {
                Ok(u) if u.as_str().starts_with(address.as_str()) => Ok(u.to_string()),
                _ => Err(format!(
                    "\"{normalized}\" backtracks above its import map prefix \"{key}\""
                )),
            });
        }
    }
    None
}

#[derive(Default)]
pub(crate) struct ModuleLoader {
    /// Import maps found in the document (merged).
    pub(crate) import_map: Option<ImportMap>,
    map: HashMap<String, Entry>,
    /// Module identity hash -> (module, url), to find a module's URL in callbacks.
    by_hash: HashMap<i32, Vec<(v8::Global<v8::Module>, String)>>,
    /// Fetch id -> module URL.
    fetches: HashMap<u64, String>,
    jobs: Vec<Job>,
    next_fetch: u64,
}

impl ModuleLoader {
    pub(crate) fn is_loading(&self) -> bool {
        !self.fetches.is_empty() || !self.jobs.is_empty()
    }

    pub(crate) fn clear(&mut self) {
        self.import_map = None;
        self.map.clear();
        self.by_hash.clear();
        self.fetches.clear();
        self.jobs.clear();
    }
}

fn state_of(scope: &v8::PinScope) -> Option<&'static RuntimeState> {
    scope.get_slot::<StatePtr>().copied().map(|p| p.get())
}

/// Resolve a module specifier from the script or module with base URL `base`: through
/// the document's import map, else as a URL.
pub(crate) fn resolve_module(
    st: &RuntimeState,
    base: &str,
    specifier: &str,
) -> Result<String, String> {
    if let Some(map) = &st.modules.borrow().import_map
        && let Some(r) = map.resolve(base, specifier)
    {
        return r;
    }
    resolve_specifier(base, specifier)
}

/// Resolve a module specifier against `base` (bare specifiers fail).
pub(crate) fn resolve_specifier(base: &str, specifier: &str) -> Result<String, String> {
    if specifier.starts_with('/') || specifier.starts_with("./") || specifier.starts_with("../") {
        let base = url::Url::parse(base).map_err(|e| format!("invalid base URL {base}: {e}"))?;
        return base
            .join(specifier)
            .map(|u| u.to_string())
            .map_err(|e| format!("invalid module specifier \"{specifier}\": {e}"));
    }
    match url::Url::parse(specifier) {
        Ok(u) => Ok(u.to_string()),
        Err(_) => Err(format!(
            "Failed to resolve module specifier \"{specifier}\". Relative references must start with either \"/\", \"./\", or \"../\"."
        )),
    }
}

/// Base URL for resolving specifiers in, and `import.meta.url` of, the script or module
/// named `url`: inline scripts and modules are named after the document URL (inline
/// modules plus a unique fragment) and use the document's base URL; others their own URL.
fn base_for(st: &RuntimeState, url: &str) -> String {
    let doc_url = st.url.borrow().clone();
    let inline = url::Url::parse(url)
        .is_ok_and(|u| u[..url::Position::AfterQuery] == doc_url[..url::Position::AfterQuery]);
    if !inline {
        return url.to_string();
    }
    match st.doc() {
        Ok(doc) => crate::dom::base_url(doc, &doc_url).to_string(),
        Err(_) => doc_url.to_string(),
    }
}

fn url_of_module(
    st: &RuntimeState,
    scope: &v8::PinScope,
    module: v8::Local<v8::Module>,
) -> Option<String> {
    let loader = st.modules.borrow();
    let list = loader.by_hash.get(&module.get_identity_hash().get())?;
    list.iter()
        .find(|(g, _)| v8::Local::new(scope, g) == module)
        .map(|(_, u)| u.clone())
}

fn type_error<'s>(scope: &mut v8::PinScope<'s, '_>, msg: &str) -> v8::Local<'s, v8::Value> {
    let m = v8_str(scope, msg);
    v8::Exception::type_error(scope, m)
}

/// Compile `source` as module `url`, register it and request its dependencies.
fn compile_and_register(scope: &mut v8::PinScope, st: &RuntimeState, url: &str, source: &str) {
    let result = {
        v8::tc_scope!(let tc, scope);
        let src = v8_str(tc, source);
        let name = v8_str(tc, url);
        let origin = v8::ScriptOrigin::new(
            tc,
            name.into(),
            0,
            0,
            false,
            0,
            None,
            false,
            false,
            true,
            None,
        );
        let mut source = v8::script_compiler::Source::new(src, Some(&origin));
        match v8::script_compiler::compile_module(tc, &mut source) {
            Some(m) => Ok(m),
            None => Err(tc.exception()),
        }
    };
    let module = match result {
        Ok(m) => m,
        Err(exc) => {
            let exc = exc.unwrap_or_else(|| type_error(scope, "module compilation failed"));
            let g = v8::Global::new(scope, exc);
            st.modules
                .borrow_mut()
                .map
                .insert(url.to_string(), Entry::Failed(g));
            return;
        }
    };
    let g = v8::Global::new(scope, module);
    {
        let mut loader = st.modules.borrow_mut();
        loader
            .by_hash
            .entry(module.get_identity_hash().get())
            .or_default()
            .push((v8::Global::new(scope, module), url.to_string()));
        loader.map.insert(url.to_string(), Entry::Ready(g));
    }
    // Dependencies.
    let requests = module.get_module_requests();
    let mut deps = Vec::new();
    for i in 0..requests.length() {
        let Some(data) = requests.get(scope, i) else {
            continue;
        };
        let Ok(req) = v8::Local::<v8::ModuleRequest>::try_from(data) else {
            continue;
        };
        let spec = req.get_specifier().to_rust_string_lossy(scope);
        match resolve_module(st, &base_for(st, url), &spec) {
            Ok(dep) => deps.push(dep),
            Err(msg) => {
                let exc = type_error(scope, &msg);
                let g = v8::Global::new(scope, exc);
                st.modules
                    .borrow_mut()
                    .map
                    .insert(url.to_string(), Entry::Failed(g));
                return;
            }
        }
    }
    for dep in deps {
        start_fetch(st, &dep);
    }
}

fn start_fetch(st: &RuntimeState, url: &str) {
    let id = {
        let mut loader = st.modules.borrow_mut();
        if loader.map.contains_key(url) {
            return;
        }
        loader.map.insert(url.to_string(), Entry::Fetching);
        loader.next_fetch += 1;
        let id = MODULE_FETCH_BIT | loader.next_fetch;
        loader.fetches.insert(id, url.to_string());
        id
    };
    let mut req = NetRequest::get(id, url, Destination::Script);
    req.headers.push(("Accept".into(), "*/*".into()));
    req.referrer = Some(st.url_string());
    req.cache_mode = CacheMode::Default;
    st.host.fetch(req);
}

fn is_js_mime(ct: &str) -> bool {
    let essence = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        essence.as_str(),
        "" | "text/javascript"
            | "application/javascript"
            | "application/x-javascript"
            | "application/ecmascript"
            | "application/x-ecmascript"
            | "text/ecmascript"
            | "text/jscript"
            | "text/livescript"
            | "text/x-ecmascript"
            | "text/x-javascript"
            | "text/javascript1.0"
            | "text/javascript1.1"
            | "text/javascript1.2"
            | "text/javascript1.3"
            | "text/javascript1.4"
            | "text/javascript1.5"
            | "application/octet-stream"
    )
}

/// A module fetch completed (called from `ScriptRuntime::deliver_fetch`).
pub(crate) fn on_fetch_response(scope: &mut v8::PinScope, st: &RuntimeState, resp: NetResponse) {
    let Some(url) = st.modules.borrow_mut().fetches.remove(&resp.id) else {
        return;
    };
    let ok = resp.error.is_none() && (200..300).contains(&resp.status);
    if !ok {
        let msg = match &resp.error {
            Some(e) => format!("Failed to fetch module {url}: {e}"),
            None => format!("Failed to fetch module {url}: HTTP {}", resp.status),
        };
        fail(scope, st, &url, &msg);
    } else if let Some(ct) = resp.header("content-type").filter(|ct| !is_js_mime(ct)) {
        let msg = format!(
            "Failed to load module script {url}: expected a JavaScript module script but the server responded with a MIME type of \"{ct}\""
        );
        fail(scope, st, &url, &msg);
    } else {
        let source = String::from_utf8_lossy(&resp.body).into_owned();
        compile_and_register(scope, st, &url, &source);
    }
    advance(scope, st);
}

fn fail(scope: &mut v8::PinScope, st: &RuntimeState, url: &str, msg: &str) {
    let exc = type_error(scope, msg);
    let g = v8::Global::new(scope, exc);
    st.modules
        .borrow_mut()
        .map
        .insert(url.to_string(), Entry::Failed(g));
}

enum GraphState {
    Pending,
    Failed(v8::Global<v8::Value>),
    Ready,
}

fn graph_state(scope: &mut v8::PinScope, st: &RuntimeState, root: &str) -> GraphState {
    let mut visited = HashSet::new();
    let mut stack = vec![root.to_string()];
    let mut pending = false;
    while let Some(url) = stack.pop() {
        if !visited.insert(url.clone()) {
            continue;
        }
        let module = {
            let loader = st.modules.borrow();
            match loader.map.get(&url) {
                None | Some(Entry::Fetching) => {
                    pending = true;
                    continue;
                }
                Some(Entry::Failed(e)) => return GraphState::Failed(e.clone()),
                Some(Entry::Ready(m)) => v8::Local::new(scope, m),
            }
        };
        let requests = module.get_module_requests();
        for i in 0..requests.length() {
            let Some(data) = requests.get(scope, i) else {
                continue;
            };
            let Ok(req) = v8::Local::<v8::ModuleRequest>::try_from(data) else {
                continue;
            };
            let spec = req.get_specifier().to_rust_string_lossy(scope);
            if let Ok(dep) = resolve_module(st, &base_for(st, &url), &spec) {
                stack.push(dep);
            }
        }
    }
    if pending {
        GraphState::Pending
    } else {
        GraphState::Ready
    }
}

/// Instantiate + evaluate every job whose graph is complete; reject failed ones.
fn advance(scope: &mut v8::PinScope, st: &RuntimeState) {
    let mut i = 0;
    loop {
        let (root, namespace) = {
            let loader = st.modules.borrow();
            let Some(job) = loader.jobs.get(i) else { break };
            (job.root.clone(), job.namespace)
        };
        let state = graph_state(scope, st, &root);
        if matches!(state, GraphState::Pending) {
            i += 1;
            continue;
        }
        let job = st.modules.borrow_mut().jobs.remove(i);
        let resolver = v8::Local::new(scope, &job.resolver);
        match state {
            GraphState::Failed(e) => {
                let e = v8::Local::new(scope, &e);
                resolver.reject(scope, e);
            }
            GraphState::Ready => {
                let module = {
                    let loader = st.modules.borrow();
                    match loader.map.get(&root) {
                        Some(Entry::Ready(m)) => v8::Local::new(scope, m),
                        _ => continue,
                    }
                };
                evaluate_into(scope, module, resolver, namespace);
            }
            GraphState::Pending => unreachable!(),
        }
    }
}

fn evaluate_into<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    module: v8::Local<'s, v8::Module>,
    resolver: v8::Local<'s, v8::PromiseResolver>,
    namespace: bool,
) {
    let result = {
        v8::tc_scope!(let tc, scope);
        let mut ok = true;
        if module.get_status() == v8::ModuleStatus::Uninstantiated
            && module.instantiate_module(tc, resolve_callback) != Some(true)
        {
            ok = false;
        }
        let r = if ok { module.evaluate(tc) } else { None };
        match r {
            Some(v) => Ok(v),
            None => Err(tc.exception()),
        }
    };
    match result {
        Err(exc) => {
            let exc = exc.unwrap_or_else(|| type_error(scope, "module evaluation failed"));
            resolver.reject(scope, exc);
        }
        Ok(v) => {
            if namespace {
                let ns = module.get_module_namespace();
                if v.is_promise() {
                    let p: v8::Local<v8::Promise> = v.try_into().unwrap();
                    // p.then(() => ns)
                    let f = v8::Function::builder(
                        |_: &mut v8::PinScope,
                         args: v8::FunctionCallbackArguments,
                         mut rv: v8::ReturnValue<v8::Value>| {
                            rv.set(args.data());
                        },
                    )
                    .data(ns)
                    .build(scope);
                    match f.and_then(|f| p.then(scope, f)) {
                        Some(chained) => {
                            resolver.resolve(scope, chained.into());
                        }
                        None => {
                            resolver.resolve(scope, ns);
                        }
                    }
                } else {
                    resolver.resolve(scope, ns);
                }
            } else {
                resolver.resolve(scope, v);
            }
        }
    }
}

fn resolve_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    let st = state_of(scope)?;
    let spec = specifier.to_rust_string_lossy(scope);
    let base = url_of_module(st, scope, referrer).unwrap_or_else(|| st.url_string());
    let resolved = match resolve_module(st, &base_for(st, &base), &spec) {
        Ok(u) => u,
        Err(msg) => {
            let e = type_error(scope, &msg);
            scope.throw_exception(e);
            return None;
        }
    };
    let global = {
        let loader = st.modules.borrow();
        match loader.map.get(&resolved) {
            Some(Entry::Ready(m)) => Some(m.clone()),
            _ => None,
        }
    };
    match global {
        Some(g) => Some(v8::Local::new(scope, &g)),
        None => {
            let e = type_error(scope, &format!("module not loaded: {resolved}"));
            scope.throw_exception(e);
            None
        }
    }
}

/// Start loading a module graph rooted at `url`. With `source` the root is an inline
/// module. Returns the promise settled when evaluation completes.
pub(crate) fn load<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    url: &str,
    source: Option<&str>,
    namespace: bool,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let existing = st.modules.borrow().map.contains_key(url);
    match source {
        Some(src) if !existing => compile_and_register(scope, st, url, src),
        Some(_) => {}
        None => start_fetch(st, url),
    }
    let g = v8::Global::new(scope, resolver);
    st.modules.borrow_mut().jobs.push(Job {
        root: url.to_string(),
        resolver: g,
        namespace,
    });
    advance(scope, st);
    Some(promise)
}

/// Collect the document's `<script type="importmap">` elements (at `document_parsed`,
/// before any module loads). Parse errors are reported to the console.
pub(crate) fn register_document_import_maps(st: &RuntimeState, doc: &blitz_dom::BaseDocument) {
    let doc_url = st.url.borrow().clone();
    let base = crate::dom::base_url(doc, &doc_url);
    for id in crate::dom::subtree(doc, doc.root_node().id) {
        let is_map = crate::dom::is_html_id(doc, id, &blitz_dom::local_name!("script"))
            && crate::dom::get_attr(doc, id, "type")
                .is_some_and(|t| t.trim().eq_ignore_ascii_case("importmap"));
        if !is_map {
            continue;
        }
        let text = crate::dom::child_text(doc, id);
        match ImportMap::parse(&text, &base) {
            Ok(map) => {
                let mut loader = st.modules.borrow_mut();
                match &mut loader.import_map {
                    Some(existing) => existing.merge(map),
                    None => loader.import_map = Some(map),
                }
            }
            Err(e) => st.host.console(
                "error",
                &format!("Uncaught TypeError: Failed to parse import map: {e}"),
            ),
        }
    }
}

/// `import()` from classic scripts and modules.
pub(crate) fn dynamic_import_callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let st = state_of(scope)?;
    let spec = specifier.to_rust_string_lossy(scope);
    let referrer = if resource_name.is_string() {
        resource_name.to_rust_string_lossy(scope)
    } else {
        String::new()
    };
    let base = if url::Url::parse(&referrer)
        .is_ok_and(|u| !u.cannot_be_a_base() && u.scheme() != "internal")
    {
        base_for(st, &referrer)
    } else {
        let doc_url = st.url.borrow().clone();
        match st.doc() {
            Ok(doc) => crate::dom::base_url(doc, &doc_url).to_string(),
            Err(_) => doc_url.to_string(),
        }
    };
    match resolve_module(st, &base, &spec) {
        Ok(url) => load(scope, st, &url, None, true),
        Err(msg) => {
            let resolver = v8::PromiseResolver::new(scope)?;
            let e = type_error(scope, &msg);
            resolver.reject(scope, e);
            Some(resolver.get_promise(scope))
        }
    }
}

/// `import.meta`: `url` and `resolve()`.
pub(crate) extern "C" fn import_meta_callback(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    v8::callback_scope!(unsafe scope, context);
    let Some(st) = state_of(scope) else { return };
    let url = url_of_module(st, scope, module)
        .map(|u| base_for(st, &u))
        .unwrap_or_default();
    let url_v = v8_str(scope, &url);
    let key = cx::v8_key(scope, "url");
    meta.create_data_property(scope, key.into(), url_v.into());
    let resolve = v8::Function::builder(
        |scope: &mut v8::PinScope,
         args: v8::FunctionCallbackArguments,
         mut rv: v8::ReturnValue<v8::Value>| {
            let base = args.data().to_rust_string_lossy(scope);
            let spec = args.get(0).to_rust_string_lossy(scope);
            let resolved = match state_of(scope) {
                Some(st) => resolve_module(st, &base, &spec),
                None => resolve_specifier(&base, &spec),
            };
            match resolved {
                Ok(u) => {
                    let s = v8_str(scope, &u);
                    rv.set(s.into());
                }
                Err(msg) => {
                    let e = type_error(scope, &msg);
                    scope.throw_exception(e);
                }
            }
        },
    )
    .data(url_v.into())
    .build(scope);
    if let Some(f) = resolve {
        let key = cx::v8_key(scope, "resolve");
        meta.create_data_property(scope, key.into(), f.into());
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_specifier;

    #[test]
    fn specifiers() {
        assert_eq!(
            resolve_specifier("https://a.com/x/y.js", "./z.js").unwrap(),
            "https://a.com/x/z.js"
        );
        assert_eq!(
            resolve_specifier("https://a.com/x/y.js", "../z.js").unwrap(),
            "https://a.com/z.js"
        );
        assert_eq!(
            resolve_specifier("https://a.com/x/y.js", "/z.js").unwrap(),
            "https://a.com/z.js"
        );
        assert_eq!(
            resolve_specifier("https://a.com/x/y.js", "https://b.com/m.js").unwrap(),
            "https://b.com/m.js"
        );
        assert!(resolve_specifier("https://a.com/x/y.js", "lodash").is_err());
    }

    #[test]
    fn import_maps() {
        let base = url::Url::parse("https://a.com/app/index.html").unwrap();
        let map = super::ImportMap::parse(
            r#"{"imports": {"react": "/vendor/react.js", "lib/": "./lib/", "https://cdn.com/x.js": "/local/x.js", "blocked": null},
                "scopes": {"/app/legacy/": {"react": "/vendor/react-16.js"}}}"#,
            &base,
        )
        .unwrap();
        let r = |b: &str, s: &str| map.resolve(b, s);
        let page = "https://a.com/app/index.html";
        assert_eq!(
            r(page, "react"),
            Some(Ok("https://a.com/vendor/react.js".into()))
        );
        assert_eq!(
            r(page, "lib/util/a.js"),
            Some(Ok("https://a.com/app/lib/util/a.js".into()))
        );
        assert_eq!(
            r(page, "https://cdn.com/x.js"),
            Some(Ok("https://a.com/local/x.js".into()))
        );
        assert_eq!(
            r("https://a.com/app/legacy/m.js", "react"),
            Some(Ok("https://a.com/vendor/react-16.js".into()))
        );
        assert!(matches!(r(page, "blocked"), Some(Err(_))));
        assert!(matches!(r(page, "lib/../../x.js"), Some(Err(_))));
        assert_eq!(r(page, "./other.js"), None);
        assert!(super::ImportMap::parse("[1]", &base).is_err());
    }
}
