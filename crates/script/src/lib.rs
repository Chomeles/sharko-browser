//! V8 JavaScript runtime + native DOM bindings for the renderer.
//!
//! # Overview
//!
//! [`ScriptRuntime`] owns one V8 isolate per page and one context (realm) per document
//! in it: the page's, whose global object is `window`, and one for each iframe document
//! that runs script ([`ScriptRuntime::ensure_frame`], or created on demand when a
//! same-origin script reaches into the frame, see [`ScriptHost::frame_host`]). Realms of
//! one origin share a V8 security token, so `iframe.contentWindow.document`,
//! `parent.foo()` and `frameElement` are the real objects of the other realm; every realm
//! runs its own copy of the JS DOM layer against its own document (natives find the
//! calling realm's state through the current context). At creation the runtime installs
//! a hidden object `__native` implementing the Rust <-> JS contract in
//! `crates/script/js/NATIVE_API.md` and executes the JS DOM layer (`crates/script/js/*.js`,
//! embedded at build time, sorted by file name) — or, normally, deserializes a startup
//! snapshot of a context in which the layer already ran (built once per profile; see
//! `snapshot.rs`).
//!
//! The renderer owns the [`blitz_dom::BaseDocument`] (iframe documents hang off it as
//! subdocuments). Every call into JS goes through a method that takes `&mut BaseDocument`
//! (the page's); for the duration of that call every realm keeps a raw pointer to its
//! document which natives borrow transiently (see `state.rs` for the safety invariants).
//! Frame documents are addressed by their *frame path*: the `<iframe>` node ids from the
//! page down (`[]` is the page).
//!
//! # Integration (renderer)
//!
//! * Build the document with a [`blitz_dom::DocumentConfig`] passed through
//!   [`configure_document`].
//! * Create the runtime before or right after parsing; call
//!   [`ScriptRuntime::document_parsed`] once the initial HTML is in the document (the JS
//!   layer then runs the page's scripts).
//! * Route UI events through blitz's `EventDriver` with the runtime as handler:
//!   `EventDriver::new(&mut doc, JsEventHandler::new(&mut rt)).handle_ui_event(ev)`; for an
//!   event in an iframe document, drive that subdocument with
//!   [`JsEventHandler::for_frame`].
//! * Create a frame's realm with [`ScriptRuntime::ensure_frame`] once its document is
//!   parsed (and drop it with [`ScriptRuntime::remove_frame`] when the frame goes away);
//!   the `_in` variants of the delivery methods ([`ScriptRuntime::deliver_fetch_in`],
//!   [`ScriptRuntime::eval_in`], ...) address a frame's realm.
//! * Event loop: call [`ScriptRuntime::run_timers`] when [`ScriptRuntime::next_timer_deadline`]
//!   passes, [`ScriptRuntime::run_frame`] before painting when
//!   [`ScriptRuntime::wants_frame`], and [`ScriptRuntime::deliver_fetch`] for every
//!   response to a [`ScriptHost::fetch`] (including ids with the high bit set, which belong
//!   to the ES module loader). Also [`ScriptRuntime::resources_loaded`],
//!   [`ScriptRuntime::element_event`], [`ScriptRuntime::viewport_changed`],
//!   [`ScriptRuntime::scrolled`], [`ScriptRuntime::history_traversed`] and
//!   [`ScriptRuntime::page_hide`].
//! * Pass [`animation_time`] to your own `BaseDocument::resolve` calls.
//! * Serve `blob:` URLs of subresources with [`resolve_blob_url`].
//!
//! # Threading
//!
//! A V8 isolate is `!Send`: a [`ScriptRuntime`] must be created, used and dropped on one
//! thread (the renderer's main thread). The V8 platform is initialized once per process
//! (lazily, by the first [`ScriptRuntime::new`]). Runtimes on one thread must be dropped
//! in reverse creation order (V8 isolates are entered on creation).

mod activation;
mod blob;
mod canvas;
mod compress;
mod cx;
mod dom;
mod events;
mod forms;
mod html;
mod layout;
mod modules;
mod natives;
mod platform;
mod runtime;
mod selector;
mod snapshot;
mod state;
mod storage;
mod style;
mod timers;
mod watchdog;

pub use blob::{BlobData, resolve_blob_url};
pub use cx::{node_id_from_js, node_id_to_js};
pub use events::JsEventHandler;
pub use runtime::{RuntimeOptions, ScriptRuntime, StartupStats};


use std::sync::Arc;

