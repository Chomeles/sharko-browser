//! `ScriptRuntime`: isolate + context ownership, entries into JS, hooks, error
//! reporting, microtask policy and the public renderer-facing API.

use std::borrow::Cow;
use std::mem::ManuallyDrop;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use blitz_dom::{BaseDocument, NodeId};
use blitz_traits::events::{DomEvent, EventState};
use common::protocol::NetResponse;

use crate::ScriptHost;
use crate::cx::{self, array_buffer_from_vec, get_prop, set_prop, v8_str};
use crate::state::{Hook, InternalTask, RuntimeState, StatePtr};
use crate::watchdog::Watchdog;

include!(concat!(env!("OUT_DIR"), "/js_layer.rs"));

/// A single entry into JS running longer than this is terminated.
pub(crate) const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10);

/// High bit marks fetch ids owned by the ES module loader.
pub(crate) const MODULE_FETCH_BIT: u64 = 1 << 63;

/// Rejections remembered for `rejectionhandled`.
const MAX_REPORTED_REJECTIONS: usize = 128;

/// Options for [`ScriptRuntime::new`].
#[derive(Clone, Debug)]
pub struct RuntimeOptions {
    /// URL of the document this runtime serves (`location.href`).
    pub document_url: String,
    /// `navigator.userAgent`.
    pub user_agent: String,
    /// Per-profile data directory (`localStorage` lives in `<profile_dir>/localstorage`).
    /// An empty path disables persistence.
    pub profile_dir: PathBuf,
    /// Execute the JS DOM layer (`js/*.js`). `false` only for tests of the natives.
    pub load_js_layer: bool,
}

/// Startup measurements.
#[derive(Clone, Debug, Default)]
pub struct StartupStats {
    /// Isolate + context creation (and deserialization, with a snapshot) and native
    /// installation.
    pub context_setup: Duration,
    /// Executing the JS layer files, or obtaining the startup snapshot (loading it, or
    /// building it on first use in the process).
    pub js_layer: Duration,
    /// The context came from the JS layer startup snapshot.
    pub from_snapshot: bool,
    /// Number of JS layer files executed.
    pub js_layer_files: usize,
    /// Per-file execution time of the JS layer.
    pub js_layer_per_file: Vec<(&'static str, Duration)>,
}

/// A V8 isolate + context running one document's scripts. `!Send`: keep it on the
/// renderer's main thread.
pub struct ScriptRuntime {
    // Dropped manually (before `state`) in `Drop`.
    isolate: ManuallyDrop<v8::OwnedIsolate>,
    context: ManuallyDrop<v8::Global<v8::Context>>,
    state: Rc<RuntimeState>,
    watchdog: Watchdog,
    timeout: Duration,
    stats: StartupStats,
}

impl ScriptRuntime {
    /// Create the isolate and context, install `__native` and (optionally) run the JS
    /// layer — or deserialize a context in which it already ran (see `snapshot.rs`).
    /// Initializes V8 on first use in the process.
    pub fn new(host: Rc<dyn ScriptHost>, opts: RuntimeOptions) -> Self {
        crate::platform::init_v8();
        let t0 = Instant::now();
        // Decided once per process, before its first isolate exists (see `snapshot.rs`).
        let snapshot = crate::snapshot::process_blob(&opts.profile_dir, &*host);
        Self::new_inner(host, opts, snapshot, JS_LAYER_FILES, t0)
    }

