//! Script, network, storage, timer, location and utility natives.

use std::time::Instant;

use common::protocol::{CacheMode, Destination, NetRequest};

use crate::activation;
use crate::cx::{Cx, JsErr, NResult, array_buffer_from_vec, bytes_of, get_prop, v8_str};
use crate::dom;
use crate::runtime::{report_exception_ex, run_classic};
use crate::state::{Hook, Hooks, RuntimeState};
use crate::storage::StorageError;

/// JS-like number formatting (integers without a fraction).
pub(crate) fn format_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

// ---------------------------------------------------------------------------------
// Scripts & modules
// ---------------------------------------------------------------------------------

/// `N.evalScript(source, url, isInline)`: classic script in the global scope.
/// Exceptions are reported (console + error event) and re-thrown.
pub(crate) fn n_eval_script(cx: &mut Cx) -> NResult {
    let source = cx.string(0)?;
    let url = cx.opt_string(1)?.unwrap_or_else(|| cx.st.url_string());
    match run_classic(cx.scope, &source, &url) {
        Ok(v) => {
            cx.ret_value(v);
            Ok(())
        }
        Err(e) => match e.exception {
            Some(exc) => {
                // Console only: the JS layer catches the rethrown exception and
                // dispatches the window `ErrorEvent` itself.
                report_exception_ex(cx.scope, cx.st, exc, e.message, false);
                cx.scope.throw_exception(exc);
                Err(JsErr::Thrown)
            }
            None => Err(JsErr::Thrown),
        },
    }
}

/// `N.runModule(url, sourceOrNull)` -> Promise.
pub(crate) fn n_run_module(cx: &mut Cx) -> NResult {
    let url = cx.string(0)?;
    let source = cx.opt_string(1)?;
    let url = resolve_url(cx, &url)?;
    match crate::modules::load(cx.scope, cx.st, &url, source.as_deref(), false) {
        Some(p) => {
            cx.ret_value(p.into());
            Ok(())
        }
        None => Err(JsErr::Thrown),
    }
}

/// `N.compileFunction(body, argNames[], url, scopeObjects?)`. The optional
/// `scopeObjects` array becomes the function's scope chain (e.g. `[document, form,
/// element]` for inline event handlers), innermost last.
pub(crate) fn n_compile_function(cx: &mut Cx) -> NResult {
    let body = cx.string(0)?;
    let url = cx.opt_string(2)?.unwrap_or_default();
    let args_v = cx.arg(1);
    let mut arg_names: Vec<v8::Local<v8::String>> = Vec::new();
    if args_v.is_array() {
        let arr: v8::Local<v8::Array> = args_v.try_into().unwrap();
        for i in 0..arr.length() {
            let Some(v) = arr.get_index(cx.scope, i) else {
                return Err(JsErr::Thrown);
            };
            let Some(s) = v.to_string(cx.scope) else {
                return Err(JsErr::Thrown);
            };
            arg_names.push(s);
        }
    }
    let mut extensions: Vec<v8::Local<v8::Object>> = Vec::new();
    let ext_v = cx.arg(3);
    if ext_v.is_array() {
        let arr: v8::Local<v8::Array> = ext_v.try_into().unwrap();
        for i in 0..arr.length() {
            if let Some(v) = arr.get_index(cx.scope, i)
                && let Ok(o) = v8::Local::<v8::Object>::try_from(v)
            {
                extensions.push(o);
            }
        }
    }
    let src = v8_str(cx.scope, &body);
    let name = v8_str(cx.scope, &url);
    let origin = v8::ScriptOrigin::new(
        cx.scope,
        name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        false,
        None,
    );
    let mut source = v8::script_compiler::Source::new(src, Some(&origin));
    let f = v8::script_compiler::compile_function(
        cx.scope,
        &mut source,
        &arg_names,
        &extensions,
        v8::script_compiler::CompileOptions::NoCompileOptions,
        v8::script_compiler::NoCacheReason::NoReason,
    );
    match f {
        Some(f) => {
            cx.ret_value(f.into());
            Ok(())
        }
        None => Err(JsErr::Thrown),
    }
}