/// Services the renderer provides to the script runtime.
///
/// All methods are called on the runtime's thread, synchronously, while JS may be on the
/// stack: implementations must not call back into the [`ScriptRuntime`] (queue work
/// instead, e.g. deliver fetch results later through [`ScriptRuntime::deliver_fetch`]).
pub trait ScriptHost {
    /// Start a network request. The result must come back via
    /// [`ScriptRuntime::deliver_fetch`] (with the same `req.id`). Ids with the high bit set
    /// belong to the ES module loader, the others to the JS layer (`fetch`/XHR/scripts).
    fn fetch(&self, req: common::protocol::NetRequest);
    /// Abort a request started with [`ScriptHost::fetch`]. A late response for an
    /// aborted id is ignored by the runtime.
    fn abort_fetch(&self, id: u64);
    /// The `document.cookie` string for `url` (synchronous).
    fn get_cookies(&self, url: &str) -> String;
    /// `document.cookie = cookie` for `url`.
    fn set_cookie(&self, url: &str, cookie: &str);
    /// Navigate this tab (link click, form submission, `location = ...`).
    fn navigate(
        &self,
        url: &str,
        replace: bool,
        method: &str,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
    );
    /// `window.open`, `target=_blank` links and forms.
    fn open_new_tab(&self, url: &str);
    /// `history.go(delta)` / `back()` / `forward()`.
    fn history_go(&self, delta: i32);
    /// The document URL changed without a navigation (pushState / replaceState /
    /// fragment navigation).
    fn url_changed(&self, url: &str);
    /// `document.title` changed.
    fn title_changed(&self, title: &str);
    /// Console output. `level` is one of `log`, `info`, `warn`, `error`, `debug`.
    fn console(&self, level: &str, message: &str);
    /// Something visible changed (DOM mutation, scroll, ...): schedule a frame.
    fn request_redraw(&self);
    /// Number of document subresources (stylesheets, images, fonts) still loading.
    /// Used for `N.pendingResourceCount()` (the JS layer fires `window.load` when it
    /// reaches 0). The default reports 0 (only render-blocking stylesheets tracked by
    /// blitz are then counted).
    fn pending_resource_count(&self) -> u32 {
        0
    }
    /// Perform a request synchronously (synchronous `XMLHttpRequest`), blocking the
    /// script thread. `None` (the default) means unsupported: the request fails with a
    /// network error.
    fn fetch_sync(
        &self,
        req: common::protocol::NetRequest,
    ) -> Option<common::protocol::NetResponse> {
        let _ = req;
        None
    }
    /// Open a WebSocket for the page (`new WebSocket(url, protocols)`). Its events must
    /// come back through [`ScriptRuntime::deliver_ws`] with the same `id`, ending with
    /// exactly one `Closed`. Returns `false` if the host has no WebSocket support (the
    /// default).
    fn ws_open(&self, id: u64, url: &str, protocols: Vec<String>, origin: &str) -> bool {
        let _ = (id, url, protocols, origin);
        false
    }
    /// Send a message on a socket opened with [`ScriptHost::ws_open`].
    fn ws_send(&self, id: u64, data: common::protocol::WsData) {
        let _ = (id, data);
    }
    /// Close (or abort, while connecting) a socket opened with [`ScriptHost::ws_open`].
    fn ws_close(&self, id: u64, code: Option<u16>, reason: &str) {
        let _ = (id, code, reason);
    }
    /// A same-document session history entry was added (`pushState`, fragment
    /// navigation) or, with `replace`, the current entry's URL was replaced
    /// (`replaceState`, `location.replace('#x')`). Followed by
    /// [`ScriptHost::url_changed`]. Hosts implementing session history create the entry
    /// here; a later `history_go` to it must call [`ScriptRuntime::history_traversed`]
    /// instead of loading the URL.
    fn history_push(&self, url: &str, replace: bool) {
        let _ = (url, replace);
    }
    /// The tab's session history as `(index of the current entry, number of entries)`,
    /// for `history.length` and state bookkeeping. `None` (the default): the runtime
    /// counts the entries this document created.
    fn history_position(&self) -> Option<(u32, u32)> {
        None
    }
    /// `document.referrer` of this document (default: none).
    fn referrer(&self) -> String {
        String::new()
    }
    /// The initial `window.name`: an iframe document's is its `<iframe name>` (default:
    /// empty).
    fn window_name(&self) -> String {
        String::new()
    }
    /// `navigator.clipboard.writeText(text)` (default: ignored).
    fn clipboard_write(&self, text: &str) {
        let _ = text;
    }
    /// `postMessage` to another frame's window. Frames are named by their path: the
    /// `<iframe>` node ids (`NodeId::as_u64`, each in its parent's document) from the page
    /// down; the page is `[]`. `target_origin` is `*` or the origin the receiver must
    /// have; `data` is the message serialized with V8's ValueSerializer. Default: dropped.
    fn post_message(&self, target: &[u64], target_origin: &str, data: Vec<u8>) {
        let _ = (target, target_origin, data);
    }
    /// The frame path of this document (`[]`: the page, the default).
    fn frame_path(&self) -> Vec<u64> {
        Vec::new()
    }
    /// The frames of the document at `path` in tree order, as `(node id of the <iframe>,
    /// its name)` (`parent.frames['x']`, `top.length`); `None` if unknown.
    fn frame_children(&self, path: &[u64]) -> Option<Vec<(u64, String)>> {
        let _ = path;
        None
    }
    /// A host for the document of the frame at `path` (URL `url`), so the runtime can
    /// create that frame's realm on demand when a script of a same-origin frame reaches
    /// into it (`iframe.contentWindow.document`, `parent.foo()`). Default: `None` (the
    /// frame's realm is only created by the host through `ScriptRuntime::ensure_frame`).
    fn frame_host(&self, path: &[u64], url: &str) -> Option<std::rc::Rc<dyn ScriptHost>> {
        let _ = (path, url);
        None
    }
}