    /// [`ScriptRuntime::new`] with an explicit snapshot blob (all isolates alive at the
    /// same time must come from the same blob) and layer sources.
    pub(crate) fn new_inner(
        host: Rc<dyn ScriptHost>,
        opts: RuntimeOptions,
        snapshot: Option<&'static [u8]>,
        layer: &'static [(&'static str, &'static str)],
        t0: Instant,
    ) -> Self {
        crate::platform::init_v8();
        let t_snapshot = t0.elapsed();
        let url = url::Url::parse(&opts.document_url)
            .unwrap_or_else(|_| url::Url::parse("about:blank").unwrap());
        let state = Rc::new(RuntimeState::new(
            host,
            url,
            opts.user_agent.clone(),
            opts.profile_dir.clone(),
        ));

        let mut isolate = match snapshot {
            Some(blob) => v8::Isolate::new(
                v8::CreateParams::default()
                    .snapshot_blob(v8::StartupData::from(blob))
                    .external_references(Cow::Borrowed(crate::snapshot::external_references())),
            ),
            None => v8::Isolate::new(v8::CreateParams::default()),
        };
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        isolate.set_capture_stack_trace_for_uncaught_exceptions(true, 32);
        isolate.set_promise_reject_callback(promise_reject_callback);
        isolate.add_message_listener(message_listener);
        isolate
            .set_host_import_module_dynamically_callback(crate::modules::dynamic_import_callback);
        isolate
            .set_host_initialize_import_meta_object_callback(crate::modules::import_meta_callback);
        isolate.set_slot(StatePtr(Rc::as_ptr(&state)));
        isolate.set_data(
            crate::snapshot::STATE_SLOT,
            Rc::as_ptr(&state) as *mut std::ffi::c_void,
        );
        let watchdog = Watchdog::new(isolate.thread_safe_handle());

        let context = {
            v8::scope!(let hs, &mut isolate);
            let context = match (snapshot, opts.load_js_layer) {
                // Context 0 of the snapshot: the JS layer already ran.
                (Some(_), true) => v8::Context::from_snapshot(hs, 0, Default::default())
                    .expect("the startup snapshot lacks the JS layer context"),
                // The snapshot's default context has `__native` installed.
                _ => v8::Context::new(hs, Default::default()),
            };
            let scope = &mut v8::ContextScope::new(hs, context);
            match (snapshot, opts.load_js_layer) {
                (Some(_), true) => {
                    // The layer registered its hooks while the snapshot was built.
                    if let Ok(hooks) = scope.get_context_data_from_snapshot_once::<v8::Object>(0) {
                        let _ = crate::natives::register_hooks(scope, &state, hooks);
                    }
                }
                (Some(_), false) => {}
                (None, _) => install_native_object(scope),
            }
            v8::Global::new(scope, context)
        };

        let mut rt = ScriptRuntime {
            isolate: ManuallyDrop::new(isolate),
            context: ManuallyDrop::new(context),
            state,
            watchdog,
            timeout: SCRIPT_TIMEOUT,
            stats: StartupStats::default(),
        };
        rt.stats.context_setup = t0.elapsed() - t_snapshot;

        if opts.load_js_layer {
            rt.state.js_layer.set(true);
            rt.state.layer_loaded.set(true);
            rt.stats.js_layer_files = layer.len();
            if snapshot.is_some() {
                rt.stats.from_snapshot = true;
                rt.stats.js_layer = t_snapshot;
                rt.stats.js_layer_per_file.clear();
            } else {
                let t1 = Instant::now();
                let mut per_file = Vec::new();
                rt.enter(std::ptr::null_mut(), |scope, st| {
                    for (name, source) in layer {
                        let url = format!("internal:///{name}");
                        let tf = Instant::now();
                        let r = run_classic(scope, source, &url);
                        per_file.push((*name, tf.elapsed()));
                        if let Err(e) = r
                            && let Some(exc) = e.exception
                        {
                            let msg = format!(
                                "failed to load JS layer file {name}: {}",
                                exception_text(scope, exc)
                            );
                            st.host.console("error", &msg);
                        }
                    }
                });
                rt.stats.js_layer = t1.elapsed() + t_snapshot;
                rt.stats.js_layer_per_file = per_file;
            }
        }
        rt
    }

    /// Change the per-entry script time limit (default 10 s).
    #[doc(hidden)]
    pub fn set_script_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    /// Startup timing (context setup and JS layer execution).
    pub fn startup_stats(&self) -> &StartupStats {
        &self.stats
    }

    /// Run `f` inside the context with `doc` installed as the current document.
    /// The outermost entry arms the watchdog and ends with a microtask checkpoint.
    fn enter<R>(
        &mut self,
        doc: *mut BaseDocument,
        f: impl FnOnce(&mut v8::PinScope, &RuntimeState) -> R,
    ) -> R {
        let st = self.state.clone();
        let prev = st.set_doc(doc);
        let depth = st.depth.get();
        st.depth.set(depth + 1);
        if depth == 0 {
            st.invalidate_layout();
            self.watchdog.arm(self.timeout);
        }
        let r = {
            let isolate: &mut v8::OwnedIsolate = &mut self.isolate;
            v8::scope!(let hs, isolate);
            let context = v8::Local::new(hs, &*self.context);
            let scope = &mut v8::ContextScope::new(hs, context);
            let r = f(scope, &st);
            if depth == 0 && !scope.is_execution_terminating() {
                end_of_task(scope, &st);
            }
            r
        };
        if depth == 0 {
            let fired = self.watchdog.disarm();
            if fired || self.isolate.is_execution_terminating() {
                self.isolate.cancel_terminate_execution();
                st.host.console(
                    "error",
                    &format!(
                        "script timeout: execution exceeded {:?} and was terminated",
                        self.timeout
                    ),
                );
            }
            crate::platform::pump_message_loop(&self.isolate);
        }
        st.depth.set(depth);
        st.restore_doc(prev);
        r
    }

