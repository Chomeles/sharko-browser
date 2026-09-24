//! The renderer process: owns one tab's document (Blitz DOM + Stylo + Taffy), its
//! JavaScript runtime (V8) and produces display lists for the browser's compositor.
//!
//! Event loop (single thread, the V8 isolate lives here):
//!
//! ```text
//!   browser IPC ─┐
//!   net callbacks├─► LoopMsg channel ─► handle() ─► tick(): timers → rAF → style/layout → paint → Frame
//!   blitz wakes ─┘
//! ```

use crate::decode::{self, DocKind};
use crate::host::{CountingNetProvider, NavProvider, RendererHost, Shared, Shell};
use crate::input::to_ui_event;
use blitz_dom::{BaseDocument, DocumentConfig, EventDriver, FontContext, NoopEventHandler};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, SentResources};
use common::ipc::{self, IpcSender};
use common::protocol::{
    Destination, Frame, FromRenderer, InputEvent, LoadEvent, NetRequest, NetResponse, ToRenderer,
    ViewportInfo,
};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use netstack::NetClient;
use script::{JsEventHandler, RuntimeOptions, ScriptRuntime};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Messages into the renderer's event loop.
pub enum LoopMsg {
    /// From the browser process (`None` = browser went away → exit).
    Browser(Option<ToRenderer>),
    /// Main document response for navigation `generation`.
    Document { generation: u64, resp: NetResponse },
    /// Response to a script-initiated fetch.
    ScriptFetch { generation: u64, resp: NetResponse },
    /// Something happened on another thread (subresource loaded, redraw requested).
    Wake,
}

const FRAME_INTERVAL: Duration = Duration::from_micros(16_667);
/// While a page is still loading (after its first paint), style/layout work is batched
/// into fewer frames: every stylesheet or class change on the root forces a full restyle,
/// and doing that at 60 Hz during load only delays the load itself.
const LOADING_FRAME_INTERVAL: Duration = Duration::from_millis(100);
/// Don't paint an unstyled page while render-blocking stylesheets load (like browsers),
/// but give up waiting after this long.
const RENDER_BLOCK_TIMEOUT: Duration = Duration::from_secs(4);

struct Page {
    doc: BaseDocument,
    rt: Option<ScriptRuntime>,
    host: Rc<RendererHost>,
    url: String,
    generation: u64,
    created: Instant,
    load_sent: bool,
    dcl_sent: bool,
    last_ready_check: Instant,
    last_scroll: (f64, f64),
    last_title: String,
    parse_ms: f64,
    script_ms: f64,
    metrics_sent: bool,
    first_frame_costs: Option<(f64, f64)>,
    /// `<!DOCTYPE>` of the document (for a JS runtime created later, see `ensure_runtime`).
    doctype: Option<(String, String, String)>,
}

pub struct RendererConfig {
    pub user_agent: String,
    pub profile_dir: PathBuf,
    pub javascript: bool,
    pub verbose_console: bool,
}

pub struct Renderer {
    shared: Arc<Shared>,
    net: NetClient,
    rx: Receiver<LoopMsg>,
    config: RendererConfig,
    viewport: ViewportInfo,
    page: Option<Page>,
    generation: u64,
    nav_request: Option<u64>,
    pending_nav_url: Option<String>,
    frame_seq: u64,
    last_frame: Instant,
    sent: SentResources,
    font_ctx: Option<FontContext>,
    last_mouse: (f32, f32),
    pending_capture: Option<(u64, u32)>,
    /// Last user input: while the user interacts, frames are produced at full rate even if
    /// the page is still loading.
    last_input: Option<Instant>,
}

impl Renderer {
    pub fn new(
        browser: IpcSender<FromRenderer>,
        loop_tx: Sender<LoopMsg>,
        rx: Receiver<LoopMsg>,
        net: NetClient,
        viewport: ViewportInfo,
        config: RendererConfig,
    ) -> Self {
        let shared = Arc::new(Shared {
            loop_tx,
            browser,
            redraw: AtomicBool::new(false),
            pending_resources: AtomicUsize::new(0),
            cursor: std::sync::Mutex::new(None),
        });
        Self {
            shared,
            net,
            rx,
            config,
            viewport,
            page: None,
            generation: 0,
            nav_request: None,
            pending_nav_url: None,
            frame_seq: 0,
            last_frame: Instant::now() - FRAME_INTERVAL,
            sent: SentResources::default(),
            font_ctx: None,
            last_mouse: (-1.0, -1.0),
            pending_capture: None,
            last_input: None,
        }
    }

