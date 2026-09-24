//! Windowed browser UI.
//!
//! * Window + input: winit
//! * Compositor: Vello on the GPU via wgpu (Vulkan/Metal/DX12), vello_cpu + softbuffer as
//!   fallback when no hardware GPU is usable (or `BROWSER_RENDERER=cpu`).
//! * Startup: the window is created hidden and shown with its first frame. The GPU
//!   compositor initialises on a background thread; if that takes longer than
//!   [`GPU_WAIT`], the first frames are rendered on the CPU and the GPU takes over when
//!   ready. Renderer and network processes start in the background too, so the UI thread
//!   never blocks during startup.
//! * Browser chrome (tabs, toolbar, address bar): an HTML/CSS document rendered by Blitz
//!   in this process (see [`chrome`]).
//! * Page content: display lists received from the tab's renderer process, replayed into
//!   the same Vello scene below the chrome.

pub mod chrome;
mod keys;

use anyrender::{PaintScene, WindowRenderer};
use browser::{Browser, BrowserEvent, BrowserOptions, TabId};
use chrome::{Action, CHROME_HEIGHT, Chrome, TabView, ToolbarView};
use common::protocol::{CursorKind, FromRenderer, InputEvent, Modifiers, ToRenderer, ViewportInfo};
use kurbo::{Affine, Rect};
use peniko::{Color, Fill};
use anyrender_vello::{VelloRendererOptions, VelloWindowRenderer};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{CursorIcon, Window, WindowId};

pub const HOME_URL: &str = "about:newtab";

enum UserEvent {
    Browser(BrowserEvent),
    Redraw,
    /// A newer version was installed in the background.
    UpdateReady(String),
    /// The GPU compositor finished (or failed) initialising in the background.
    GpuReady,
}

/// How long the hidden window waits for the GPU compositor before its first frames are
/// rendered on the CPU instead (the GPU takes over once ready). On Apple platforms Metal
/// initialises quickly and mixing CPU (CALayer) and Metal presentation is avoided.
const GPU_WAIT: Duration = if cfg!(target_vendor = "apple") {
    Duration::from_millis(3000)
} else {
    Duration::from_millis(250)
};

/// Progress bar animation interval while a page loads.
const ANIMATION_INTERVAL: Duration = Duration::from_millis(33);

enum Renderer {
    Gpu(Box<VelloWindowRenderer>),
    Cpu(Box<anyrender_vello_cpu::VelloCpuWindowRenderer>),
}