    /// The initial HTML was parsed into `doc`: runs hook `onDocumentParsed` (the JS
    /// layer then runs parser-inserted scripts and fires `DOMContentLoaded`).
    pub fn document_parsed(&mut self, doc: &mut BaseDocument) {
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            if let Ok(doc) = st.doc() {
                let root = doc.root_node().id;
                crate::html::post_parse_fixups(st, doc, root);
                crate::modules::register_document_import_maps(st, doc);
            }
            call_hook(scope, st, Hook::DocumentParsed, &[]);
        });
    }

    /// Dispatch a blitz DOM event to JS (hook `onEvent`), applying `preventDefault` /
    /// `stopPropagation` to `state`, and run default actions blitz doesn't implement
    /// (activation behavior, focus, form submission). Called by [`crate::JsEventHandler`].
    pub fn handle_event(
        &mut self,
        doc: &mut BaseDocument,
        chain: &[NodeId],
        event: &mut DomEvent,
        state: &mut EventState,
    ) {
        let _ = chain;
        if !self.state.js_layer.get() && self.state.hooks.borrow().get(Hook::Event).is_none() {
            return;
        }
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            crate::events::handle_dom_event(scope, st, event, state)
        });
    }

    /// Earliest deadline of a pending timer (or now if internal tasks are queued).
    pub fn next_timer_deadline(&self) -> Option<Instant> {
        if !self.state.tasks.borrow().is_empty() {
            return Some(Instant::now());
        }
        let t = self.state.timers.borrow().next_deadline();
        let storage = if self.state.storage.borrow().has_pending_writes() {
            Some(Instant::now() + Duration::from_secs(2))
        } else {
            None
        };
        match (t, storage) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Run internal tasks and all due timers (each as its own task with a microtask
    /// checkpoint).
    pub fn run_timers(&mut self, doc: &mut BaseDocument) {
        let ptr = doc as *mut BaseDocument;
        loop {
            let task = self.state.tasks.borrow_mut().pop_front();
            let Some(task) = task else { break };
            self.enter(ptr, |scope, st| run_internal_task(scope, st, task));
        }
        let now = Instant::now();
        let due = self.state.timers.borrow_mut().take_due(now);
        for id in due {
            self.enter(ptr, |scope, st| {
                let id = cx::num_value(scope, id);
                call_hook(scope, st, Hook::Timer, &[id]);
            });
        }
        self.state
            .storage
            .borrow_mut()
            .maybe_flush(Duration::from_secs(1));
    }

    /// Did JS request an animation frame (`requestAnimationFrame`)?
    pub fn wants_frame(&self) -> bool {
        self.state.frame_requested.get()
    }

    /// Produce a frame: runs hook `onFrame(timestamp)` if a frame was requested.
    pub fn run_frame(&mut self, doc: &mut BaseDocument, timestamp_ms: f64) {
        if !self.state.frame_requested.replace(false) {
            return;
        }
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            let ts = v8::Number::new(scope, timestamp_ms).into();
            call_hook(scope, st, Hook::Frame, &[ts]);
        });
    }

    /// Deliver a network response for a request started through [`ScriptHost::fetch`].
    pub fn deliver_fetch(&mut self, doc: &mut BaseDocument, resp: NetResponse) {
        let ptr = doc as *mut BaseDocument;
        if resp.id & MODULE_FETCH_BIT != 0 {
            self.enter(ptr, |scope, st| {
                crate::modules::on_fetch_response(scope, st, resp)
            });
            return;
        }
        if !self.state.pending_fetches.borrow_mut().remove(&resp.id) {
            return; // aborted or unknown
        }
        self.enter(ptr, |scope, st| {
            let NetResponse {
                id,
                status,
                status_text,
                url,
                headers,
                body,
                error,
                ..
            } = resp;
            let id = cx::num_value(scope, id as f64);
            let status = v8::Integer::new(scope, status as i32).into();
            let status_text = v8_str(scope, &status_text).into();
            let url = v8_str(scope, &url).into();
            let mut flat: Vec<v8::Local<v8::Value>> = Vec::with_capacity(headers.len() * 2);
            for (k, v) in &headers {
                flat.push(v8_str(scope, k).into());
                flat.push(v8_str(scope, v).into());
            }
            let headers = v8::Array::new_with_elements(scope, &flat).into();
            let body = array_buffer_from_vec(scope, body).into();
            let error = match error {
                Some(e) => v8_str(scope, &e).into(),
                None => v8::null(scope).into(),
            };
            call_hook(
                scope,
                st,
                Hook::Fetch,
                &[id, status, status_text, url, headers, body, error],
            );
        });
    }

    /// Deliver an event of a WebSocket opened through [`ScriptHost::ws_open`]: hook
    /// `onWebSocket(id, kind, ...)` with kind `open` (protocol, extensions), `message`
    /// (string or ArrayBuffer), `sent` (bytes), `error` (message) or `close` (code,
    /// reason, wasClean).
    pub fn deliver_ws(&mut self, doc: &mut BaseDocument, id: u64, event: common::protocol::WsEvent) {
        use common::protocol::{WsData, WsEvent};
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            let id = cx::num_value(scope, id as f64);
            let args: Vec<v8::Local<v8::Value>> = match event {
                WsEvent::Open { protocol, extensions } => vec![
                    id,
                    v8_str(scope, "open").into(),
                    v8_str(scope, &protocol).into(),
                    v8_str(scope, &extensions).into(),
                ],
                WsEvent::Message(data) => {
                    let data = match data {
                        WsData::Text(text) => v8_str(scope, &text).into(),
                        WsData::Binary(bytes) => array_buffer_from_vec(scope, bytes).into(),
                    };
                    vec![id, v8_str(scope, "message").into(), data]
                }
                WsEvent::Sent(bytes) => vec![
                    id,
                    v8_str(scope, "sent").into(),
                    cx::num_value(scope, bytes as f64),
                ],
                WsEvent::Error(message) => vec![
                    id,
                    v8_str(scope, "error").into(),
                    v8_str(scope, &message).into(),
                ],
                WsEvent::Closed { code, reason, clean } => vec![
                    id,
                    v8_str(scope, "close").into(),
                    v8::Integer::new(scope, code as i32).into(),
                    v8_str(scope, &reason).into(),
                    v8::Boolean::new(scope, clean).into(),
                ],
            };
            call_hook(scope, st, Hook::WebSocket, &args);
        });
    }

    /// All subresources finished loading: hook `onResourcesLoaded`.
    pub fn resources_loaded(&mut self, doc: &mut BaseDocument) {
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            call_hook(scope, st, Hook::ResourcesLoaded, &[]);
        });
    }

    /// The viewport was resized (or zoom / color scheme changed): hook `onViewportChanged`.
    pub fn viewport_changed(&mut self, doc: &mut BaseDocument) {
        let ptr = doc as *mut BaseDocument;
        self.state.layout_sig.set(0);
        self.enter(ptr, |scope, st| {
            call_hook(scope, st, Hook::ViewportChanged, &[]);
        });
    }

    /// The viewport was scrolled (by the user): hook `onScroll`.
    pub fn scrolled(&mut self, doc: &mut BaseDocument) {
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            call_hook(scope, st, Hook::Scroll, &[]);
        });
    }

    /// The page is being navigated away from: hook `onPageHide`, then flush storage.
    pub fn page_hide(&mut self, doc: &mut BaseDocument) {
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            call_hook(scope, st, Hook::PageHide, &[]);
        });
        self.state.storage.borrow_mut().flush();
    }

    /// The document's `<!DOCTYPE>` as `(name, public id, system id)`, or `None` if the
    /// source has none (quirks mode). blitz-html drops the doctype, so the renderer
    /// reports it (e.g. with [`crate::parse_doctype`] on the HTML source) before
    /// [`ScriptRuntime::document_parsed`]. Default: `<!DOCTYPE html>`.
    pub fn set_doctype(&mut self, doctype: Option<(&str, &str, &str)>) {
        *self.state.doctype.borrow_mut() =
            doctype.map(|(n, p, s)| (n.to_string(), p.to_string(), s.to_string()));
    }

    /// The host traversed the session history to another entry of this same document
    /// (created by `pushState` or a fragment navigation; see
    /// [`crate::ScriptHost::history_push`]). Updates the document URL, scrolls to the
    /// fragment and fires `popstate` / `hashchange` (hook `onPopState`).
    pub fn history_traversed(&mut self, doc: &mut BaseDocument, url: &str, index: u32) {
        let Ok(url) = url::Url::parse(url) else {
            return;
        };
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            let (_, length) = st.history.get();
            st.history.set((index, length.max(index + 1)));
            *st.url.borrow_mut() = url.clone();
            st.storage.borrow_mut().set_url(&url);
            if let Ok(doc) = st.doc() {
                doc.set_base_url(url.as_str());
            }
            crate::activation::scroll_to_url_fragment(st, &url);
            st.host.url_changed(url.as_str());
            crate::activation::fire_popstate(scope, st, url.as_str());
        });
    }

    /// A subresource of an element finished loading: `event_type` is `"load"` or
    /// `"error"` (`<img>`, `<link rel=stylesheet>`, `<iframe>`, ...). Runs hook
    /// `onElementEvent(id, type)`, which fires the event at the element.
    pub fn element_event(&mut self, doc: &mut BaseDocument, node: NodeId, event_type: &str) {
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, st| {
            let Ok(doc) = st.doc() else { return };
            if doc.get_node(node).is_none_or(|n| !n.is_element()) {
                return;
            }
            crate::dom::expose(doc, node);
            let Some(id) = cx::node_id_to_js(node) else {
                return;
            };
            let id = v8::Number::new(scope, id).into();
            let ty = v8_str(scope, event_type).into();
            call_hook(scope, st, Hook::ElementEvent, &[id, ty]);
        });
    }

    /// Evaluate `source` as a classic script in the page's global scope. The result is
    /// `JSON.stringify(value)`, falling back to `String(value)`; a promise result is
    /// awaited through one microtask checkpoint.
    pub fn eval(&mut self, doc: &mut BaseDocument, source: &str) -> Result<String, String> {
        let ptr = doc as *mut BaseDocument;
        self.enter(ptr, |scope, _st| {
            let value = match run_classic(scope, source, "eval") {
                Ok(v) => v,
                Err(e) => {
                    return Err(match e.exception {
                        Some(exc) => exception_text(scope, exc),
                        None => "script terminated".to_string(),
                    });
                }
            };
            let value = if value.is_promise() {
                let p: v8::Local<v8::Promise> = value.try_into().unwrap();
                scope.perform_microtask_checkpoint();
                match p.state() {
                    v8::PromiseState::Fulfilled => p.result(scope),
                    v8::PromiseState::Rejected => {
                        p.mark_as_handled();
                        let r = p.result(scope);
                        return Err(exception_text(scope, r));
                    }
                    v8::PromiseState::Pending => return Ok("Promise { <pending> }".to_string()),
                }
            } else {
                value
            };
            Ok(stringify_result(scope, value))
        })
    }

    /// Work that keeps a headless "wait until idle" loop waiting: JS fetches or module
    /// loads in flight, queued internal tasks, or timers due within a second.
    pub fn is_busy(&self) -> bool {
        let st = &self.state;
        if !st.pending_fetches.borrow().is_empty() || st.modules.borrow().is_loading() {
            return true;
        }
        if !st.tasks.borrow().is_empty() {
            return true;
        }
        st.timers
            .borrow()
            .next_deadline()
            .is_some_and(|d| d <= Instant::now() + Duration::from_secs(1))
    }

    /// Current document URL as seen by script (changes with pushState / fragments).
    pub fn document_url(&self) -> String {
        self.state.url_string()
    }
}

