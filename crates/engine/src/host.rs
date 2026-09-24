//! Services the renderer hands to Blitz (net / navigation / shell providers) and to the
//! script runtime ([`script::ScriptHost`]).

use crate::renderer::LoopMsg;
use blitz_traits::navigation::{NavigationOptions, NavigationProvider};
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use blitz_traits::shell::ShellProvider;
use common::ipc::IpcSender;
use common::protocol::{CursorKind, FromRenderer, NetRequest, NetResponse};
use crossbeam_channel::Sender;
use cursor_icon::CursorIcon;
use netstack::NetClient;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// State shared between the event loop and the providers (thread-safe parts).
pub struct Shared {
    /// Wakes the renderer loop.
    pub loop_tx: Sender<LoopMsg>,
    /// Channel to the browser process.
    pub browser: IpcSender<FromRenderer>,
    /// Something requested a new frame.
    pub redraw: AtomicBool,
    /// Blitz subresource requests in flight (stylesheets, images, fonts).
    pub pending_resources: AtomicUsize,
    /// Last cursor sent to the browser (avoid spamming identical messages).
    pub cursor: std::sync::Mutex<Option<CursorKind>>,
}

impl Shared {
    pub fn send(&self, msg: FromRenderer) {
        let _ = self.browser.send(&msg);
    }
    pub fn wake(&self) {
        let _ = self.loop_tx.send(LoopMsg::Wake);
    }
}

// ---------------------------------------------------------------------------
// Blitz NetProvider wrapper: counts in-flight requests so the page knows when all
// subresources are loaded (window.onload) and wakes the loop on completion.
// ---------------------------------------------------------------------------

pub struct CountingNetProvider {
    pub inner: netstack::BlitzNetProvider,
    pub shared: Arc<Shared>,
}

struct CountingHandler {
    inner: Option<Box<dyn NetHandler>>,
    shared: Arc<Shared>,
}

impl NetHandler for CountingHandler {
    fn bytes(mut self: Box<Self>, resolved_url: String, bytes: Bytes) {
        if let Some(h) = self.inner.take() {
            h.bytes(resolved_url, bytes);
        }
        // Drop impl does the accounting.
    }
}

impl Drop for CountingHandler {
    fn drop(&mut self) {
        self.shared.pending_resources.fetch_sub(1, Ordering::SeqCst);
        self.shared.redraw.store(true, Ordering::SeqCst);
        self.shared.wake();
    }
}

impl NetProvider for CountingNetProvider {
    fn fetch(&self, doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        // `blob:` subresources are served from the page's JS blob registry.
        if request.url.scheme() == "blob" {
            if let Some(blob) = script::resolve_blob_url(request.url.as_str()) {
                handler.bytes(request.url.to_string(), Bytes::from(blob.bytes.to_vec()));
            }
            self.shared.wake();
            return;
        }
        self.shared.pending_resources.fetch_add(1, Ordering::SeqCst);
        let wrapped = Box::new(CountingHandler {
            inner: Some(handler),
            shared: self.shared.clone(),
        });
        self.inner.fetch(doc_id, request, wrapped);
    }
}

// ---------------------------------------------------------------------------
// Navigation (link clicks handled natively by blitz)
// ---------------------------------------------------------------------------

pub struct NavProvider {
    pub shared: Arc<Shared>,
}

impl NavigationProvider for NavProvider {
    fn navigate_to(&self, options: NavigationOptions) {
        let (body, content_type) = match &options.document_resource {
            blitz_traits::net::Body::Bytes(b) => (Some(b.to_vec()), options.content_type.clone()),
            blitz_traits::net::Body::Form(form) => {
                let (bytes, ct) =
                    netstack::encode_form_body(form, options.content_type.as_deref());
                (Some(bytes), Some(ct))
            }
            blitz_traits::net::Body::Empty => (None, options.content_type.clone()),
        };
        self.shared.send(FromRenderer::OpenUrl {
            url: options.url.to_string(),
            method: options.method.to_string(),
            body,
            content_type,
            new_tab: false,
            replace: false,
        });
    }
}