    fn send(&self, msg: FromRenderer) {
        self.shared.send(msg);
    }

    /// Run the event loop until the browser disconnects or sends `Shutdown`.
    pub fn run(mut self) {
        self.send(FromRenderer::Ready);
        loop {
            let deadline = self.next_deadline();
            let msg = match deadline {
                Some(d) => match self.rx.recv_deadline(d) {
                    Ok(m) => Some(m),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match self.rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => break,
                },
            };
            if let Some(m) = msg {
                if !self.handle(m) {
                    break;
                }
                // Drain everything that is already queued before doing expensive work.
                while let Ok(m) = self.rx.try_recv() {
                    if !self.handle(m) {
                        self.shutdown();
                        return;
                    }
                }
            }
            self.tick();
        }
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(mut page) = self.page.take() {
            if let Some(rt) = page.rt.as_mut() {
                rt.page_hide(&mut page.doc);
            }
        }
    }

    fn viewport(&self) -> Viewport {
        let mut v = Viewport::new(
            self.viewport.width,
            self.viewport.height,
            self.viewport.scale,
            if self.viewport.dark_mode {
                ColorScheme::Dark
            } else {
                ColorScheme::Light
            },
        );
        v.set_zoom(self.viewport.zoom);
        v
    }

    fn needs_frame(&self) -> bool {
        let Some(page) = &self.page else { return false };
        self.shared.redraw.load(Ordering::SeqCst)
            || page.rt.as_ref().is_some_and(|rt| rt.wants_frame())
            || page.doc.is_animating()
            || self.pending_capture.is_some()
    }

    fn next_deadline(&self) -> Option<Instant> {
        let mut deadline: Option<Instant> = None;
        let mut min = |t: Instant| {
            deadline = Some(match deadline {
                Some(d) if d < t => d,
                _ => t,
            })
        };
        if let Some(page) = &self.page {
            if let Some(t) = page.rt.as_ref().and_then(|rt| rt.next_timer_deadline()) {
                min(t);
            }
            if !page.load_sent {
                min(Instant::now() + Duration::from_millis(50));
            }
        }
        if self.needs_frame() {
            min(self.last_frame + self.frame_interval());
        }
        deadline
    }

    fn frame_interval(&self) -> Duration {
        let interacting = self
            .last_input
            .is_some_and(|t| t.elapsed() < Duration::from_millis(1000));
        match &self.page {
            Some(p) if !p.load_sent && p.first_frame_costs.is_some() && !interacting => {
                LOADING_FRAME_INTERVAL
            }
            _ => FRAME_INTERVAL,
        }
    }

    // -----------------------------------------------------------------------
    // Message handling
    // -----------------------------------------------------------------------

    /// Returns false when the loop must stop.
    fn handle(&mut self, msg: LoopMsg) -> bool {
        match msg {
            LoopMsg::Browser(None) => return false,
            LoopMsg::Browser(Some(m)) => return self.handle_browser(m),
            LoopMsg::Document { generation, resp } => {
                if generation == self.generation {
                    self.nav_request = None;
                    self.commit_navigation(resp);
                }
            }
            LoopMsg::ScriptFetch { generation, resp } => {
                if let Some(page) = &mut self.page {
                    if page.generation == generation {
                        page.host.inflight.borrow_mut().remove(&resp.id);
                        if let Some(rt) = page.rt.as_mut() {
                            rt.deliver_fetch(&mut page.doc, resp);
                        }
                    }
                }
            }
            LoopMsg::Wake => {}
        }
        true
    }