impl Drop for ScriptRuntime {
    fn drop(&mut self) {
        self.state.storage.borrow_mut().flush();
        for url in self.state.blob_urls.borrow_mut().drain(..) {
            crate::blob::revoke(&url);
        }
        // Release all V8 handles before disposing the isolate, then the isolate, then
        // (implicitly) the state it points to.
        self.state.clear_v8_handles();
        unsafe {
            ManuallyDrop::drop(&mut self.context);
            ManuallyDrop::drop(&mut self.isolate);
        }
    }
}

// ---------------------------------------------------------------------------------
// Helpers shared by natives and callbacks
// ---------------------------------------------------------------------------------

/// Result of a failed script run.
pub(crate) struct Caught<'s> {
    pub(crate) exception: Option<v8::Local<'s, v8::Value>>,
    pub(crate) message: Option<v8::Local<'s, v8::Message>>,
}

/// Compile and run a classic script. Exceptions are returned (not reported).
pub(crate) fn run_classic<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: &str,
    url: &str,
) -> Result<v8::Local<'s, v8::Value>, Caught<'s>> {
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
        false,
        None,
    );
    let Some(script) = v8::Script::compile(tc, src, Some(&origin)) else {
        return Err(Caught {
            exception: tc.exception(),
            message: tc.message(),
        });
    };
    match script.run(tc) {
        Some(v) => Ok(v),
        None => {
            if tc.has_terminated() {
                Err(Caught {
                    exception: None,
                    message: None,
                })
            } else {
                Err(Caught {
                    exception: tc.exception(),
                    message: tc.message(),
                })
            }
        }
    }
}