impl Renderer {
    fn is_active(&self) -> bool {
        match self {
            Renderer::Gpu(r) => r.is_active(),
            Renderer::Cpu(r) => r.is_active(),
        }
    }
    fn set_size(&mut self, w: u32, h: u32) {
        match self {
            Renderer::Gpu(r) => r.set_size(w, h),
            Renderer::Cpu(r) => r.set_size(w, h),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum PointerTarget {
    Chrome,
    Content,
    /// Dragging the viewport scrollbar thumb (value = grab offset within the thumb, px).
    Scrollbar(f64),
}

/// Geometry of the viewport scrollbar thumb in window pixels.
struct ScrollbarGeom {
    thumb: Rect,
    track_top: f64,
    track_len: f64,
    max_scroll: f64,
    scroll_x: f64,
}

fn scrollbar_geom(tab: &browser::Tab, width: u32, height: u32, chrome_px: f64, ui_scale: f64) -> Option<ScrollbarGeom> {
    let frame = tab.frame.as_ref()?;
    let scale = frame.scale as f64;
    if scale <= 0.0 {
        return None;
    }
    let view_h_css = frame.height as f64 / scale;
    let content_h = frame.content_height as f64;
    if content_h <= view_h_css + 1.0 {
        return None;
    }
    let track_top = chrome_px + 2.0 * ui_scale;
    let track_len = (height as f64 - chrome_px) - 4.0 * ui_scale;
    let thumb_len = (track_len * view_h_css / content_h).max(32.0 * ui_scale);
    let max_scroll = content_h - view_h_css;
    let pos = (frame.scroll_y as f64 / max_scroll).clamp(0.0, 1.0) * (track_len - thumb_len);
    let w = 7.0 * ui_scale;
    let x1 = width as f64 - 3.0 * ui_scale;
    Some(ScrollbarGeom {
        thumb: Rect::new(x1 - w, track_top + pos, x1, track_top + pos + thumb_len),
        track_top,
        track_len,
        max_scroll,
        scroll_x: frame.scroll_x as f64,
    })
}

struct App {
    browser: Browser,
    proxy: EventLoopProxy<UserEvent>,
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    chrome: Option<Chrome>,
    active: Option<TabId>,
    size: PhysicalSize<u32>,
    scale: f64,
    mouse: PhysicalPosition<f64>,
    buttons: u8,
    mods: Modifiers,
    capture: Option<PointerTarget>,
    start_urls: Vec<String>,
    zoom: std::collections::HashMap<TabId, f32>,
    last_cursor: Option<CursorIcon>,
    force_cpu: bool,
    fullscreen: bool,
    renderer_kind: &'static str,
    frames_presented: u64,
    ime_enabled: bool,
    debug_events: bool,
    first_content_traced: bool,
    /// GPU compositor still initialising in the background.
    gpu: Option<Box<VelloWindowRenderer>>,
    /// When to stop waiting for the GPU and render the first frames on the CPU.
    cpu_fallback_at: Option<Instant>,
    window_shown: bool,
    /// Next progress-bar animation frame.
    anim_at: Option<Instant>,
    /// Latest pointer move over the page, sent once per event-loop turn (coalescing).
    pending_mouse: Option<InputEvent>,
    /// Whether the pointer is over the page (for MouseLeave).
    pointer_in_content: bool,
    /// Recent renderer restarts per tab (crash-loop protection).
    respawns: HashMap<TabId, (Instant, u32)>,
    /// Start of the current event-loop turn (stall tracing).
    turn_started: Option<Instant>,
    /// Frames presented by the current compositor (tracing).
    frames_by_kind: u64,
    /// (window of measurement start, frames at start, reports so far) (tracing).
    paint_stats: (Instant, u64, u32),
}

fn content_viewport(size: PhysicalSize<u32>, scale: f64, zoom: f32) -> ViewportInfo {
    let chrome_px = (CHROME_HEIGHT as f64 * scale).ceil() as u32;
    ViewportInfo {
        width: size.width.max(1),
        height: size.height.saturating_sub(chrome_px).max(1),
        scale: scale as f32,
        zoom,
        dark_mode: false,
    }
}

fn map_cursor(c: CursorKind) -> CursorIcon {
    match c {
        CursorKind::Default => CursorIcon::Default,
        CursorKind::Pointer => CursorIcon::Pointer,
        CursorKind::Text => CursorIcon::Text,
        CursorKind::Wait => CursorIcon::Wait,
        CursorKind::Progress => CursorIcon::Progress,
        CursorKind::Crosshair => CursorIcon::Crosshair,
        CursorKind::Move => CursorIcon::Move,
        CursorKind::NotAllowed => CursorIcon::NotAllowed,
        CursorKind::Grab => CursorIcon::Grab,
        CursorKind::Grabbing => CursorIcon::Grabbing,
        CursorKind::EwResize => CursorIcon::EwResize,
        CursorKind::NsResize => CursorIcon::NsResize,
        CursorKind::NeswResize => CursorIcon::NeswResize,
        CursorKind::NwseResize => CursorIcon::NwseResize,
        CursorKind::ColResize => CursorIcon::ColResize,
        CursorKind::RowResize => CursorIcon::RowResize,
        CursorKind::Help => CursorIcon::Help,
        CursorKind::ZoomIn => CursorIcon::ZoomIn,
        CursorKind::ZoomOut => CursorIcon::ZoomOut,
        CursorKind::None => CursorIcon::Default,
    }
}

impl App {
    fn chrome_px(&self) -> f64 {
        (CHROME_HEIGHT as f64 * self.scale).ceil()
    }

    fn request_redraw(&self) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }

    fn zoom_of(&self, tab: TabId) -> f32 {
        *self.zoom.get(&tab).unwrap_or(&1.0)
    }

    fn open_tab(&mut self, url: &str) {
        let vp = content_viewport(self.size, self.scale, 1.0);
        match self.browser.new_tab("", vp) {
            Ok(id) => {
                self.active = Some(id);
                self.navigate(id, url);
            }
            Err(e) => eprintln!("[ui] cannot open tab: {e}"),
        }
        self.sync_chrome();
    }

    fn navigate(&mut self, tab: TabId, url: &str) {
        if url == "about:newtab" {
            self.browser.navigate(tab, url);
            self.browser.send(
                tab,
                ToRenderer::LoadHtml {
                    url: "about:newtab".into(),
                    html: newtab_html(),
                },
            );
            self.sync_chrome();
            if let Some(c) = self.chrome.as_mut() {
                c.focus_url();
            }
        } else {
            self.browser.navigate(tab, url);
        }
        self.sync_chrome();
    }

    fn close_tab(&mut self, id: TabId, event_loop: &ActiveEventLoop) {
        let ids = self.browser.tab_ids().to_vec();
        let pos = ids.iter().position(|t| *t == id);
        self.browser.close_tab(id);
        self.zoom.remove(&id);
        if self.active == Some(id) {
            let remaining = self.browser.tab_ids();
            self.active = pos
                .and_then(|p| remaining.get(p).or_else(|| remaining.last()))
                .copied();
            if let Some(a) = self.active {
                let vp = content_viewport(self.size, self.scale, self.zoom_of(a));
                self.browser.resize(a, vp);
            }
        }
        if self.browser.tab_ids().is_empty() {
            event_loop.exit();
        }
        self.sync_chrome();
    }

    fn select_tab(&mut self, id: TabId) {
        if self.browser.tab(id).is_some() && self.active != Some(id) {
            self.active = Some(id);
            let vp = content_viewport(self.size, self.scale, self.zoom_of(id));
            self.browser.resize(id, vp);
            if let Some(c) = self.chrome.as_mut() {
                c.blur();
            }
            self.sync_chrome();
        }
    }

    fn set_zoom(&mut self, zoom: f32) {
        if let Some(a) = self.active {
            let z = zoom.clamp(0.25, 5.0);
            self.zoom.insert(a, z);
            let vp = content_viewport(self.size, self.scale, z);
            self.browser.resize(a, vp);
            self.sync_chrome();
        }
    }

    fn sync_chrome(&mut self) {
        let Some(chrome) = self.chrome.as_mut() else { return };
        let tabs: Vec<TabView> = self
            .browser
            .tab_ids()
            .iter()
            .filter_map(|id| self.browser.tab(*id))
            .map(|t| TabView {
                id: t.id,
                title: t.title.clone(),
                loading: t.loading,
                crashed: t.crashed,
            })
            .collect();
        chrome.set_tabs(&tabs, self.active);
        if let Some(tab) = self.active.and_then(|a| self.browser.tab(a)) {
            let view = ToolbarView {
                tab: tab.id,
                url: tab.url.clone(),
                can_back: tab.can_go_back(),
                can_forward: tab.can_go_forward(),
                loading: tab.loading,
                zoom: *self.zoom.get(&tab.id).unwrap_or(&1.0),
                secure: tab.url.starts_with("https://") || tab.url.starts_with("about:"),
            };
            chrome.set_toolbar(&view);
            if let Some(w) = &self.window {
                let title = if tab.title.is_empty() { tab.url.clone() } else { tab.title.clone() };
                w.set_title(&title);
            }
        }
        self.request_redraw();
    }

    fn run_actions(&mut self, actions: Vec<Action>, event_loop: &ActiveEventLoop) {
        for a in actions {
            match a {
                Action::NewTab => self.open_tab(HOME_URL),
                Action::SelectTab(id) => self.select_tab(id),
                Action::CloseTab(id) => self.close_tab(id, event_loop),
                Action::Back => {
                    if let Some(t) = self.active {
                        self.browser.go(t, -1)
                    }
                }
                Action::Forward => {
                    if let Some(t) = self.active {
                        self.browser.go(t, 1)
                    }
                }
                Action::Reload => {
                    if let Some(t) = self.active {
                        let url = self.browser.tab(t).map(|t| t.url.clone()).unwrap_or_default();
                        if url == "about:newtab" {
                            self.navigate(t, &url);
                        } else {
                            self.browser.reload(t)
                        }
                    }
                }
                Action::Stop => {
                    if let Some(t) = self.active {
                        self.browser.stop(t)
                    }
                }
                Action::Home => {
                    if let Some(t) = self.active {
                        self.navigate(t, HOME_URL)
                    }
                }
                Action::Go(text) => {
                    let url = chrome::fixup_input(&text);
                    if let Some(c) = self.chrome.as_mut() {
                        c.blur();
                    }
                    match self.active {
                        Some(t) => self.navigate(t, &url),
                        None => self.open_tab(&url),
                    }
                }
                Action::RevertUrl => {
                    if let Some(c) = self.chrome.as_mut() {
                        c.revert_url();
                    }
                }
                Action::ZoomIn => {
                    let z = self.active.map(|a| self.zoom_of(a)).unwrap_or(1.0);
                    self.set_zoom(next_zoom(z, true));
                }
                Action::ZoomOut => {
                    let z = self.active.map(|a| self.zoom_of(a)).unwrap_or(1.0);
                    self.set_zoom(next_zoom(z, false));
                }
                Action::ZoomReset => self.set_zoom(1.0),
                Action::Restart => {
                    // Start the launcher again (it picks the newly installed version) and
                    // quit this instance.
                    if let Ok(exe) = std::env::current_exe() {
                        let mut cmd = std::process::Command::new(exe);
                        // Don't pin the child to our (old) core library.
                        cmd.env_remove("BROWSER_CORE_PATH");
                        let _ = cmd.spawn();
                    }
                    event_loop.exit();
                }
            }
        }
        self.sync_chrome();
    }

    fn handle_browser_event(&mut self, ev: BrowserEvent) {
        if self.debug_events {
            match &ev {
                BrowserEvent::Tab(_, FromRenderer::Frame(_))
                | BrowserEvent::Renderer { msg: Some(FromRenderer::Frame(_)), .. } => {}
                other => eprintln!("[ui] event {other:?}"),
            }
        }
        let active = self.active;
        let Some(ev) = self.browser.process_event(ev) else {
            // Frames are consumed silently; redraw if it was for the visible tab.
            if active.and_then(|a| self.browser.tab(a)).is_some() {
                self.request_redraw();
            }
            return;
        };
        match ev {
            BrowserEvent::Renderer { .. } => {}
            BrowserEvent::Tab(id, msg) => match msg {
                FromRenderer::Cursor(c) if Some(id) == active => {
                    if self.capture != Some(PointerTarget::Chrome)
                        && self.mouse.y >= self.chrome_px()
                    {
                        self.set_cursor(map_cursor(c));
                    }
                }
                FromRenderer::ImeAllowed(on) if Some(id) == active => {
                    if let Some(w) = &self.window {
                        w.set_ime_allowed(on);
                        self.ime_enabled = on;
                    }
                }
                FromRenderer::UrlChanged(_) => {
                    // A new tab opened by the page (target=_blank) becomes active.
                    if !self.browser.tab_ids().contains(&id) {
                        return;
                    }
                    if Some(id) != active && self.browser.tab(id).map(|t| t.frames) == Some(0) {
                        self.select_tab(id);
                    }
                    self.sync_chrome();
                }
                _ => self.sync_chrome(),
            },
            BrowserEvent::TabCrashed(id) => {
                // Like Chrome's "sad tab": only this tab's renderer died. Start a fresh
                // renderer that shows an error page; the user can reload. A renderer that
                // keeps dying right away (can't start at all) is not restarted forever.
                let url = self.browser.tab(id).map(|t| t.url.clone()).unwrap_or_default();
                let now = Instant::now();
                let entry = self.respawns.entry(id).or_insert((now, 0));
                if now.duration_since(entry.0) > Duration::from_secs(30) {
                    *entry = (now, 0);
                }
                entry.1 += 1;
                let allowed = entry.1 <= 3;
                if !allowed {
                    eprintln!("[ui] renderer for tab {id} keeps crashing; not restarting");
                }
                if allowed && self.browser.tab(id).is_some() {
                    if let Err(e) = self.browser.respawn_tab(id, Some(crash_html(&url))) {
                        eprintln!("[ui] cannot restart renderer: {e}");
                    }
                }
                self.sync_chrome();
            }
        }
    }

    fn set_cursor(&mut self, c: CursorIcon) {
        if self.last_cursor != Some(c) {
            self.last_cursor = Some(c);
            if let Some(w) = &self.window {
                w.set_cursor(c);
            }
        }
    }

    fn content_point(&self) -> (f32, f32) {
        let zoom = self.active.map(|a| self.zoom_of(a)).unwrap_or(1.0) as f64;
        let s = self.scale * zoom;
        (
            (self.mouse.x / s) as f32,
            ((self.mouse.y - self.chrome_px()) / s) as f32,
        )
    }

    fn chrome_pointer(&self, kind: u8, button: u8) -> blitz_traits::events::UiEvent {
        let x = (self.mouse.x / self.scale) as f32;
        let y = (self.mouse.y / self.scale) as f32;
        let ev = match kind {
            0 => InputEvent::MouseMove { x, y, buttons: self.buttons, mods: self.mods },
            1 => InputEvent::MouseDown { x, y, button, buttons: self.buttons, mods: self.mods },
            _ => InputEvent::MouseUp { x, y, button, buttons: self.buttons, mods: self.mods },
        };
        engine::input::to_ui_event(&ev, (0.0, 0.0)).expect("pointer event")
    }

    fn send_content(&mut self, ev: InputEvent) {
        // Keep event order: a pending pointer move goes first.
        self.flush_mouse_move();
        if let Some(a) = self.active {
            self.browser.send(a, ToRenderer::Input(ev));
        }
    }

    /// Pointer moves arrive at the device rate (up to 1000/s); only the latest one per
    /// event-loop turn is sent to the renderer.
    fn queue_mouse_move(&mut self, ev: InputEvent) {
        self.pending_mouse = Some(ev);
    }

    fn flush_mouse_move(&mut self) {
        if let (Some(ev), Some(a)) = (self.pending_mouse.take(), self.active) {
            self.browser.send(a, ToRenderer::Input(ev));
        }
    }

    /// The pointer left the page area (to the browser UI or out of the window).
    fn leave_content(&mut self) {
        if self.pointer_in_content {
            self.pointer_in_content = false;
            self.pending_mouse = None;
            self.send_content(InputEvent::MouseLeave);
        }
    }

    // -----------------------------------------------------------------------
    // Startup: compositor selection and first frame
    // -----------------------------------------------------------------------

    fn start_cpu_renderer(&mut self) {
        let Some(window) = self.window.clone() else { return };
        let mut r = anyrender_vello_cpu::VelloCpuWindowRenderer::new();
        let proxy = self.proxy.clone();
        r.resume(window, self.size.width.max(1), self.size.height.max(1), move || {
            let _ = proxy.send_event(UserEvent::Redraw);
        });
        self.renderer = Some(Renderer::Cpu(Box::new(r)));
        self.renderer_kind = "CPU (vello_cpu)";
        common::trace::mark("ui: CPU compositor ready");
    }

    /// Exists while the GPU initialises: if the process dies there (driver crash), the next
    /// start uses the CPU instead of crashing again.
    fn gpu_marker(&self) -> std::path::PathBuf {
        self.browser.opts.profile_dir.join("GPUCache").join("init-pending")
    }

    /// The background GPU initialisation finished (or failed).
    fn on_gpu_ready(&mut self) {
        let marker = self.gpu_marker();
        let Some(gpu) = self.gpu.as_mut() else { return };
        let t0 = Instant::now();
        let active = gpu.complete_resume();
        if active || !gpu.is_pending() {
            // Initialisation is over (success or clean failure): it didn't crash.
            let _ = std::fs::remove_file(&marker);
        }
        if active {
            if common::trace::enabled() {
                common::trace::mark(&format!(
                    "ui: GPU surface configured in {:.1} ms",
                    t0.elapsed().as_secs_f64() * 1000.0
                ));
            }
            let gpu = self.gpu.take().expect("gpu renderer");
            if let Some(info) = gpu.adapter_info() {
                eprintln!("[ui] compositor: GPU (Vello/wgpu) on {} via {:?}", info.name, info.backend);
            }
            self.renderer_kind = "GPU (Vello/wgpu)";
            self.cpu_fallback_at = None;
            common::trace::mark("ui: GPU compositor ready");
            let previous = self.renderer.replace(Renderer::Gpu(gpu));
            self.frames_by_kind = 0;
            if self.window_shown {
                // Replace the CPU-rendered frame right away.
                self.paint();
            } else {
                self.show_window();
            }
            // The CPU presenter is released only after the GPU frame is on screen.
            drop(previous);
        } else if !gpu.is_pending() {
            let why = gpu.init_error().unwrap_or("unknown error").to_string();
            eprintln!("[ui] GPU compositor unavailable ({why}); rendering on the CPU");
            common::trace::mark("ui: GPU unavailable");
            self.gpu = None;
            self.cpu_fallback_at = None;
            if self.renderer.is_none() {
                self.start_cpu_renderer();
            }
            self.show_window();
        }
    }

    /// Show the (hidden) window together with its first frame.
    fn show_window(&mut self) {
        if self.window_shown || self.renderer.is_none() {
            return;
        }
        let Some(window) = self.window.clone() else { return };
        self.window_shown = true;
        // Windows: show the window cloaked (invisible to the compositor), present the first
        // frame, then uncloak — no blank or white flash, like other browsers.
        #[cfg(windows)]
        let cloaked = win::set_cloaked(&window, true);
        window.set_visible(true);
        self.paint();
        #[cfg(windows)]
        if cloaked {
            win::set_cloaked(&window, false);
        }
        window.request_redraw();
        common::trace::mark("ui: window shown");
    }

    fn pointer_target(&self) -> PointerTarget {
        if let Some(c) = self.capture {
            return c;
        }
        if self.mouse.y < self.chrome_px() {
            PointerTarget::Chrome
        } else {
            PointerTarget::Content
        }
    }

    fn paint(&mut self) {
        let chrome_px = self.chrome_px();
        let width = self.size.width;
        let height = self.size.height;
        let scale = self.scale;
        let Some(chrome) = self.chrome.as_mut() else { return };
        let resolve_start = Instant::now();
        chrome.doc.resolve(0.0);
        if common::trace::enabled() && self.frames_presented < 3 {
            common::trace::mark(&format!(
                "ui: chrome resolve {:.1} ms",
                resolve_start.elapsed().as_secs_f64() * 1000.0
            ));
        }
        let tab = self.active.and_then(|a| self.browser.tab(a));

        fn paint_all(
            scene: &mut impl PaintScene,
            chrome: &mut Chrome,
            tab: Option<&browser::Tab>,
            width: u32,
            height: u32,
            chrome_px: f64,
            scale: f64,
        ) {
            // Content area background. Until the new tab page's first frame arrives, use
            // its background colour so that it doesn't flash white first.
            let placeholder = match tab {
                Some(t) if t.frame.is_none() && t.url == "about:newtab" => {
                    Color::from_rgb8(0xf8, 0xf9, 0xfb)
                }
                _ => Color::WHITE,
            };
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                placeholder,
                None,
                &Rect::new(0.0, chrome_px, width as f64, height as f64),
            );
            if let Some(tab) = tab {
                if let Some(frame) = &tab.frame {
                    let clip = Rect::new(0.0, chrome_px, width as f64, height as f64);
                    scene.push_clip_layer(Affine::IDENTITY, &clip);
                    common::display_list::replay(
                        &frame.list,
                        &tab.resources,
                        scene,
                        Affine::translate((0.0, chrome_px)),
                    );
                    scene.pop_layer();
                }
                if let Some(g) = scrollbar_geom(tab, width, height, chrome_px, scale) {
                    let r = g.thumb.width() / 2.0;
                    scene.fill(
                        Fill::NonZero,
                        Affine::IDENTITY,
                        Color::from_rgba8(0, 0, 0, 90),
                        None,
                        &kurbo::RoundedRect::from_rect(g.thumb, r),
                    );
                }
                if tab.loading {
                    // Thin progress bar under the toolbar.
                    let t = tab
                        .load_started
                        .map(|s| s.elapsed().as_secs_f64())
                        .unwrap_or(0.0);
                    let progress = 1.0 - (-t * 1.2).exp() * 0.9;
                    scene.fill(
                        Fill::NonZero,
                        Affine::IDENTITY,
                        Color::from_rgb8(0x0b, 0x57, 0xd0),
                        None,
                        &Rect::new(0.0, chrome_px, width as f64 * progress, chrome_px + 2.0 * scale),
                    );
                }
            }
            blitz_paint::paint_scene(scene, &mut chrome.doc, scale, width, chrome_px as u32, 0, 0);
        }

        let render_start = Instant::now();
        let gpu_failed = match self.renderer.as_mut() {
            Some(Renderer::Gpu(r)) if r.is_active() => {
                // A lost device (driver reset or crash) makes Vello panic: continue on the
                // CPU instead of taking the browser down.
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    r.render(|scene| paint_all(scene, chrome, tab, width, height, chrome_px, scale))
                }))
                .is_err()
            }
            Some(Renderer::Cpu(r)) if r.is_active() => {
                r.render(|scene| paint_all(scene, chrome, tab, width, height, chrome_px, scale));
                false
            }
            _ => return,
        };
        if gpu_failed {
            eprintln!("[ui] GPU rendering failed; continuing on the CPU");
            self.renderer = None;
            self.start_cpu_renderer();
            self.request_redraw();
            return;
        }
        self.frames_presented += 1;
        self.frames_by_kind += 1;
        if common::trace::enabled() && self.frames_by_kind <= 3 {
            common::trace::mark(&format!(
                "ui: frame {} ({}) rendered in {:.1} ms",
                self.frames_presented,
                self.renderer_kind,
                render_start.elapsed().as_secs_f64() * 1000.0
            ));
        }
        if self.frames_presented == 1 {
            common::trace::mark("ui: first paint presented");
        }
        if !self.first_content_traced && tab.is_some_and(|t| t.frame.is_some()) {
            self.first_content_traced = true;
            common::trace::mark("ui: first page content presented");
        }
        // Keep animating the progress bar while loading (one timer, driven by the event
        // loop — see `about_to_wait`).
        if tab.is_some_and(|t| t.loading) && self.anim_at.is_none() {
            self.anim_at = Some(Instant::now() + ANIMATION_INTERVAL);
        }
    }
}