    fn handle_browser(&mut self, msg: ToRenderer) -> bool {
        match msg {
            ToRenderer::Init { .. } => {}
            ToRenderer::Navigate {
                url,
                method,
                body,
                content_type,
            } => self.navigate(url, method, body, content_type),
            ToRenderer::LoadHtml { url, html } => {
                self.generation += 1;
                self.load_html(&url, &html, String::new());
            }
            ToRenderer::Stop => {
                if let Some(id) = self.nav_request.take() {
                    self.net.abort(id);
                    self.generation += 1;
                }
            }
            ToRenderer::Reload => {
                if let Some(url) = self.page.as_ref().map(|p| p.url.clone()) {
                    self.navigate(url, "GET".into(), None, None);
                }
            }
            ToRenderer::Resize(vp) => {
                self.viewport = vp;
                let v = self.viewport();
                if let Some(page) = &mut self.page {
                    page.doc.set_viewport(v);
                    if let Some(rt) = page.rt.as_mut() {
                        rt.viewport_changed(&mut page.doc);
                    }
                }
                self.shared.redraw.store(true, Ordering::SeqCst);
            }
            ToRenderer::Input(ev) => self.handle_input(ev),
            ToRenderer::ScrollTo { x, y } => {
                self.last_input = Some(Instant::now());
                if let Some(page) = &mut self.page {
                    let vp = page.doc.viewport().clone();
                    let css_w = vp.window_size.0 as f64 / vp.scale_f64();
                    let css_h = vp.window_size.1 as f64 / vp.scale_f64();
                    let (cw, ch) = document_content_size(&page.doc);
                    let max_x = (cw as f64 - css_w).max(0.0);
                    let max_y = (ch as f64 - css_h).max(0.0);
                    page.doc.set_viewport_scroll(blitz_dom::Point {
                        x: x.clamp(0.0, max_x),
                        y: y.clamp(0.0, max_y),
                    });
                    let s = page.doc.viewport_scroll();
                    if (s.x, s.y) != page.last_scroll {
                        page.last_scroll = (s.x, s.y);
                        if let Some(rt) = page.rt.as_mut() {
                            rt.scrolled(&mut page.doc);
                        }
                    }
                    self.shared.redraw.store(true, Ordering::SeqCst);
                }
            }
            ToRenderer::Eval { id, source } => {
                self.ensure_runtime();
                let (ok, value) = match &mut self.page {
                    Some(Page {
                        rt: Some(rt), doc, ..
                    }) => match rt.eval(doc, &source) {
                        Ok(v) => (true, v),
                        Err(e) => (false, e),
                    },
                    _ => (false, "no JavaScript context".into()),
                };
                self.shared.redraw.store(true, Ordering::SeqCst);
                self.send(FromRenderer::EvalResult { id, ok, value });
            }
            ToRenderer::GetDom { id } => {
                let html = match &self.page {
                    Some(page) => match page.doc.try_root_element() {
                        Some(root) => format!("<!DOCTYPE html>\n{}", root.outer_html()),
                        None => String::new(),
                    },
                    None => String::new(),
                };
                self.send(FromRenderer::Dom { id, html });
            }
            ToRenderer::CaptureFullPage { id, max_height } => {
                self.pending_capture = Some((id, max_height));
            }
            ToRenderer::HistoryTraverse { url, index } => {
                if let Some(page) = &mut self.page {
                    page.url = url.clone();
                    match page.rt.as_mut() {
                        Some(rt) => rt.history_traversed(&mut page.doc, &url, index),
                        None => {
                            if let Some(frag) = url::Url::parse(&url).ok().and_then(|u| u.fragment().map(str::to_string)) {
                                page.doc.scroll_to_fragment(&frag);
                            }
                        }
                    }
                    self.shared.send(FromRenderer::UrlChanged(url));
                    self.shared.redraw.store(true, Ordering::SeqCst);
                }
            }
            ToRenderer::Shutdown => return false,
        }
        true
    }

    fn handle_input(&mut self, ev: InputEvent) {
        let is_move = matches!(ev, InputEvent::MouseMove { .. });
        if !is_move {
            self.last_input = Some(Instant::now());
        }
        let Some(page) = &mut self.page else { return };
        let scroll = page.doc.viewport_scroll();
        let scroll = (scroll.x, scroll.y);

        // Wheel scrolling targets the hovered node: make sure hover is current.
        if let InputEvent::Wheel { x, y, mods, .. } = &ev {
            if (*x, *y) != self.last_mouse {
                let mv = InputEvent::MouseMove {
                    x: *x,
                    y: *y,
                    buttons: 0,
                    mods: *mods,
                };
                if let Some(ui) = to_ui_event(&mv, scroll) {
                    dispatch(page, ui);
                }
            }
        }
        match &ev {
            InputEvent::MouseMove { x, y, .. }
            | InputEvent::MouseDown { x, y, .. }
            | InputEvent::MouseUp { x, y, .. }
            | InputEvent::Wheel { x, y, .. } => self.last_mouse = (*x, *y),
            InputEvent::MouseLeave => {
                page.doc.clear_hover();
                self.shared.redraw.store(true, Ordering::SeqCst);
                return;
            }
            _ => {}
        }
        if let Some(ui) = to_ui_event(&ev, scroll) {
            dispatch(page, ui);
        }

        // Cursor
        let cursor = page.doc.get_cursor();
        blitz_traits::shell::ShellProvider::set_cursor(
            &Shell {
                shared: self.shared.clone(),
            },
            cursor,
        );

        // Scroll notifications for JS
        let s = page.doc.viewport_scroll();
        let scrolled = (s.x, s.y) != page.last_scroll;
        if scrolled {
            page.last_scroll = (s.x, s.y);
            if let Some(rt) = page.rt.as_mut() {
                rt.scrolled(&mut page.doc);
            }
        }
        // Pointer moves only need a new frame when something changed: hover changes and
        // DOM mutations by event handlers request one themselves.
        if !is_move || scrolled {
            self.shared.redraw.store(true, Ordering::SeqCst);
        }
    }