/// Human-readable description of an exception: the `stack` of Error objects (which
/// includes the message), else `String(value)`.
pub(crate) fn exception_text<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    exc: v8::Local<'s, v8::Value>,
) -> String {
    if exc.is_object() && !exc.is_proxy() {
        let obj: v8::Local<v8::Object> = exc.try_into().unwrap();
        v8::tc_scope!(let tc, scope);
        if let Some(stack) = get_prop(tc, obj, "stack")
            && stack.is_string()
        {
            let s = stack.to_rust_string_lossy(tc);
            if !s.is_empty() {
                return s;
            }
        }
    }
    v8::tc_scope!(let tc, scope);
    match exc.to_string(tc) {
        Some(s) => s.to_rust_string_lossy(tc),
        None => "<exception>".to_string(),
    }
}

thread_local! {
    static REPORTING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Report an uncaught exception: console error with stack, then a window `error` event
/// (through the `onError` hook if the JS layer registered one, else by dispatching an
/// `ErrorEvent` on the global object when the JS layer is loaded).
pub(crate) fn report_exception<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    exc: v8::Local<'s, v8::Value>,
    message: Option<v8::Local<'s, v8::Message>>,
) {
    report_exception_ex(scope, st, exc, message, true);
}

/// [`report_exception`]; with `fire_event == false` only the console message is emitted
/// (`N.evalScript` rethrows and the JS layer dispatches the `ErrorEvent` itself).
pub(crate) fn report_exception_ex<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    exc: v8::Local<'s, v8::Value>,
    message: Option<v8::Local<'s, v8::Message>>,
    fire_event: bool,
) {
    let mut text = exception_text(scope, exc);
    let (mut file, mut line, mut col) = (String::new(), 0, 0);
    if let Some(m) = message {
        if let Some(name) = m.get_script_resource_name(scope)
            && name.is_string()
        {
            file = name.to_rust_string_lossy(scope);
        }
        line = m.get_line_number(scope).unwrap_or(0);
        col = m.get_start_column() + 1;
        if !text.contains('\n') && !file.is_empty() {
            text.push_str(&format!("\n    at {file}:{line}:{col}"));
        }
    }
    st.host.console("error", &format!("Uncaught {text}"));
    if !fire_event || REPORTING.with(|r| r.replace(true)) {
        return;
    }
    let msg_text = match message {
        Some(m) => {
            let s = m.get(scope);
            s.to_rust_string_lossy(scope)
        }
        None => text.lines().next().unwrap_or("").to_string(),
    };
    let has_hook = st.hooks.borrow().get(Hook::Error).is_some();
    if has_hook {
        let args = [
            v8_str(scope, &msg_text).into(),
            v8_str(scope, &file).into(),
            v8::Integer::new(scope, line as i32).into(),
            v8::Integer::new(scope, col as i32).into(),
            exc,
        ];
        call_hook_quiet(scope, st, Hook::Error, &args);
    } else if st.js_layer.get() {
        let init = v8::Object::new(scope);
        let fields: [(&str, v8::Local<v8::Value>); 6] = [
            ("message", v8_str(scope, &msg_text).into()),
            ("filename", v8_str(scope, &file).into()),
            ("lineno", v8::Integer::new(scope, line as i32).into()),
            ("colno", v8::Integer::new(scope, col as i32).into()),
            ("error", exc),
            ("cancelable", v8::Boolean::new(scope, true).into()),
        ];
        for (k, v) in fields {
            set_prop(scope, init, k, v);
        }
        dispatch_global_event(scope, st, "ErrorEvent", "error", init);
    }
    REPORTING.with(|r| r.set(false));
}