fn next_zoom(z: f32, up: bool) -> f32 {
    const STEPS: [f32; 13] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
    if up {
        STEPS.iter().copied().find(|s| *s > z + 0.001).unwrap_or(z * 1.25)
    } else {
        STEPS.iter().rev().copied().find(|s| *s < z - 0.001).unwrap_or(z / 1.25)
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        // Hidden until the first frame is ready: never show a blank or frozen window.
        let attrs = Window::default_attributes()
            .with_title(common::i18n::t("tab.new"))
            .with_inner_size(LogicalSize::new(1280.0, 860.0))
            .with_min_inner_size(LogicalSize::new(400.0, 300.0))
            .with_visible(false);
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                eprintln!("[ui] cannot create window: {e}");
                event_loop.exit();
                return;
            }
        };
        self.size = window.inner_size();
        self.scale = window.scale_factor();
        self.window = Some(window.clone());
        common::trace::mark("ui: window created (hidden)");

        // GPU compositor: adapter, device and shader pipelines are set up on a background
        // thread while the UI and the first tab start.
        if !self.force_cpu && gpu_init_crashed_before(&self.gpu_marker()) {
            eprintln!(
                "[ui] GPU initialisation crashed during a previous start; rendering on the CPU \
                 (delete {} to retry)",
                self.gpu_marker().display()
            );
            self.force_cpu = true;
        }
        if !self.force_cpu {
            let marker = self.gpu_marker();
            if let Some(dir) = marker.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&marker, b"GPU initialisation in progress\n");
            // Software "GPUs" (WARP, llvmpipe, SwiftShader) are slower than vello_cpu.
            let allow_software = std::env::var_os("BROWSER_ALLOW_SOFTWARE_GPU").is_some();
            let options = VelloRendererOptions::new()
                .pipeline_cache_dir(self.browser.opts.profile_dir.join("GPUCache"))
                .allow_software_adapter(allow_software);
            let mut gpu = Box::new(VelloWindowRenderer::with_options(options));
            let proxy = self.proxy.clone();
            gpu.resume_in_background(
                window.clone(),
                self.size.width.max(1),
                self.size.height.max(1),
                move || {
                    let _ = proxy.send_event(UserEvent::GpuReady);
                },
            );
            self.gpu = Some(gpu);
            self.cpu_fallback_at = Some(Instant::now() + GPU_WAIT);
        }

        let redraw_proxy = self.proxy.clone();
        self.chrome = Some(Chrome::new(
            self.size.width,
            self.scale as f32,
            Arc::new(move || {
                let _ = redraw_proxy.send_event(UserEvent::Redraw);
            }),
        ));
        common::trace::mark("ui: chrome document built");

        let urls = std::mem::take(&mut self.start_urls);
        for url in &urls {
            self.open_tab(url);
        }
        if let Some(first) = self.browser.tab_ids().first().copied() {
            self.active = Some(first);
        }
        self.sync_chrome();
        common::trace::mark("ui: first tab opened");
        if let Some(c) = self.chrome.as_mut() {
            // Style + layout (and font loading) now, while the GPU initialises, instead of
            // in the first frame.
            c.doc.resolve(0.0);
        }
        common::trace::mark("ui: chrome resolved");

        if self.gpu.is_none() {
            self.start_cpu_renderer();
            self.show_window();
        }
    }

    fn new_events(&mut self, _event_loop: &ActiveEventLoop, _cause: winit::event::StartCause) {
        self.turn_started = Some(Instant::now());
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Browser(ev) => self.handle_browser_event(ev),
            UserEvent::Redraw => self.request_redraw(),
            UserEvent::UpdateReady(version) => {
                eprintln!("[ui] update {version} installed; active after restart");
                if let Some(c) = self.chrome.as_mut() {
                    c.set_update_ready(true);
                }
                self.request_redraw();
            }
            UserEvent::GpuReady => self.on_gpu_ready(),
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        self.flush_mouse_move();
        let now = Instant::now();
        if self.cpu_fallback_at.is_some_and(|t| now >= t) {
            self.cpu_fallback_at = None;
            if self.renderer.is_none() {
                // The GPU is still busy (first run, slow shader compiler): show the window
                // now with CPU-rendered frames; the GPU takes over when it is ready.
                common::trace::mark("ui: GPU not ready yet, first frames on the CPU");
                if cfg!(target_vendor = "apple") {
                    // Don't mix CALayer and Metal presentation: stay on the CPU.
                    self.gpu = None;
                    let _ = std::fs::remove_file(self.gpu_marker());
                }
                self.start_cpu_renderer();
                self.show_window();
            }
        }
        if self.anim_at.is_some_and(|t| now >= t) {
            self.anim_at = None;
            if self.active.and_then(|a| self.browser.tab(a)).is_some_and(|t| t.loading) {
                self.request_redraw();
            }
        }
        let next = [self.cpu_fallback_at, self.anim_at].into_iter().flatten().min();
        event_loop.set_control_flow(match next {
            Some(t) => ControlFlow::WaitUntil(t),
            None => ControlFlow::Wait,
        });
        if let Some(t0) = self.turn_started.take() {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            if ms > 30.0 && common::trace::enabled() {
                common::trace::mark(&format!("ui: event-loop turn blocked {ms:.0} ms"));
            }
        }
        if common::trace::enabled() && self.window_shown {
            let (since, frames, reports) = &mut self.paint_stats;
            if since.elapsed() >= Duration::from_secs(1) && *reports < 8 {
                common::trace::mark(&format!(
                    "ui: {} paints in the last {:.1} s",
                    self.frames_presented - *frames,
                    since.elapsed().as_secs_f64()
                ));
                *since = Instant::now();
                *frames = self.frames_presented;
                *reports += 1;
            }
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        if self.debug_events
            && !matches!(event, WindowEvent::CursorMoved { .. } | WindowEvent::RedrawRequested)
        {
            eprintln!("[ui] window event {event:?}");
        }
        match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                self.size = size;
                if let Some(r) = self.renderer.as_mut() {
                    r.set_size(size.width.max(1), size.height.max(1));
                }
                if let Some(g) = self.gpu.as_mut() {
                    g.set_size(size.width.max(1), size.height.max(1));
                }
                if let Some(c) = self.chrome.as_mut() {
                    c.resize(size.width, self.scale as f32);
                }
                if let Some(a) = self.active {
                    let vp = content_viewport(size, self.scale, self.zoom_of(a));
                    self.browser.resize(a, vp);
                }
                self.request_redraw();
            }
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                self.scale = scale_factor;
                if let Some(c) = self.chrome.as_mut() {
                    c.resize(self.size.width, scale_factor as f32);
                }
                if let Some(a) = self.active {
                    let vp = content_viewport(self.size, self.scale, self.zoom_of(a));
                    self.browser.resize(a, vp);
                }
            }
            WindowEvent::RedrawRequested => {
                if self.renderer.as_ref().is_some_and(|r| r.is_active()) {
                    self.paint();
                }
            }
            WindowEvent::ModifiersChanged(m) => {
                let s = m.state();
                self.mods = Modifiers {
                    shift: s.shift_key(),
                    ctrl: s.control_key(),
                    alt: s.alt_key(),
                    meta: s.super_key(),
                };
            }
            WindowEvent::CursorMoved { position, .. } => {
                self.mouse = position;
                if let Some(PointerTarget::Scrollbar(grab)) = self.capture {
                    let geom = self.active.and_then(|a| self.browser.tab(a)).and_then(|t| {
                        scrollbar_geom(t, self.size.width, self.size.height, self.chrome_px(), self.scale)
                    });
                    if let (Some(g), Some(a)) = (geom, self.active) {
                        let thumb_len = g.thumb.height();
                        let pos = (position.y - grab - g.track_top).clamp(0.0, g.track_len - thumb_len);
                        let y = pos / (g.track_len - thumb_len).max(1.0) * g.max_scroll;
                        self.browser.send(a, ToRenderer::ScrollTo { x: g.scroll_x, y });
                    }
                    return;
                }
                match self.pointer_target() {
                    PointerTarget::Chrome => {
                        self.leave_content();
                        let ev = {
                            let x = (position.x / self.scale) as f32;
                            let y = (position.y / self.scale) as f32;
                            engine::input::to_ui_event(
                                &InputEvent::MouseMove { x, y, buttons: self.buttons, mods: self.mods },
                                (0.0, 0.0),
                            )
                        };
                        if let (Some(c), Some(ev)) = (self.chrome.as_mut(), ev) {
                            let hover_before = c.doc.get_hover_node_id();
                            let actions = c.handle_ui_event(ev);
                            let cur = c.cursor().unwrap_or(CursorIcon::Default);
                            // Repaint only if something visible changed (hover, drag-select).
                            let changed = c.doc.get_hover_node_id() != hover_before
                                || self.buttons != 0
                                || !actions.is_empty();
                            self.set_cursor(cur);
                            self.run_actions(actions, event_loop);
                            if changed {
                                self.request_redraw();
                            }
                        }
                    }
                    PointerTarget::Scrollbar(_) => {}
                    PointerTarget::Content => {
                        self.pointer_in_content = true;
                        let (x, y) = self.content_point();
                        self.queue_mouse_move(InputEvent::MouseMove { x, y, buttons: self.buttons, mods: self.mods });
                        if let Some(tab) = self.active.and_then(|a| self.browser.tab(a)) {
                            let c = map_cursor(tab.cursor);
                            self.set_cursor(c);
                        }
                        // Clear chrome hover.
                        if let Some(c) = self.chrome.as_mut() {
                            c.doc.clear_hover();
                        }
                    }
                }
            }
            WindowEvent::CursorLeft { .. } => {
                self.leave_content();
                if let Some(c) = self.chrome.as_mut() {
                    c.doc.clear_hover();
                }
                self.request_redraw();
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let b: u8 = match button {
                    MouseButton::Left => 0,
                    MouseButton::Middle => 1,
                    MouseButton::Right => 2,
                    MouseButton::Back => 3,
                    MouseButton::Forward => 4,
                    MouseButton::Other(_) => return,
                };
                let bit = [1u8, 4, 2, 8, 16][b as usize];
                // Mouse back/forward buttons navigate (like other browsers).
                if state == ElementState::Pressed && (b == 3 || b == 4) {
                    let action = if b == 3 { Action::Back } else { Action::Forward };
                    self.run_actions(vec![action], event_loop);
                    return;
                }
                // Viewport scrollbar: grab the thumb or jump by a page in the track.
                if state == ElementState::Pressed && b == 0 && self.capture.is_none() {
                    let geom = self.active.and_then(|a| self.browser.tab(a)).and_then(|t| {
                        scrollbar_geom(t, self.size.width, self.size.height, self.chrome_px(), self.scale)
                    });
                    if let (Some(g), Some(a)) = (geom, self.active) {
                        let in_lane = self.mouse.x >= g.thumb.x0 - 6.0 * self.scale
                            && self.mouse.y >= self.chrome_px();
                        if in_lane {
                            if self.mouse.y >= g.thumb.y0 && self.mouse.y <= g.thumb.y1 {
                                self.capture = Some(PointerTarget::Scrollbar(self.mouse.y - g.thumb.y0));
                            } else {
                                // Center the thumb under the pointer.
                                let thumb_len = g.thumb.height();
                                let pos = (self.mouse.y - thumb_len / 2.0 - g.track_top)
                                    .clamp(0.0, g.track_len - thumb_len);
                                let y = pos / (g.track_len - thumb_len).max(1.0) * g.max_scroll;
                                self.browser.send(a, ToRenderer::ScrollTo { x: g.scroll_x, y });
                                self.capture = Some(PointerTarget::Scrollbar(thumb_len / 2.0));
                            }
                            self.buttons |= bit;
                            return;
                        }
                    }
                }
                if let Some(PointerTarget::Scrollbar(_)) = self.capture {
                    if state == ElementState::Released {
                        self.buttons &= !bit;
                        if self.buttons == 0 {
                            self.capture = None;
                        }
                    }
                    return;
                }
                let target = self.pointer_target();
                if state == ElementState::Pressed {
                    self.buttons |= bit;
                    self.capture = Some(target);
                } else {
                    self.buttons &= !bit;
                }
                match target {
                    PointerTarget::Scrollbar(_) => {}
                    PointerTarget::Chrome => {
                        let kind = if state == ElementState::Pressed { 1 } else { 2 };
                        let ev = self.chrome_pointer(kind, b);
                        if let Some(c) = self.chrome.as_mut() {
                            let actions = c.handle_ui_event(ev);
                            self.run_actions(actions, event_loop);
                        }
                        self.request_redraw();
                    }
                    PointerTarget::Content => {
                        if state == ElementState::Pressed {
                            // Clicking into the page takes focus away from the address bar.
                            if let Some(c) = self.chrome.as_mut() {
                                if c.url_focused() {
                                    c.revert_url();
                                    self.request_redraw();
                                }
                            }
                        }
                        let (x, y) = self.content_point();
                        let ev = if state == ElementState::Pressed {
                            InputEvent::MouseDown { x, y, button: b, buttons: self.buttons, mods: self.mods }
                        } else {
                            InputEvent::MouseUp { x, y, button: b, buttons: self.buttons, mods: self.mods }
                        };
                        self.send_content(ev);
                    }
                }
                if state == ElementState::Released && self.buttons == 0 {
                    self.capture = None;
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if self.pointer_target() != PointerTarget::Content {
                    return;
                }
                let zoom = self.active.map(|a| self.zoom_of(a)).unwrap_or(1.0) as f64;
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (-(x as f64) * 48.0, -(y as f64) * 48.0),
                    MouseScrollDelta::PixelDelta(p) => {
                        (-p.x / (self.scale * zoom), -p.y / (self.scale * zoom))
                    }
                };
                if self.mods.ctrl {
                    // Ctrl + wheel zooms.
                    let action = if dy < 0.0 { Action::ZoomIn } else { Action::ZoomOut };
                    self.run_actions(vec![action], event_loop);
                    return;
                }
                let (x, y) = self.content_point();
                self.send_content(InputEvent::Wheel { x, y, dx, dy, mods: self.mods });
            }
            WindowEvent::KeyboardInput { event, is_synthetic, .. } => {
                if is_synthetic {
                    return;
                }
                let Some(k) = keys::convert(&event, self.mods) else { return };
                if event.state == ElementState::Pressed {
                    if let Some(action) = keys::shortcut(&k, self.mods) {
                        match action {
                            keys::Shortcut::Ui(a) => self.run_actions(vec![a], event_loop),
                            keys::Shortcut::FocusUrl => {
                                if let Some(c) = self.chrome.as_mut() {
                                    c.focus_url();
                                }
                                self.request_redraw();
                            }
                            keys::Shortcut::CloseTab => {
                                if let Some(a) = self.active {
                                    self.close_tab(a, event_loop);
                                }
                            }
                            keys::Shortcut::NextTab(dir) => {
                                let ids = self.browser.tab_ids().to_vec();
                                if let (Some(a), false) = (self.active, ids.is_empty()) {
                                    let i = ids.iter().position(|t| *t == a).unwrap_or(0) as i32;
                                    let n = ids.len() as i32;
                                    let next = ids[((i + dir).rem_euclid(n)) as usize];
                                    self.select_tab(next);
                                }
                            }
                            keys::Shortcut::TabIndex(i) => {
                                let ids = self.browser.tab_ids().to_vec();
                                let id = if i == usize::MAX { ids.last() } else { ids.get(i) };
                                if let Some(id) = id.copied() {
                                    self.select_tab(id);
                                }
                            }
                            keys::Shortcut::Fullscreen => {
                                if let Some(w) = &self.window {
                                    self.fullscreen = !self.fullscreen;
                                    w.set_fullscreen(
                                        self.fullscreen
                                            .then_some(winit::window::Fullscreen::Borderless(None)),
                                    );
                                }
                            }
                        }
                        return;
                    }
                }
                let chrome_focused = self.chrome.as_ref().is_some_and(|c| c.url_focused());
                if chrome_focused {
                    if let Some(ui) = engine::input::to_ui_event(&k, (0.0, 0.0)) {
                        if let Some(c) = self.chrome.as_mut() {
                            let actions = c.handle_ui_event(ui);
                            self.run_actions(actions, event_loop);
                        }
                    }
                    self.request_redraw();
                } else {
                    self.send_content(k);
                }
            }
            WindowEvent::Ime(ime) => {
                let ev = match ime {
                    Ime::Enabled => InputEvent::ImeEnabled,
                    Ime::Disabled => InputEvent::ImeDisabled,
                    Ime::Preedit(text, cursor) => InputEvent::ImePreedit { text, cursor },
                    Ime::Commit(text) => InputEvent::ImeCommit(text),
                };
                let chrome_focused = self.chrome.as_ref().is_some_and(|c| c.url_focused());
                if chrome_focused {
                    if let Some(ui) = engine::input::to_ui_event(&ev, (0.0, 0.0)) {
                        if let Some(c) = self.chrome.as_mut() {
                            let actions = c.handle_ui_event(ui);
                            self.run_actions(actions, event_loop);
                        }
                    }
                    self.request_redraw();
                } else {
                    self.send_content(ev);
                }
            }
            WindowEvent::Focused(f) => {
                self.send_content(InputEvent::Focus(f));
            }
            _ => {}
        }
        // Keep IME available while the address bar has focus.
        let want_ime = self.chrome.as_ref().is_some_and(|c| c.url_focused())
            || self.active.and_then(|a| self.browser.tab(a)).is_some_and(|t| t.ime_allowed);
        if want_ime != self.ime_enabled {
            if let Some(w) = &self.window {
                w.set_ime_allowed(want_ime);
            }
            self.ime_enabled = want_ime;
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        if self.gpu.is_some() {
            // Quit while the GPU was still initialising: that's not a crash.
            let _ = std::fs::remove_file(self.gpu_marker());
        }
        self.browser.shutdown();
    }
}