    // -----------------------------------------------------------------------
    // Navigation & document loading
    // -----------------------------------------------------------------------

    fn navigate(
        &mut self,
        url: String,
        method: String,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
    ) {
        // Same-document fragment navigation: just scroll.
        if method.eq_ignore_ascii_case("GET") {
            if let (Some(page), Ok(new)) = (&mut self.page, url::Url::parse(&url)) {
                if let Ok(cur) = url::Url::parse(&page.url) {
                    let mut a = cur.clone();
                    a.set_fragment(None);
                    let mut b = new.clone();
                    b.set_fragment(None);
                    if a == b && new.fragment().is_some() && cur.as_str() != new.as_str() {
                        let frag = new.fragment().unwrap_or("").to_string();
                        page.url = url.clone();
                        page.doc.scroll_to_fragment(&frag);
                        self.send(FromRenderer::UrlChanged(url));
                        self.shared.redraw.store(true, Ordering::SeqCst);
                        return;
                    }
                }
            }
        }

        if let Some(id) = self.nav_request.take() {
            self.net.abort(id);
        }
        self.generation += 1;
        let generation = self.generation;

        if url == "about:blank" || url.is_empty() {
            self.load_html("about:blank", "<!DOCTYPE html><html><head></head><body></body></html>", String::new());
            return;
        }

        self.send(FromRenderer::Load {
            event: LoadEvent::Started,
            url: url.clone(),
            error: None,
        });
        let mut req = NetRequest::get(0, url.clone(), Destination::Document);
        req.method = method;
        req.body = body;
        if let Some(ct) = content_type {
            req.headers.push(("Content-Type".into(), ct));
        }
        req.referrer = self.page.as_ref().map(|p| p.url.clone()).filter(|u| u.starts_with("http"));
        let tx = self.shared.loop_tx.clone();
        self.pending_nav_url = Some(url);
        let id = self.net.fetch(
            req,
            Box::new(move |resp| {
                let _ = tx.send(LoopMsg::Document { generation, resp });
            }),
        );
        self.nav_request = Some(id);
    }

    fn commit_navigation(&mut self, resp: NetResponse) {
        let requested = self.pending_nav_url.take().unwrap_or_default();
        let referrer = self.page.as_ref().map(|p| p.url.clone()).unwrap_or_default();
        if let Some(err) = &resp.error {
            let html = error_page(&requested, err);
            self.load_html(&requested, &html, referrer);
            self.send(FromRenderer::Load {
                event: LoadEvent::Failed,
                url: requested,
                error: Some(err.clone()),
            });
            return;
        }
        let url = if resp.url.is_empty() { requested } else { resp.url.clone() };
        let ct = resp.header("content-type").map(|s| s.to_string());
        let kind = decode::classify(ct.as_deref(), &url, &resp.body);
        let html = match kind {
            DocKind::Html | DocKind::Xhtml => decode::decode_body(&resp.body, ct.as_deref()),
            DocKind::Svg => format!(
                "<!DOCTYPE html><html><body style=\"margin:0\">{}</body></html>",
                decode::decode_body(&resp.body, ct.as_deref())
            ),
            DocKind::Image => format!(
                "<!DOCTYPE html><html><head><title>{t}</title></head><body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0e0e0e\"><img src=\"{u}\" style=\"max-width:100%;max-height:100vh\"></body></html>",
                t = decode::escape_html(url.rsplit('/').next().unwrap_or(&url)),
                u = decode::escape_html(&url)
            ),
            DocKind::Text => format!(
                "<!DOCTYPE html><html><body><pre style=\"word-wrap:break-word;white-space:pre-wrap;font-family:monospace\">{}</pre></body></html>",
                decode::escape_html(&decode::decode_body(&resp.body, ct.as_deref()))
            ),
            DocKind::Other => {
                let t = common::i18n::localize(&common::resources::text("pages/unsupported.html"));
                common::resources::fill(
                    &t,
                    &[
                        ("url", &decode::escape_html(&url)),
                        (
                            "type",
                            &decode::escape_html(ct.as_deref().unwrap_or(common::i18n::t("file.unknown"))),
                        ),
                    ],
                )
            }
        };
        self.load_html(&url, &html, referrer);
    }