/// `dispatchEvent(new <ctor>(type, init))` on the global object, for events the JS
/// layer did not register a hook for. Returns whether the event was canceled, or `None`
/// if the JS layer is not loaded, lacks the constructor, or dispatching threw.
pub(crate) fn dispatch_global_event<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    ctor: &str,
    ty: &str,
    init: v8::Local<'s, v8::Object>,
) -> Option<bool> {
    if !st.js_layer.get() {
        return None;
    }
    let context = scope.get_current_context();
    let global = context.global(scope);
    v8::tc_scope!(let tc, scope);
    let c: v8::Local<v8::Function> = get_prop(tc, global, ctor)?.try_into().ok()?;
    let ty = v8_str(tc, ty);
    let ev = c.new_instance(tc, &[ty.into(), init.into()])?;
    let d: v8::Local<v8::Function> = get_prop(tc, global, "dispatchEvent")?.try_into().ok()?;
    let r = d.call(tc, global.into(), &[ev.into()])?;
    Some(!r.boolean_value(tc))
}

/// Call a JS hook; exceptions are reported. Returns `None` if the hook isn't
/// registered or threw.
pub(crate) fn call_hook<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    hook: Hook,
    args: &[v8::Local<'s, v8::Value>],
) -> Option<v8::Local<'s, v8::Value>> {
    call_hook_impl(scope, st, hook, args, true)
}