/// Configure a [`blitz_dom::DocumentConfig`] for use with the script runtime.
///
/// Sets the HTML parser provider (needed by blitz for `<iframe srcdoc>` and by any code
/// using `DocumentMutator::set_inner_html`). The runtime's own `innerHTML` /
/// `parseHTMLFragment` natives use a built-in side-effect-free fragment parser.
pub fn configure_document(config: &mut blitz_dom::DocumentConfig) {
    config.html_parser_provider = Some(Arc::new(blitz_html::HtmlProvider));
}

/// The `<!DOCTYPE>` at the start of an HTML source as `(name, public id, system id)`, or
/// `None` if there is none (for [`ScriptRuntime::set_doctype`]).
pub fn parse_doctype(source: &str) -> Option<(String, String, String)> {
    let mut s = source.trim_start_matches('\u{feff}');
    loop {
        s = s.trim_start_matches(|c: char| c.is_ascii_whitespace());
        if let Some(rest) = s.strip_prefix("<!--") {
            s = &rest[rest.find("-->")? + 3..];
        } else if s.starts_with("<?") {
            s = &s[s.find('>')? + 1..];
        } else {
            break;
        }
    }
    if s.len() < 9 || !s[..9].eq_ignore_ascii_case("<!doctype") {
        return None;
    }
    let body = &s[9..s.find('>')?];
    let mut rest = body.trim_start_matches(|c: char| c.is_ascii_whitespace());
    let name_end = rest
        .find(|c: char| c.is_ascii_whitespace())
        .unwrap_or(rest.len());
    let name = rest[..name_end].to_ascii_lowercase();
    rest = rest[name_end..].trim_start_matches(|c: char| c.is_ascii_whitespace());
    let quoted = |r: &mut &str| -> String {
        let t = r.trim_start_matches(|c: char| c.is_ascii_whitespace());
        let Some(q) = t.chars().next().filter(|&c| c == '"' || c == '\'') else {
            *r = t;
            return String::new();
        };
        let inner = &t[1..];
        let end = inner.find(q).unwrap_or(inner.len());
        *r = inner.get(end + 1..).unwrap_or("");
        inner[..end].to_string()
    };
    let (mut public_id, mut system_id) = (String::new(), String::new());
    if rest.len() >= 6 && rest[..6].eq_ignore_ascii_case("public") {
        rest = &rest[6..];
        public_id = quoted(&mut rest);
        system_id = quoted(&mut rest);
    } else if rest.len() >= 6 && rest[..6].eq_ignore_ascii_case("system") {
        rest = &rest[6..];
        system_id = quoted(&mut rest);
    }
    Some((name, public_id, system_id))
}

/// Enable or disable the JS layer startup snapshot (default: enabled unless the
/// `SCRIPT_NO_SNAPSHOT` environment variable is set). Only effective before the first
/// runtime of the process is created. For tests and debugging.
#[doc(hidden)]
pub fn set_snapshots_enabled(enabled: bool) {
    snapshot::set_enabled(enabled);
}

/// The clock (seconds) the runtime passes to `BaseDocument::resolve` when a script forces
/// a style/layout flush (`getBoundingClientRect`, `getComputedStyle`, ...). The renderer
/// should pass the same clock to its own `resolve` calls so CSS animations/transitions
/// progress consistently.
pub fn animation_time() -> f64 {
    platform::process_start().elapsed().as_secs_f64()
}