    fn document_config(&mut self, url: &str) -> DocumentConfig {
        let shared = self.shared.clone();
        let waker_shared = self.shared.clone();
        let provider = netstack::BlitzNetProvider::new(
            self.net.clone(),
            Arc::new(move || waker_shared.wake()),
        );
        if self.font_ctx.is_none() {
            let mut font_ctx = FontContext::default();
            // Arial/Times New Roman defaults and metric-compatible substitutes, as in
            // other browsers (page layouts depend on these metrics).
            blitz_dom::apply_web_font_defaults(&mut font_ctx);
            self.font_ctx = Some(font_ctx);
        }
        let mut config = DocumentConfig {
            viewport: Some(self.viewport()),
            base_url: Some(url.to_string()),
            net_provider: Some(Arc::new(CountingNetProvider {
                inner: provider,
                shared: shared.clone(),
            })),
            navigation_provider: Some(Arc::new(NavProvider {
                shared: shared.clone(),
            })),
            shell_provider: Some(Arc::new(Shell { shared })),
            font_ctx: self.font_ctx.clone(),
            // One document per renderer process: use Stylo's parallel (rayon) traversal.
            style_threading: blitz_dom::StyleThreading::Parallel,
            ..Default::default()
        };
        script::configure_document(&mut config);
        config
    }

    fn load_html(&mut self, url: &str, html: &str, referrer: String) {
        let t0 = Instant::now();
        // Tear down the old page first: V8 isolates must be dropped before new ones exist.
        if let Some(mut old) = self.page.take() {
            if let Some(rt) = old.rt.as_mut() {
                rt.page_hide(&mut old.doc);
            }
            drop(old);
        }
        self.shared.pending_resources.store(0, Ordering::SeqCst);
        // New document => new resource ids on the compositor side are fine, but keep the
        // "already sent" set: fonts are shared across documents.

        let config = self.document_config(url);
        let doc = parse_document(html, config, self.config.javascript);
        let parse_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let host = Rc::new(RendererHost {
            shared: self.shared.clone(),
            net: self.net.clone(),
            generation: self.generation,
            inflight: RefCell::new(HashMap::new()),
            referrer,
            verbose_console: self.config.verbose_console,
            title: RefCell::new(String::new()),
            history: Cell::new((0, 1)),
        });

        let mut page = Page {
            doc,
            rt: None,
            host: host.clone(),
            url: url.to_string(),
            generation: self.generation,
            created: Instant::now(),
            load_sent: false,
            dcl_sent: false,
            last_ready_check: Instant::now(),
            last_scroll: (0.0, 0.0),
            last_title: String::new(),
            parse_ms,
            script_ms: 0.0,
            metrics_sent: false,
            first_frame_costs: None,
            doctype: script::parse_doctype(html),
        };
        if self.config.javascript {
            // Scripting is on: <noscript> content must not render.
            page.doc
                .add_user_agent_stylesheet("noscript { display: none !important; }");
        }

        self.send(FromRenderer::UrlChanged(url.to_string()));
        page.last_title = document_title(&page.doc);
        self.send(FromRenderer::Title(page.last_title.clone()));

        common::trace::mark("renderer: document parsed");
        let t1 = Instant::now();
        // A JS runtime (V8 isolate + DOM layer: 50-200 ms) is only created for documents
        // that can run script. Others — like the new tab page — paint right away; a
        // runtime is created later if something needs one (`ensure_runtime`).
        if self.config.javascript && document_uses_script(&page.doc) {
            let rt = self.create_runtime(&mut page);
            page.rt = Some(rt);
            common::trace::mark("renderer: scripts started (runtime ready)");
        } else {
            common::trace::mark("renderer: no scripts, no JS runtime needed");
        }
        page.script_ms = t1.elapsed().as_secs_f64() * 1000.0;

        self.page = Some(page);
        self.shared.redraw.store(true, Ordering::SeqCst);
    }