fn call_hook_quiet<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    hook: Hook,
    args: &[v8::Local<'s, v8::Value>],
) -> Option<v8::Local<'s, v8::Value>> {
    call_hook_impl(scope, st, hook, args, false)
}

fn call_hook_impl<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    hook: Hook,
    args: &[v8::Local<'s, v8::Value>],
    report: bool,
) -> Option<v8::Local<'s, v8::Value>> {
    let (func, recv) = {
        let hooks = st.hooks.borrow();
        let f = hooks.get(hook)?;
        let func = v8::Local::new(scope, f);
        let recv: v8::Local<v8::Value> = match &hooks.obj {
            Some(o) => v8::Local::new(scope, o).into(),
            None => v8::undefined(scope).into(),
        };
        (func, recv)
    };
    let r = {
        v8::tc_scope!(let tc, scope);
        let r = func.call(tc, recv, args);
        if r.is_none()
            && report
            && tc.can_continue()
            && let Some(exc) = tc.exception()
        {
            let msg = tc.message();
            report_exception(tc, st, exc, msg);
        }
        r
    };
    // A hook called with no JS on the stack is a complete script invocation: microtasks
    // run right after it ("clean up after running script"), e.g. between the events a
    // single native input produces.
    if st.native_depth.get() == 0 && !scope.is_execution_terminating() {
        end_of_task(scope, st);
    }
    r
}

/// End of a task: microtask checkpoint, then report unhandled promise rejections
/// (which may queue more microtasks).
pub(crate) fn end_of_task(scope: &mut v8::PinScope, st: &RuntimeState) {
    if st.in_checkpoint.replace(true) {
        return;
    }
    end_of_task_inner(scope, st);
    st.in_checkpoint.set(false);
}

fn end_of_task_inner(scope: &mut v8::PinScope, st: &RuntimeState) {
    for _ in 0..16 {
        scope.perform_microtask_checkpoint();
        let pending = std::mem::take(&mut *st.pending_rejections.borrow_mut());
        if pending.is_empty() {
            break;
        }
        for (pg, vg) in pending {
            let p = v8::Local::new(scope, &pg);
            if p.has_handler() {
                continue;
            }
            {
                // Remember it for `rejectionhandled`.
                let mut reported = st.reported_rejections.borrow_mut();
                if reported.len() >= MAX_REPORTED_REJECTIONS {
                    reported.pop_front();
                }
                reported.push_back((pg, vg.clone()));
            }
            let v = v8::Local::new(scope, &vg);
            let handled = if st.hooks.borrow().get(Hook::UnhandledRejection).is_some() {
                // The JS layer fires `unhandledrejection` and reports it unless canceled;
                // only a hook that fails leaves the reporting to us.
                call_hook(scope, st, Hook::UnhandledRejection, &[p.into(), v]).is_some()
            } else if st.js_layer.get() {
                // window `unhandledrejection`; canceling it suppresses the console report.
                let init = v8::Object::new(scope);
                set_prop(scope, init, "promise", p.into());
                set_prop(scope, init, "reason", v);
                let t = v8::Boolean::new(scope, true).into();
                set_prop(scope, init, "cancelable", t);
                dispatch_global_event(
                    scope,
                    st,
                    "PromiseRejectionEvent",
                    "unhandledrejection",
                    init,
                ) == Some(true)
            } else {
                false
            };
            if !handled {
                let text = exception_text(scope, v);
                st.host
                    .console("error", &format!("Uncaught (in promise) {text}"));
            }
        }
    }
}