// ---------------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------------

/// Resolve `input` against the document base URL.
fn resolve_url(cx: &Cx, input: &str) -> Result<String, JsErr> {
    let doc_url = cx.st.url.borrow().clone();
    let base = match cx.st.doc() {
        Ok(doc) => dom::base_url(doc, &doc_url),
        Err(_) => doc_url,
    };
    base.join(input)
        .map(|u| u.to_string())
        .map_err(|_| JsErr::type_err(format!("Failed to parse URL from {input}")))
}

/// `[name, value, name, value, ...]` argument -> header pairs.
fn header_pairs(cx: &mut Cx, i: i32) -> Result<Vec<(String, String)>, JsErr> {
    let mut headers = Vec::new();
    let hv = cx.arg(i);
    if hv.is_array() {
        let arr: v8::Local<v8::Array> = hv.try_into().unwrap();
        let n = arr.length();
        let mut i = 0;
        while i + 1 < n {
            let k = arr.get_index(cx.scope, i).ok_or(JsErr::Thrown)?;
            let v = arr.get_index(cx.scope, i + 1).ok_or(JsErr::Thrown)?;
            let k = crate::cx::value_to_string(cx.scope, k).ok_or(JsErr::Thrown)?;
            let v = crate::cx::value_to_string(cx.scope, v).ok_or(JsErr::Thrown)?;
            headers.push((k, v));
            i += 2;
        }
    }
    Ok(headers)
}

fn socket_id(cx: &Cx) -> Result<u64, JsErr> {
    let id = cx.num(0);
    if !(1.0..9_007_199_254_740_992.0).contains(&id) {
        return Err(JsErr::type_err("invalid socket id"));
    }
    Ok(id as u64)
}

/// Addition: `N.wsOpen(id, url, protocols, origin)` -> whether the host opened the
/// socket. Its events come back through `hooks.onWebSocket(id, kind, ...)`.
pub(crate) fn n_ws_open(cx: &mut Cx) -> NResult {
    let id = socket_id(cx)?;
    let url = cx.string(1)?;
    let mut protocols = Vec::new();
    let list = cx.arg(2);
    if list.is_array() {
        let arr: v8::Local<v8::Array> = list.try_into().unwrap();
        for i in 0..arr.length() {
            let v = arr.get_index(cx.scope, i).ok_or(JsErr::Thrown)?;
            protocols.push(crate::cx::value_to_string(cx.scope, v).ok_or(JsErr::Thrown)?);
        }
    }
    let origin = cx.string(3)?;
    let ok = cx.st.host.ws_open(id, &url, protocols, &origin);
    cx.ret_bool(ok);
    Ok(())
}