    fn create_runtime(&self, page: &mut Page) -> ScriptRuntime {
        let mut rt = ScriptRuntime::new(
            page.host.clone(),
            RuntimeOptions {
                document_url: page.url.clone(),
                user_agent: self.config.user_agent.clone(),
                profile_dir: self.config.profile_dir.clone(),
                load_js_layer: true,
            },
        );
        rt.set_doctype(
            page.doctype
                .as_ref()
                .map(|(a, b, c)| (a.as_str(), b.as_str(), c.as_str())),
        );
        rt.document_parsed(&mut page.doc);
        rt
    }

    /// Create the JS runtime of a script-less page on demand (e.g. for `Eval`).
    fn ensure_runtime(&mut self) {
        if !self.config.javascript {
            return;
        }
        let Some(mut page) = self.page.take() else { return };
        if page.rt.is_none() {
            let mut rt = self.create_runtime(&mut page);
            if self.shared.pending_resources.load(Ordering::SeqCst) == 0 {
                rt.resources_loaded(&mut page.doc);
            }
            page.rt = Some(rt);
        }
        self.page = Some(page);
    }

    // -----------------------------------------------------------------------
    // Periodic work: timers, load state, frames
    // -----------------------------------------------------------------------

    fn tick(&mut self) {
        let now = Instant::now();
        if let Some(page) = &mut self.page {
            // Timers
            if let Some(rt) = page.rt.as_mut() {
                if rt.next_timer_deadline().is_some_and(|d| d <= now) {
                    rt.run_timers(&mut page.doc);
                    self.shared.redraw.store(true, Ordering::SeqCst);
                }
            }

            // `load`/`error` events of <img>, <link rel=stylesheet> and <iframe>: apply the
            // finished subresources now (not only at the next frame) and tell the page.
            page.doc.handle_messages();
            let events = page.doc.take_element_load_events();
            if !events.is_empty() {
                if let Some(rt) = page.rt.as_mut() {
                    for (node, ok) in events {
                        rt.element_event(&mut page.doc, node, if ok { "load" } else { "error" });
                    }
                }
                self.shared.redraw.store(true, Ordering::SeqCst);
            }

            let pending = self.shared.pending_resources.load(Ordering::SeqCst);

            // Load state
            if !page.load_sent && page.last_ready_check.elapsed() >= Duration::from_millis(40) {
                page.last_ready_check = Instant::now();
                // Subresources finished? Tell JS (idempotent; it fires `load` once both
                // DOMContentLoaded happened and nothing is pending). Checked periodically
                // rather than on transitions: a fetch can start and finish between ticks.
                if pending == 0 {
                    if let Some(rt) = page.rt.as_mut() {
                        rt.resources_loaded(&mut page.doc);
                    }
                }
                let ready = match page.rt.as_mut() {
                    Some(rt) => rt
                        .eval(&mut page.doc, "document.readyState")
                        .unwrap_or_default(),
                    None => "\"complete\"".into(),
                };
                if !page.dcl_sent && (ready.contains("interactive") || ready.contains("complete")) {
                    page.dcl_sent = true;
                    self.shared.send(FromRenderer::Load {
                        event: LoadEvent::DomContentLoaded,
                        url: page.url.clone(),
                        error: None,
                    });
                }
                if std::env::var_os("BROWSER_DEBUG_LOAD").is_some()
                    && page.created.elapsed().as_millis() % 1000 < 45
                {
                    eprintln!(
                        "[load-debug] ready={ready} pending={pending} critical={}",
                        page.doc.has_pending_critical_resources()
                    );
                }
                if ready.contains("complete")
                    && pending == 0
                    && !page.doc.has_pending_critical_resources()
                {
                    page.load_sent = true;
                    self.shared.send(FromRenderer::Load {
                        event: LoadEvent::Load,
                        url: page.url.clone(),
                        error: None,
                    });
                    self.shared.redraw.store(true, Ordering::SeqCst);
                }
            }
        }

        if self.needs_frame() && now >= self.last_frame + self.frame_interval() {
            self.produce_frame();
        }
    }