/// Define the hidden `__native` object on the global (the JS prelude captures and
/// deletes it).
pub(crate) fn install_native_object(scope: &mut v8::PinScope) {
    let native = crate::natives::install(scope);
    let context = scope.get_current_context();
    let global = context.global(scope);
    let key = cx::v8_key(scope, "__native");
    global.define_own_property(
        scope,
        key.into(),
        native.into(),
        v8::PropertyAttribute::DONT_ENUM,
    );
}

/// Uncaught exceptions V8 reports outside our `TryCatch`es (e.g. in platform tasks such
/// as `FinalizationRegistry` cleanup callbacks): logged to the console. May run without
/// an entered context, so only the message text is used.
extern "C" fn message_listener(message: v8::Local<v8::Message>, _exception: v8::Local<v8::Value>) {
    v8::callback_scope!(unsafe scope, message);
    let Some(ptr) = scope.get_slot::<StatePtr>().copied() else {
        return;
    };
    let st = ptr.get();
    let text = message.get(scope).to_rust_string_lossy(scope);
    let file = message
        .get_script_resource_name(scope)
        .and_then(|n| v8::Local::<v8::String>::try_from(n).ok())
        .map(|n| n.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if file.is_empty() {
        st.host.console("error", &text);
    } else {
        st.host.console("error", &format!("{text}\n    at {file}"));
    }
}

pub(crate) extern "C" fn promise_reject_callback(msg: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe scope, &msg);
    let Some(ptr) = scope.get_slot::<StatePtr>().copied() else {
        return;
    };
    let st = ptr.get();
    let promise = msg.get_promise();
    match msg.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let value: v8::Local<v8::Value> = msg
                .get_value()
                .unwrap_or_else(|| v8::undefined(scope).into());
            let p = v8::Global::new(scope, promise);
            let v = v8::Global::new(scope, value);
            st.pending_rejections.borrow_mut().push((p, v));
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => {
            let before = st.pending_rejections.borrow().len();
            st.pending_rejections
                .borrow_mut()
                .retain(|(p, _)| v8::Local::new(scope, p) != promise);
            if st.pending_rejections.borrow().len() != before {
                return; // handled before it was reported
            }
            let mut reported = st.reported_rejections.borrow_mut();
            if let Some(i) = reported
                .iter()
                .position(|(p, _)| v8::Local::new(scope, p) == promise)
                && let Some((p, v)) = reported.remove(i)
            {
                st.tasks
                    .borrow_mut()
                    .push_back(InternalTask::RejectionHandled(p, v));
            }
        }
        _ => {}
    }
}

/// `JSON.stringify(value)` falling back to `String(value)`.
pub(crate) fn stringify_result<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> String {
    if value.is_undefined() {
        return "undefined".to_string();
    }
    {
        v8::tc_scope!(let tc, scope);
        if let Some(s) = v8::json::stringify(tc, value)
            && !tc.has_caught()
        {
            let s = s.to_rust_string_lossy(tc);
            // JSON.stringify returns undefined for functions/symbols.
            if s != "undefined" {
                return s;
            }
        }
    }
    v8::tc_scope!(let tc, scope);
    match value.to_string(tc) {
        Some(s) => s.to_rust_string_lossy(tc),
        None => String::new(),
    }
}

fn run_internal_task(scope: &mut v8::PinScope, st: &RuntimeState, task: InternalTask) {
    match task {
        InternalTask::RejectionHandled(promise, reason) => {
            let promise = v8::Local::new(scope, &promise);
            let reason = v8::Local::new(scope, &reason);
            call_hook(scope, st, Hook::RejectionHandled, &[promise.into(), reason]);
        }
        InternalTask::ViewportScroll => {
            call_hook(scope, st, Hook::Scroll, &[]);
        }
        InternalTask::ElementScroll(id) => {
            if st.doc().ok().and_then(|d| d.get_node(id)).is_some() {
                let init = crate::activation::simple_init(scope, false, false);
                crate::activation::dispatch(scope, st, "scroll", id, init);
            }
        }
    }
}