// ---------------------------------------------------------------------------
// Shell provider (cursor, redraw, title, IME)
// ---------------------------------------------------------------------------

pub struct Shell {
    pub shared: Arc<Shared>,
}

fn map_cursor(icon: Option<CursorIcon>) -> CursorKind {
    use CursorIcon as C;
    match icon {
        None => CursorKind::Default,
        Some(i) => match i {
            C::Pointer => CursorKind::Pointer,
            C::Text | C::VerticalText => CursorKind::Text,
            C::Wait => CursorKind::Wait,
            C::Progress => CursorKind::Progress,
            C::Crosshair => CursorKind::Crosshair,
            C::Move | C::AllScroll => CursorKind::Move,
            C::NotAllowed | C::NoDrop => CursorKind::NotAllowed,
            C::Grab => CursorKind::Grab,
            C::Grabbing => CursorKind::Grabbing,
            C::EResize | C::WResize | C::EwResize => CursorKind::EwResize,
            C::NResize | C::SResize | C::NsResize => CursorKind::NsResize,
            C::NeResize | C::SwResize | C::NeswResize => CursorKind::NeswResize,
            C::NwResize | C::SeResize | C::NwseResize => CursorKind::NwseResize,
            C::ColResize => CursorKind::ColResize,
            C::RowResize => CursorKind::RowResize,
            C::Help => CursorKind::Help,
            C::ZoomIn => CursorKind::ZoomIn,
            C::ZoomOut => CursorKind::ZoomOut,
            _ => CursorKind::Default,
        },
    }
}

impl ShellProvider for Shell {
    fn request_redraw(&self) {
        self.shared.redraw.store(true, Ordering::SeqCst);
        self.shared.wake();
    }
    fn set_cursor(&self, icon: Option<CursorIcon>) {
        let kind = map_cursor(icon);
        let mut last = self.shared.cursor.lock().unwrap_or_else(|p| p.into_inner());
        if *last != Some(kind) {
            *last = Some(kind);
            self.shared.send(FromRenderer::Cursor(kind));
        }
    }
    fn set_window_title(&self, _title: String) {
        // Ignored: iframe sub-documents share this provider. The renderer reads the main
        // document's <title> after each frame instead.
        self.shared.redraw.store(true, Ordering::SeqCst);
    }
    fn set_ime_enabled(&self, is_enabled: bool) {
        self.shared.send(FromRenderer::ImeAllowed(is_enabled));
    }
    fn get_clipboard_text(&self) -> Result<String, blitz_traits::shell::ClipboardError> {
        arboard::Clipboard::new()
            .and_then(|mut c| c.get_text())
            .map_err(|_| blitz_traits::shell::ClipboardError)
    }
    fn set_clipboard_text(&self, text: String) -> Result<(), blitz_traits::shell::ClipboardError> {
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(text))
            .map_err(|_| blitz_traits::shell::ClipboardError)
    }
}

// ---------------------------------------------------------------------------
// ScriptHost
// ---------------------------------------------------------------------------

/// Per-document script host. Lives on the renderer's main thread.
pub struct RendererHost {
    pub shared: Arc<Shared>,
    pub net: NetClient,
    /// Document generation this host belongs to (stale responses are dropped).
    pub generation: u64,
    /// JS request id -> network request id (for aborts).
    pub inflight: RefCell<HashMap<u64, u64>>,
    /// Script socket id -> network socket id of the page's open WebSockets.
    pub sockets: RefCell<HashMap<u64, u64>>,
    pub referrer: String,
    pub verbose_console: bool,
    pub title: RefCell<String>,
    pub history: Cell<(u32, u32)>,
}

impl Drop for RendererHost {
    /// The document is gone (navigation, tab closed): close its sockets ("going away").
    fn drop(&mut self) {
        for (_, net_id) in self.sockets.borrow_mut().drain() {
            self.net.ws_close(net_id, Some(1001), "");
        }
    }
}