    fn produce_frame(&mut self) {
        let base_viewport = self.viewport();
        let Some(page) = &mut self.page else { return };
        let t0 = Instant::now();
        self.shared.redraw.store(false, Ordering::SeqCst);
        self.last_frame = t0;

        if let Some(rt) = page.rt.as_mut() {
            if rt.wants_frame() {
                let ts = page.created.elapsed().as_secs_f64() * 1000.0;
                rt.run_frame(&mut page.doc, ts);
            }
        }

        page.doc.resolve(script::animation_time());
        if page.doc.has_pending_critical_resources()
            && page.created.elapsed() < RENDER_BLOCK_TIMEOUT
        {
            // Keep polling until stylesheets arrive.
            self.shared.redraw.store(true, Ordering::SeqCst);
            return;
        }
        let style_layout_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let vp = self.viewport;
        let scale = page.doc.viewport().scale_f64();
        let (root_w, root_h) = document_content_size(&page.doc);
        let css_w = vp.width as f32 / scale as f32;
        let css_h = vp.height as f32 / scale as f32;
        let content_width = root_w.max(css_w);
        let content_height = root_h.max(css_h);

        // Full-page capture: temporarily enlarge the viewport.
        let capture = self.pending_capture.take();
        let (width, height) = match capture {
            Some((_, max_h)) => {
                let h = ((content_height as f64 * scale) as u32).min(max_h.max(vp.height));
                (vp.width, h)
            }
            None => (vp.width, vp.height),
        };
        let saved_scroll = page.doc.viewport_scroll();
        if capture.is_some() {
            let mut v = page.doc.viewport().clone();
            v.window_size = (width, height);
            page.doc.set_viewport(v);
            page.doc.set_viewport_scroll(blitz_dom::Point { x: 0.0, y: 0.0 });
            page.doc.resolve(script::animation_time());
        }

        let t1 = Instant::now();
        let mut rec = DisplayListRecorder::new(&mut self.sent);
        blitz_paint::paint_scene(&mut rec, &mut page.doc, scale, width, height, 0, 0);
        let list = rec.finish();
        let paint_ms = t1.elapsed().as_secs_f64() * 1000.0;

        let title = document_title(&page.doc);
        if title != page.last_title {
            page.last_title = title.clone();
            self.shared.send(FromRenderer::Title(title));
        }

        let scroll = page.doc.viewport_scroll();
        self.frame_seq += 1;
        let frame = Frame {
            seq: self.frame_seq,
            width,
            height,
            scale: scale as f32,
            content_width,
            content_height,
            scroll_x: scroll.x as f32,
            scroll_y: scroll.y as f32,
            capture_id: capture.map(|c| c.0),
            list,
        };
        self.shared.send(FromRenderer::Frame(Box::new(frame)));

        if capture.is_some() {
            page.doc.set_viewport(base_viewport);
            page.doc.set_viewport_scroll(saved_scroll);
            self.shared.redraw.store(true, Ordering::SeqCst);
        }
        if page.first_frame_costs.is_none() {
            page.first_frame_costs = Some((style_layout_ms, paint_ms));
        }
        if !page.metrics_sent && page.load_sent {
            page.metrics_sent = true;
            let (sl, p) = page.first_frame_costs.unwrap_or((style_layout_ms, paint_ms));
            self.shared.send(FromRenderer::Metrics {
                parse_ms: page.parse_ms,
                script_ms: page.script_ms,
                style_layout_ms: sl,
                paint_ms: p,
            });
        }
    }
}

/// Scrollable size of the document in CSS px: the root box or its overflowing content
/// (pages often set `html, body { height: 100% }` and overflow).
fn document_content_size(doc: &BaseDocument) -> (f32, f32) {
    match doc.try_root_element() {
        Some(root) => {
            let l = root.final_layout();
            (
                l.size.width.max(root.scroll_width()),
                l.size.height.max(root.scroll_height()),
            )
        }
        None => (0.0, 0.0),
    }
}