/// Addition: `N.wsSend(id, stringOrArrayBuffer)`.
pub(crate) fn n_ws_send(cx: &mut Cx) -> NResult {
    let id = socket_id(cx)?;
    let v = cx.arg(1);
    let data = if v.is_string() {
        common::protocol::WsData::Text(cx.string(1)?)
    } else {
        common::protocol::WsData::Binary(bytes_of(cx.scope, v).unwrap_or_default())
    };
    cx.st.host.ws_send(id, data);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.wsClose(id, code (-1: none), reason)`.
pub(crate) fn n_ws_close(cx: &mut Cx) -> NResult {
    let id = socket_id(cx)?;
    let code = cx.num(1);
    let code = (0.0..=65535.0).contains(&code).then_some(code as u16);
    let reason = cx.string(2)?;
    cx.st.host.ws_close(id, code, &reason);
    cx.ret_undefined();
    Ok(())
}

/// Should a request with RequestCredentials `mode` to `url` carry cookies?
fn send_credentials(cx: &Cx, mode: &str, url: &str) -> bool {
    match mode {
        "omit" => false,
        "include" => true,
        _ => url::Url::parse(url).is_ok_and(|u| u.origin() == cx.st.url.borrow().origin()),
    }
}

/// `N.fetch(reqId, method, url, headersFlat, body, mode, credentials?, cache?, redirect?)`.
pub(crate) fn n_fetch(cx: &mut Cx) -> NResult {
    let id = cx.num(0);
    if !(0.0..9_007_199_254_740_992.0).contains(&id) {
        return Err(JsErr::type_err("invalid request id"));
    }
    let id = id as u64;
    let method = cx.string(1)?.to_ascii_uppercase();
    let url_in = cx.string(2)?;
    let url = resolve_url(cx, &url_in)?;
    let headers = header_pairs(cx, 3)?;
    let bv = cx.arg(4);
    let body = if bv.is_null_or_undefined() {
        None
    } else {
        bytes_of(cx.scope, bv)
    };
    let mode = cx.opt_string(5)?.unwrap_or_default();
    let credentials = cx.opt_string(6)?.unwrap_or_else(|| "same-origin".into());
    let cache = cx.opt_string(7)?.unwrap_or_default();
    let redirect = cx.opt_string(8)?.unwrap_or_default();
    let destination = match mode.as_str() {
        "navigate" => Destination::Document,
        _ => Destination::Fetch,
    };
    let cache_mode = match cache.as_str() {
        "no-store" => CacheMode::NoStore,
        "reload" => CacheMode::Reload,
        "no-cache" => CacheMode::NoCache,
        "force-cache" => CacheMode::ForceCache,
        "only-if-cached" => CacheMode::OnlyIfCached,
        _ => CacheMode::Default,
    };
    let credentials = send_credentials(cx, &credentials, &url);
    let req = NetRequest {
        id,
        url,
        method,
        headers,
        body,
        destination,
        referrer: Some(cx.st.url_string()),
        credentials,
        // "manual" and "error": the layer sees the 3xx response.
        follow_redirects: redirect.is_empty() || redirect == "follow",
        cache_mode,
    };
    cx.st.pending_fetches.borrow_mut().insert(id);
    cx.st.host.fetch(req);
    cx.ret_undefined();
    Ok(())
}

/// Ids of synchronous requests (never delivered through `deliver_fetch`).
const SYNC_FETCH_BIT: u64 = 1 << 62;

/// Addition: `N.fetchSync(method, url, headersFlat, bodyOrNull, credentials?)` ->
/// `[status, statusText, finalUrl, headersFlat, bodyArrayBuffer, errorOrNull]`
/// (synchronous XMLHttpRequest, via [`crate::ScriptHost::fetch_sync`]).
pub(crate) fn n_fetch_sync(cx: &mut Cx) -> NResult {
    let method = cx.string(0)?.to_ascii_uppercase();
    let url_in = cx.string(1)?;
    let url = resolve_url(cx, &url_in)?;
    let headers = header_pairs(cx, 2)?;
    let bv = cx.arg(3);
    let body = if bv.is_null_or_undefined() {
        None
    } else {
        bytes_of(cx.scope, bv)
    };
    let credentials = cx.opt_string(4)?.unwrap_or_else(|| "same-origin".into());
    let seq = cx.st.sync_fetch_seq.get() + 1;
    cx.st.sync_fetch_seq.set(seq);
    let credentials = send_credentials(cx, &credentials, &url);
    let req = NetRequest {
        id: SYNC_FETCH_BIT | seq,
        url: url.clone(),
        method,
        headers,
        body,
        destination: Destination::Fetch,
        referrer: Some(cx.st.url_string()),
        credentials,
        follow_redirects: true,
        cache_mode: CacheMode::Default,
    };
    let resp = cx.st.host.fetch_sync(req);
    let scope = &mut *cx.scope;
    let out: [v8::Local<v8::Value>; 6] = match resp {
        Some(r) => {
            let mut flat: Vec<v8::Local<v8::Value>> = Vec::with_capacity(r.headers.len() * 2);
            for (k, v) in &r.headers {
                flat.push(v8_str(scope, k).into());
                flat.push(v8_str(scope, v).into());
            }
            let error: v8::Local<v8::Value> = match &r.error {
                Some(e) => v8_str(scope, e).into(),
                None => v8::null(scope).into(),
            };
            [
                v8::Integer::new(scope, r.status as i32).into(),
                v8_str(scope, &r.status_text).into(),
                v8_str(scope, &r.url).into(),
                v8::Array::new_with_elements(scope, &flat).into(),
                array_buffer_from_vec(scope, r.body).into(),
                error,
            ]
        }
        None => [
            v8::Integer::new(scope, 0).into(),
            v8::String::empty(scope).into(),
            v8_str(scope, &url).into(),
            v8::Array::new(scope, 0).into(),
            v8::null(scope).into(),
            v8_str(scope, "synchronous requests are not supported").into(),
        ],
    };
    let arr = v8::Array::new_with_elements(scope, &out);
    cx.ret_value(arr.into());
    Ok(())
}

/// Addition: `N.registerBlobURL(url, bytes, type)` (from `URL.createObjectURL`).
pub(crate) fn n_register_blob_url(cx: &mut Cx) -> NResult {
    let url = cx.string(0)?;
    let content_type = cx.opt_string(2)?.unwrap_or_default();
    let bytes = bytes_of(cx.scope, cx.arg(1)).unwrap_or_default();
    crate::blob::register(
        url.clone(),
        crate::blob::BlobData {
            bytes: bytes.into(),
            content_type,
        },
    );
    cx.st.blob_urls.borrow_mut().push(url);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.revokeBlobURL(url)`.
pub(crate) fn n_revoke_blob_url(cx: &mut Cx) -> NResult {
    let url = cx.string(0)?;
    crate::blob::revoke(&url);
    cx.st.blob_urls.borrow_mut().retain(|u| *u != url);
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_abort_fetch(cx: &mut Cx) -> NResult {
    let id = cx.num(0);
    if id >= 0.0 {
        let id = id as u64;
        if cx.st.pending_fetches.borrow_mut().remove(&id) {
            cx.st.host.abort_fetch(id);
        }
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_get_cookie(cx: &mut Cx) -> NResult {
    let url = cx.st.url_string();
    let c = cx.st.host.get_cookies(&url);
    cx.ret_str(&c);
    Ok(())
}

pub(crate) fn n_set_cookie(cx: &mut Cx) -> NResult {
    let c = cx.string(0)?;
    let url = cx.st.url_string();
    cx.st.host.set_cookie(&url, &c);
    cx.ret_undefined();
    Ok(())
}

// ---------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------

fn storage_err(e: StorageError) -> JsErr {
    match e {
        StorageError::Quota => {
            JsErr::dom("QuotaExceededError", "the storage quota has been exceeded")
        }
        StorageError::Security(m) => JsErr::dom("SecurityError", m),
    }
}

fn kind_arg(cx: &Cx) -> u32 {
    if cx.num(0) == 1.0 { 1 } else { 0 }
}

pub(crate) fn n_storage_get(cx: &mut Cx) -> NResult {
    let kind = kind_arg(cx);
    let key = cx.string(1)?;
    let v = cx
        .st
        .storage
        .borrow_mut()
        .get(kind, &key)
        .map_err(storage_err)?;
    cx.ret_opt_str(v.as_deref());
    Ok(())
}

pub(crate) fn n_storage_set(cx: &mut Cx) -> NResult {
    let kind = kind_arg(cx);
    let key = cx.string(1)?;
    let value = cx.string(2)?;
    cx.st
        .storage
        .borrow_mut()
        .set(kind, &key, &value)
        .map_err(storage_err)?;
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_storage_remove(cx: &mut Cx) -> NResult {
    let kind = kind_arg(cx);
    let key = cx.string(1)?;
    cx.st
        .storage
        .borrow_mut()
        .remove(kind, &key)
        .map_err(storage_err)?;
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_storage_clear(cx: &mut Cx) -> NResult {
    let kind = kind_arg(cx);
    cx.st
        .storage
        .borrow_mut()
        .clear(kind)
        .map_err(storage_err)?;
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_storage_keys(cx: &mut Cx) -> NResult {
    let kind = kind_arg(cx);
    let keys = cx.st.storage.borrow_mut().keys(kind).map_err(storage_err)?;
    cx.ret_strs(&keys);
    Ok(())
}

// ---------------------------------------------------------------------------------
// Timers / frames
// ---------------------------------------------------------------------------------

pub(crate) fn n_set_timer(cx: &mut Cx) -> NResult {
    let id = cx.num(0);
    let delay = cx.num(1);
    cx.st.timers.borrow_mut().set(id, delay, Instant::now());
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_clear_timer(cx: &mut Cx) -> NResult {
    let id = cx.num(0);
    cx.st.timers.borrow_mut().clear(id);
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_request_frame(cx: &mut Cx) -> NResult {
    if !cx.st.frame_requested.replace(true) {
        cx.st.host.request_redraw();
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_now(cx: &mut Cx) -> NResult {
    let ms = cx.st.nav_start.elapsed().as_secs_f64() * 1000.0;
    // 5 microsecond resolution (like cross-origin-isolated browsers: 100us; keep fine).
    let ms = (ms * 200.0).floor() / 200.0;
    cx.rv.set_double(ms);
    Ok(())
}

pub(crate) fn n_time_origin(cx: &mut Cx) -> NResult {
    cx.rv.set_double(cx.st.time_origin);
    Ok(())
}

// ---------------------------------------------------------------------------------
// Location / history
// ---------------------------------------------------------------------------------

pub(crate) fn n_location(cx: &mut Cx) -> NResult {
    let u = cx.st.url_string();
    cx.ret_str(&u);
    Ok(())
}

/// `N.navigate(url, replace)`. Returns true if the navigation was handled within the
/// document (fragment navigation or `javascript:` URL).
pub(crate) fn n_navigate(cx: &mut Cx) -> NResult {
    let input = cx.string(0)?;
    let replace = cx.bool(1);
    let url = resolve_url(cx, &input)?;
    let url = url::Url::parse(&url).map_err(|_| JsErr::type_err("invalid URL"))?;
    let handled = activation::navigate_to(cx.scope, cx.st, url, replace, false);
    cx.ret_bool(handled);
    Ok(())
}

pub(crate) fn n_reload(cx: &mut Cx) -> NResult {
    let url = cx.st.url_string();
    cx.st.host.navigate(&url, true, "GET", None, None);
    cx.ret_undefined();
    Ok(())
}

/// `N.historyPush(url, replace)`: same-document URL change (pushState/replaceState).
pub(crate) fn n_history_push(cx: &mut Cx) -> NResult {
    let input = cx.string(0)?;
    let url = resolve_url(cx, &input)?;
    let url = url::Url::parse(&url).map_err(|_| JsErr::type_err("invalid URL"))?;
    {
        let cur = cx.st.url.borrow();
        let same_origin = cur.origin() == url.origin()
            || (cur.scheme() == "file" && url.scheme() == "file")
            || (cur.scheme() == url.scheme() && !cur.origin().is_tuple());
        if !same_origin {
            return Err(JsErr::dom(
                "SecurityError",
                format!(
                    "a history state object with URL '{url}' cannot be created in a document with origin '{}'",
                    cur.origin().ascii_serialization()
                ),
            ));
        }
    }
    let replace = cx.bool(1);
    cx.st.same_document_navigation(&url, replace);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.historyIndex()` -> index of the current session history entry.
pub(crate) fn n_history_index(cx: &mut Cx) -> NResult {
    let (index, _) = cx.st.history_position();
    cx.ret_f64(index as f64);
    Ok(())
}

/// Addition: `N.historyLength()` -> number of session history entries (`history.length`).
pub(crate) fn n_history_length(cx: &mut Cx) -> NResult {
    let (_, length) = cx.st.history_position();
    cx.ret_f64(length.max(1) as f64);
    Ok(())
}

/// Addition: `N.doctype()` -> `[name, publicId, systemId]` of the main document's
/// `<!DOCTYPE>`, or `null` if it had none (see `ScriptRuntime::set_doctype`; default
/// `<!DOCTYPE html>`).
pub(crate) fn n_doctype(cx: &mut Cx) -> NResult {
    let dt = cx.st.doctype.borrow().clone();
    match dt {
        Some((name, public_id, system_id)) => cx.ret_strs(&[name, public_id, system_id]),
        None => cx.ret_null(),
    }
    Ok(())
}

/// Addition: `N.referrer()` -> `document.referrer`.
pub(crate) fn n_referrer(cx: &mut Cx) -> NResult {
    let r = cx.st.host.referrer();
    cx.ret_str(&r);
    Ok(())
}

/// Addition: `N.openWindow(url, target, features)` (`window.open` with a new browsing
/// context): opens a tab.
pub(crate) fn n_open_window(cx: &mut Cx) -> NResult {
    let input = cx.string(0)?;
    let url = if input.is_empty() {
        "about:blank".to_string()
    } else {
        resolve_url(cx, &input)?
    };
    cx.st.host.open_new_tab(&url);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.clipboardWrite(text)`.
pub(crate) fn n_clipboard_write(cx: &mut Cx) -> NResult {
    let text = cx.string(0)?;
    cx.st.host.clipboard_write(&text);
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_history_go(cx: &mut Cx) -> NResult {
    let d = cx.num(0);
    let d = if d.is_finite() { d as i32 } else { 0 };
    cx.st.host.history_go(d);
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_set_title(cx: &mut Cx) -> NResult {
    let t = cx.string(0)?;
    cx.st.host.title_changed(&t);
    cx.ret_undefined();
    Ok(())
}

// ---------------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------------

pub(crate) fn n_log(cx: &mut Cx) -> NResult {
    let level = cx.string(0)?;
    let msg = cx.string(1)?;
    let level = match level.as_str() {
        "log" | "info" | "warn" | "error" | "debug" => level,
        "warning" => "warn".to_string(),
        _ => "log".to_string(),
    };
    cx.st.host.console(&level, &msg);
    cx.ret_undefined();
    Ok(())
}

fn url_components(u: &url::Url) -> [String; 11] {
    use url::quirks;
    [
        quirks::href(u).to_string(),
        quirks::protocol(u).to_string(),
        quirks::username(u).to_string(),
        quirks::password(u).to_string(),
        quirks::host(u).to_string(),
        quirks::hostname(u).to_string(),
        quirks::port(u).to_string(),
        quirks::pathname(u).to_string(),
        quirks::search(u).to_string(),
        quirks::hash(u).to_string(),
        quirks::origin(u),
    ]
}

/// `N.urlParse(input, baseOrNull)` -> components array or null.
pub(crate) fn n_url_parse(cx: &mut Cx) -> NResult {
    let input = cx.string(0)?;
    let base = cx.opt_string(1)?;
    let parsed = match base {
        Some(b) => match url::Url::parse(&b) {
            Ok(base) => url::Url::options().base_url(Some(&base)).parse(&input).ok(),
            Err(_) => None,
        },
        None => url::Url::parse(&input).ok(),
    };
    match parsed {
        Some(u) => cx.ret_strs(&url_components(&u)),
        None => cx.ret_null(),
    }
    Ok(())
}

/// Addition: `N.urlSet(href, field, value)` -> components after applying a URL setter
/// (`href`, `protocol`, `username`, `password`, `host`, `hostname`, `port`,
/// `pathname`, `search`, `hash`), or null if `href` is invalid. Invalid values leave
/// the URL unchanged (WHATWG setter semantics), except `href` which throws.
pub(crate) fn n_url_set(cx: &mut Cx) -> NResult {
    use url::quirks;
    let href = cx.string(0)?;
    let field = cx.string(1)?;
    let value = cx.string(2)?;
    let Ok(mut u) = url::Url::parse(&href) else {
        cx.ret_null();
        return Ok(());
    };
    match field.as_str() {
        "href" => {
            if quirks::set_href(&mut u, &value).is_err() {
                return Err(JsErr::type_err(format!("Invalid URL: {value}")));
            }
        }
        "protocol" => {
            let _ = quirks::set_protocol(&mut u, &value);
        }
        "username" => {
            let _ = quirks::set_username(&mut u, &value);
        }
        "password" => {
            let _ = quirks::set_password(&mut u, &value);
        }
        "host" => {
            let _ = quirks::set_host(&mut u, &value);
        }
        "hostname" => {
            let _ = quirks::set_hostname(&mut u, &value);
        }
        "port" => {
            let _ = quirks::set_port(&mut u, &value);
        }
        "pathname" => quirks::set_pathname(&mut u, &value),
        "search" => quirks::set_search(&mut u, &value),
        "hash" => quirks::set_hash(&mut u, &value),
        _ => return Err(JsErr::type_err(format!("unknown URL field {field}"))),
    }
    cx.ret_strs(&url_components(&u));
    Ok(())
}

pub(crate) fn n_random_bytes(cx: &mut Cx) -> NResult {
    let n = cx.num(0);
    if !(0.0..=65536.0).contains(&n) {
        return Err(JsErr::dom(
            "QuotaExceededError",
            "at most 65536 random bytes can be requested",
        ));
    }
    let mut buf = vec![0u8; n as usize];
    getrandom::fill(&mut buf)
        .map_err(|e| JsErr::dom("OperationError", format!("randomness unavailable: {e}")))?;
    let ab = array_buffer_from_vec(cx.scope, buf);
    cx.ret_value(ab.into());
    Ok(())
}

pub(crate) fn n_text_encode(cx: &mut Cx) -> NResult {
    let s = cx.string(0)?;
    let ab = array_buffer_from_vec(cx.scope, s.into_bytes());
    cx.ret_value(ab.into());
    Ok(())
}

/// Decode bytes with an encoding label (WHATWG Encoding via encoding_rs; UTF-8 fast
/// path). A leading BOM of the selected encoding is removed.
pub(crate) fn decode_text(bytes: &[u8], label: &str, fatal: bool) -> Result<String, JsErr> {
    let trimmed = label.trim_matches(|c: char| c.is_ascii_whitespace());
    let enc = if trimmed.is_empty() {
        encoding_rs::UTF_8
    } else {
        match encoding_rs::Encoding::for_label(trimmed.as_bytes()) {
            Some(e) if e != encoding_rs::REPLACEMENT => e,
            _ => {
                return Err(JsErr::range(format!(
                    "The encoding label provided ('{label}') is invalid."
                )));
            }
        }
    };
    if enc == encoding_rs::UTF_8 {
        let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
        return match std::str::from_utf8(b) {
            Ok(s) => Ok(s.to_string()),
            Err(_) if fatal => Err(JsErr::type_err(
                "The encoded data was not valid for encoding utf-8",
            )),
            Err(_) => Ok(String::from_utf8_lossy(b).into_owned()),
        };
    }
    if fatal {
        let (_, bom_len) = encoding_rs::Encoding::for_bom(bytes)
            .filter(|(e, _)| *e == enc)
            .unwrap_or((enc, 0));
        match enc.decode_without_bom_handling_and_without_replacement(&bytes[bom_len..]) {
            Some(s) => Ok(s.into_owned()),
            None => Err(JsErr::type_err(format!(
                "The encoded data was not valid for encoding {}",
                enc.name().to_ascii_lowercase()
            ))),
        }
    } else {
        Ok(enc.decode_with_bom_removal(bytes).0.into_owned())
    }
}

pub(crate) fn n_text_decode(cx: &mut Cx) -> NResult {
    let v = cx.arg(0);
    let bytes = if v.is_null_or_undefined() {
        Vec::new()
    } else if v.is_array_buffer() || v.is_array_buffer_view() || v.is_shared_array_buffer() {
        bytes_of(cx.scope, v).unwrap_or_default()
    } else {
        return Err(JsErr::type_err(
            "the provided value is not an ArrayBuffer or ArrayBufferView",
        ));
    };
    let label = cx.opt_string(1)?.unwrap_or_else(|| "utf-8".into());
    let fatal = cx.bool(2);
    let s = decode_text(&bytes, &label, fatal)?;
    cx.ret_str(&s);
    Ok(())
}

pub(crate) fn n_user_agent(cx: &mut Cx) -> NResult {
    let ua = cx.st.user_agent.clone();
    cx.ret_str(&ua);
    Ok(())
}

struct CloneDelegate;

impl v8::ValueSerializerImpl for CloneDelegate {
    fn throw_data_clone_error<'s>(
        &self,
        scope: &mut v8::PinScope<'s, '_>,
        message: v8::Local<'s, v8::String>,
    ) {
        let m = message.to_rust_string_lossy(scope);
        let s = v8_str(scope, &format!("DataCloneError: {m}"));
        let e = v8::Exception::error(scope, s);
        scope.throw_exception(e);
    }
}

impl v8::ValueDeserializerImpl for CloneDelegate {}

/// `N.structuredClone(value)` via V8's ValueSerializer/ValueDeserializer.
pub(crate) fn n_structured_clone(cx: &mut Cx) -> NResult {
    use v8::{ValueDeserializerHelper, ValueSerializerHelper};
    let value = cx.arg(0);
    let context = cx.scope.get_current_context();
    let bytes = {
        let ser = v8::ValueSerializer::new(cx.scope, Box::new(CloneDelegate));
        ser.write_header();
        if ser.write_value(context, value) != Some(true) {
            return Err(JsErr::Thrown);
        }
        ser.release()
    };
    let de = v8::ValueDeserializer::new(cx.scope, Box::new(CloneDelegate), &bytes);
    if de.read_header(context) != Some(true) {
        return Err(JsErr::dom("DataCloneError", "failed to deserialize"));
    }
    match de.read_value(context) {
        Some(v) => {
            cx.ret_value(v);
            Ok(())
        }
        None => Err(JsErr::Thrown),
    }
}

pub(crate) fn n_pending_resource_count(cx: &mut Cx) -> NResult {
    let mut n = cx.st.host.pending_resource_count();
    if let Ok(doc) = cx.st.doc()
        && doc.has_pending_critical_resources()
        && n == 0
    {
        n = 1;
    }
    cx.ret_f64(n as f64);
    Ok(())
}

/// `N.setHooks(obj)`: register the JS layer's hook functions.
pub(crate) fn n_set_hooks(cx: &mut Cx) -> NResult {
    let v = cx.arg(0);
    let Ok(obj) = v8::Local::<v8::Object>::try_from(v) else {
        return Err(JsErr::type_err("setHooks expects an object"));
    };
    register_hooks(cx.scope, cx.st, obj)?;
    cx.ret_undefined();
    Ok(())
}

/// Register the JS layer's hooks object (from `N.setHooks`, or restored from the
/// startup snapshot).
pub(crate) fn register_hooks<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    obj: v8::Local<'s, v8::Object>,
) -> NResult {
    let mut hooks = Hooks::default();
    for hook in Hook::ALL {
        let Some(f) = get_prop(scope, obj, hook.name()) else {
            return Err(JsErr::Thrown);
        };
        if let Ok(f) = v8::Local::<v8::Function>::try_from(f) {
            hooks.funcs[hook as usize] = Some(v8::Global::new(scope, f));
        }
    }
    hooks.obj = Some(v8::Global::new(scope, obj));
    *st.hooks.borrow_mut() = hooks;
    st.js_layer.set(true);
    Ok(())
}