/// Whether a previous start died while initialising the GPU (see `App::gpu_marker`).
/// The verdict expires after a week (drivers get updated).
fn gpu_init_crashed_before(marker: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(marker) else { return false };
    let age = meta.modified().ok().and_then(|m| m.elapsed().ok());
    if age.is_some_and(|a| a > Duration::from_secs(7 * 24 * 3600)) {
        let _ = std::fs::remove_file(marker);
        return false;
    }
    true
}

fn crash_html(url: &str) -> String {
    let t = common::i18n::localize(&common::resources::text("pages/crash.html"));
    common::resources::fill(&t, &[("url", &common::resources::escape_html(url))])
}

/// Built-in new tab page (`resources/pages/newtab.html`).
pub fn newtab_html() -> String {
    common::i18n::localize(&common::resources::text("pages/newtab.html"))
}

/// Run the windowed browser. Returns when the last window closes.
pub fn run(opts: BrowserOptions, start_urls: Vec<String>) -> Result<(), String> {
    let event_loop = EventLoop::<UserEvent>::with_user_event()
        .build()
        .map_err(|e| e.to_string())?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    common::trace::mark("ui: event loop created");
    let browser = Browser::new(opts).map_err(|e| e.to_string())?;
    common::trace::mark("ui: network service up");

    // Forward browser events (IPC reader threads) into the winit loop.
    let rx = browser.events.clone();
    let fwd = proxy.clone();
    std::thread::Builder::new()
        .name("browser-events".into())
        .spawn(move || {
            while let Ok(ev) = rx.recv() {
                if fwd.send_event(UserEvent::Browser(ev)).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;

    // Background updates (GitHub Releases, signed manifests).
    if browser.opts.auto_update {
        match browser::update::UpdateConfig::detect(&browser.opts.app_version) {
            Ok(cfg) => {
                let net = browser.net().clone();
                let proxy = proxy.clone();
                std::thread::Builder::new()
                    .name("updater".into())
                    .spawn(move || {
                        std::thread::sleep(Duration::from_secs(20));
                        loop {
                            match browser::update::check_and_install(&net, &cfg) {
                                browser::update::UpdateStatus::Installed(v) => {
                                    let _ = proxy.send_event(UserEvent::UpdateReady(v));
                                    return;
                                }
                                browser::update::UpdateStatus::Failed(e) => {
                                    log::warn!("update check failed: {e}")
                                }
                                _ => {}
                            }
                            std::thread::sleep(Duration::from_secs(6 * 3600));
                        }
                    })
                    .map_err(|e| e.to_string())?;
            }
            Err(why) => log::info!("auto-update disabled: {why}"),
        }
    }

    let mut app = App {
        browser,
        proxy,
        window: None,
        renderer: None,
        chrome: None,
        active: None,
        size: PhysicalSize::new(1280, 860),
        scale: 1.0,
        mouse: PhysicalPosition::new(0.0, 0.0),
        buttons: 0,
        mods: Modifiers::default(),
        capture: None,
        start_urls: if start_urls.is_empty() {
            vec![HOME_URL.to_string()]
        } else {
            start_urls
        },
        zoom: Default::default(),
        last_cursor: None,
        force_cpu: std::env::var("BROWSER_RENDERER").is_ok_and(|v| v == "cpu"),
        fullscreen: false,
        renderer_kind: "",
        frames_presented: 0,
        ime_enabled: false,
        debug_events: std::env::var("BROWSER_DEBUG_EVENTS").is_ok(),
        first_content_traced: false,
        gpu: None,
        cpu_fallback_at: None,
        window_shown: false,
        anim_at: None,
        pending_mouse: None,
        pointer_in_content: false,
        respawns: HashMap::new(),
        turn_started: None,
        frames_by_kind: 0,
        paint_stats: (Instant::now(), 0, 0),
    };
    event_loop.run_app(&mut app).map_err(|e| e.to_string())
}

/// Windows-specific window handling.
#[cfg(windows)]
mod win {
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use winit::window::Window;

    #[link(name = "dwmapi")]
    unsafe extern "system" {
        fn DwmSetWindowAttribute(hwnd: isize, attribute: u32, value: *const core::ffi::c_void, size: u32) -> i32;
    }
    const DWMWA_CLOAK: u32 = 13;

    /// Cloak/uncloak the window: a cloaked window is "visible" (it gets painted and can be
    /// presented to) but the desktop compositor doesn't show it.
    pub fn set_cloaked(window: &Window, cloaked: bool) -> bool {
        let Ok(handle) = window.window_handle() else { return false };
        let RawWindowHandle::Win32(h) = handle.as_raw() else { return false };
        let value: i32 = cloaked as i32;
        // SAFETY: valid HWND of a live window; value points to a BOOL of the given size.
        let hr = unsafe {
            DwmSetWindowAttribute(
                h.hwnd.get(),
                DWMWA_CLOAK,
                (&value as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            )
        };
        hr >= 0
    }
}