impl script::ScriptHost for RendererHost {
    fn fetch(&self, req: NetRequest) {
        let js_id = req.id;
        let tx = self.shared.loop_tx.clone();
        let generation = self.generation;
        let net_id = self.net.fetch(
            req,
            Box::new(move |mut resp: NetResponse| {
                resp.id = js_id;
                let _ = tx.send(LoopMsg::ScriptFetch { generation, resp });
            }),
        );
        self.inflight.borrow_mut().insert(js_id, net_id);
    }

    fn abort_fetch(&self, id: u64) {
        if let Some(net_id) = self.inflight.borrow_mut().remove(&id) {
            self.net.abort(net_id);
        }
    }

    fn ws_open(&self, id: u64, url: &str, protocols: Vec<String>, origin: &str) -> bool {
        let tx = self.shared.loop_tx.clone();
        let generation = self.generation;
        let net_id = self.net.ws_open(
            url,
            protocols,
            origin,
            Box::new(move |event| {
                let _ = tx.send(LoopMsg::ScriptWs { generation, id, event });
            }),
        );
        self.sockets.borrow_mut().insert(id, net_id);
        true
    }

    fn ws_send(&self, id: u64, data: common::protocol::WsData) {
        if let Some(&net_id) = self.sockets.borrow().get(&id) {
            self.net.ws_send(net_id, data);
        }
    }

    fn ws_close(&self, id: u64, code: Option<u16>, reason: &str) {
        if let Some(&net_id) = self.sockets.borrow().get(&id) {
            self.net.ws_close(net_id, code, reason);
        }
    }

    fn get_cookies(&self, url: &str) -> String {
        self.net.get_cookies_blocking(url)
    }

    fn set_cookie(&self, url: &str, cookie: &str) {
        self.net.set_cookie(url, cookie)
    }

    fn navigate(
        &self,
        url: &str,
        replace: bool,
        method: &str,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
    ) {
        self.shared.send(FromRenderer::OpenUrl {
            url: url.to_string(),
            method: method.to_string(),
            body,
            content_type,
            new_tab: false,
            replace,
        });
    }

    fn open_new_tab(&self, url: &str) {
        self.shared.send(FromRenderer::OpenUrl {
            url: url.to_string(),
            method: "GET".into(),
            body: None,
            content_type: None,
            new_tab: true,
            replace: false,
        });
    }

    fn history_go(&self, delta: i32) {
        self.shared.send(FromRenderer::HistoryGo(delta));
    }

    fn url_changed(&self, url: &str) {
        self.shared.send(FromRenderer::UrlChanged(url.to_string()));
    }

    fn title_changed(&self, title: &str) {
        // The <title> element is the source of truth; the renderer reports it after the
        // next frame.
        *self.title.borrow_mut() = title.to_string();
        self.shared.redraw.store(true, Ordering::SeqCst);
    }

    fn console(&self, level: &str, message: &str) {
        if self.verbose_console {
            eprintln!("[console.{level}] {message}");
        }
        self.shared.send(FromRenderer::Console {
            level: level.to_string(),
            message: message.to_string(),
        });
    }

    fn request_redraw(&self) {
        self.shared.redraw.store(true, Ordering::SeqCst);
    }

    fn pending_resource_count(&self) -> u32 {
        self.shared.pending_resources.load(Ordering::SeqCst) as u32
    }

    fn fetch_sync(&self, req: NetRequest) -> Option<NetResponse> {
        let (tx, rx) = crossbeam_channel::bounded(1);
        self.net.fetch(
            req,
            Box::new(move |resp| {
                let _ = tx.send(resp);
            }),
        );
        rx.recv_timeout(std::time::Duration::from_secs(30)).ok()
    }

    fn referrer(&self) -> String {
        self.referrer.clone()
    }

    fn history_push(&self, url: &str, replace: bool) {
        self.shared.send(FromRenderer::HistoryPush {
            url: url.to_string(),
            replace,
        });
    }

    fn clipboard_write(&self, text: &str) {
        if let Ok(mut c) = arboard::Clipboard::new() {
            let _ = c.set_text(text.to_string());
        }
    }
}