fn document_title(doc: &BaseDocument) -> String {
    doc.find_title_node()
        .map(|n| n.text_content().split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// Parse an HTML document with html5ever. Unlike `HtmlDocument::from_html` this honours
/// the scripting flag: with JavaScript enabled, `<noscript>` content is raw text (as in
/// every browser), so e.g. `<noscript><style>body{display:none}</style></noscript>` is inert.
fn parse_document(html: &str, config: DocumentConfig, scripting: bool) -> BaseDocument {
    use html5ever::tendril::TendrilSink;
    let trimmed = html.trim_start_matches('\u{feff}').trim_start();
    if trimmed.starts_with("<?xml") {
        return HtmlDocument::from_xml(html, config).into_inner();
    }
    let mut config = config;
    if let Some(ss) = &mut config.ua_stylesheets {
        if !ss.iter().any(|s| s == blitz_dom::DEFAULT_CSS) {
            ss.push(blitz_dom::DEFAULT_CSS.to_string());
        }
    }
    let mut doc = BaseDocument::new(config);
    {
        let mut mutr = doc.mutate();
        let sink = blitz_html::DocumentHtmlParser::new(&mut mutr);
        let opts = html5ever::ParseOpts {
            tokenizer: Default::default(),
            tree_builder: html5ever::tree_builder::TreeBuilderOpts {
                exact_errors: false,
                scripting_enabled: scripting,
                iframe_srcdoc: false,
                drop_doctype: true,
                quirks_mode: html5ever::tree_builder::QuirksMode::NoQuirks,
            },
        };
        let _ = html5ever::parse_document(sink, opts)
            .from_utf8()
            .read_from(&mut html.as_bytes());
    }
    doc
}

fn dispatch(page: &mut Page, ui: blitz_traits::events::UiEvent) {
    match page.rt.as_mut() {
        Some(rt) => {
            let mut driver = EventDriver::new(&mut page.doc, JsEventHandler { runtime: rt });
            driver.handle_ui_event(ui);
        }
        None => {
            let mut driver = EventDriver::new(&mut page.doc, NoopEventHandler);
            driver.handle_ui_event(ui);
        }
    }
}

/// Whether a document can run script: script elements, inline event handlers or
/// `javascript:` URLs.
fn document_uses_script(doc: &BaseDocument) -> bool {
    doc.tree().iter().any(|(_, node)| {
        if node.data.is_element_with_tag_name(&blitz_dom::local_name!("script")) {
            return true;
        }
        node.data.attrs().is_some_and(|attrs| {
            attrs.iter().any(|a| {
                let name = a.name.local.as_ref();
                let js_url = matches!(name, "href" | "src" | "action" | "formaction")
                    && a.value
                        .trim_start()
                        .get(..11)
                        .is_some_and(|p| p.eq_ignore_ascii_case("javascript:"));
                (name.len() > 2 && name.starts_with("on")) || js_url
            })
        })
    })
}

fn error_page(url: &str, err: &str) -> String {
    let t = common::i18n::localize(&common::resources::text("pages/error.html"));
    common::resources::fill(
        &t,
        &[
            ("url", &common::resources::escape_html(url)),
            ("error", &common::resources::escape_html(err)),
        ],
    )
}

/// Entry point of a `--type=renderer` process (or thread in single-process mode).
pub fn renderer_main(endpoint: &str, verbose_console: bool) {
    common::trace::mark("renderer: start");
    let conn = match ipc::connect_retry(endpoint, Duration::from_secs(10)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[renderer] cannot connect to browser: {e}");
            return;
        }
    };
    let (loop_tx, loop_rx) = crossbeam_channel::unbounded::<LoopMsg>();
    let tx2 = loop_tx.clone();
    let browser: IpcSender<FromRenderer> =
        conn.split("renderer-ipc", move |msg: Option<ToRenderer>| {
            let _ = tx2.send(LoopMsg::Browser(msg));
        });

    // Wait for Init.
    let (net_endpoint, viewport, user_agent, profile_dir, javascript) = loop {
        match loop_rx.recv() {
            Ok(LoopMsg::Browser(Some(ToRenderer::Init {
                net_endpoint,
                viewport,
                user_agent,
                profile_dir,
                javascript,
            }))) => break (net_endpoint, viewport, user_agent, profile_dir, javascript),
            Ok(LoopMsg::Browser(None)) | Err(_) => return,
            _ => continue,
        }
    };
    common::trace::mark("renderer: init received");
    let net = match netstack_connect(&net_endpoint) {
        Some(n) => n,
        None => {
            eprintln!("[renderer] cannot connect to network service");
            return;
        }
    };
    let renderer = Renderer::new(
        browser,
        loop_tx,
        loop_rx,
        net,
        viewport,
        RendererConfig {
            user_agent,
            profile_dir: PathBuf::from(profile_dir),
            javascript,
            verbose_console,
        },
    );
    renderer.run();
}

fn netstack_connect(endpoint: &str) -> Option<NetClient> {
    let start = Instant::now();
    loop {
        match NetClient::connect(endpoint) {
            Ok(c) => return Some(c),
            Err(_) if start.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Err(_) => return None,
        }
    }
}
