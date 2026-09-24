//! Windowed browser UI.
//!
//! * Window + input: winit
//! * Compositor: Vello on the GPU via wgpu (DX12/Vulkan/Metal), vello_cpu + softbuffer as
//!   fallback when no usable GPU adapter exists (or `BROWSER_RENDERER=cpu`).
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
}

enum Renderer {
    Gpu(Box<anyrender_vello::VelloWindowRenderer>),
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
            }
        }
        self.sync_chrome();
    }

    fn handle_browser_event(&mut self, ev: BrowserEvent) {
        let active = self.active;
        let Some(ev) = self.browser.process_event(ev) else {
            // Frames are consumed silently; redraw if it was for the visible tab.
            if active.and_then(|a| self.browser.tab(a)).is_some() {
                self.request_redraw();
            }
            return;
        };
        match ev {
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
                if let Some(t) = self.browser.tab_mut(id) {
                    t.title = "Absturz".into();
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

    fn send_content(&self, ev: InputEvent) {
        if let Some(a) = self.active {
            self.browser.send(a, ToRenderer::Input(ev));
        }
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
        chrome.doc.resolve(0.0);
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
            // Content area background.
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::WHITE,
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

        match self.renderer.as_mut() {
            Some(Renderer::Gpu(r)) if r.is_active() => {
                r.render(|scene| paint_all(scene, chrome, tab, width, height, chrome_px, scale))
            }
            Some(Renderer::Cpu(r)) if r.is_active() => {
                r.render(|scene| paint_all(scene, chrome, tab, width, height, chrome_px, scale))
            }
            _ => return,
        }
        self.frames_presented += 1;
        // Keep animating the progress bar while loading.
        if tab.is_some_and(|t| t.loading) {
            let proxy = self.proxy.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(33));
                let _ = proxy.send_event(UserEvent::Redraw);
            });
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

fn gpu_available() -> bool {
    use anyrender_vello::wgpu;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .is_ok()
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("Neuer Tab")
            .with_inner_size(LogicalSize::new(1280.0, 860.0))
            .with_min_inner_size(LogicalSize::new(400.0, 300.0));
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

        let use_gpu = !self.force_cpu && gpu_available();
        let mut renderer = if use_gpu {
            self.renderer_kind = "GPU (Vello/wgpu)";
            Renderer::Gpu(Box::new(anyrender_vello::VelloWindowRenderer::new()))
        } else {
            self.renderer_kind = "CPU (vello_cpu)";
            Renderer::Cpu(Box::new(anyrender_vello_cpu::VelloCpuWindowRenderer::new()))
        };
        let handle: Arc<dyn anyrender::WindowHandle> = window.clone();
        let proxy = self.proxy.clone();
        match &mut renderer {
            Renderer::Gpu(r) => {
                r.resume(handle, self.size.width, self.size.height, move || {
                    let _ = proxy.send_event(UserEvent::Redraw);
                });
                r.complete_resume();
            }
            Renderer::Cpu(r) => {
                r.resume(handle, self.size.width, self.size.height, move || {
                    let _ = proxy.send_event(UserEvent::Redraw);
                });
                r.complete_resume();
            }
        }
        eprintln!("[ui] compositor: {}", self.renderer_kind);
        self.renderer = Some(renderer);

        let redraw_proxy = self.proxy.clone();
        self.chrome = Some(Chrome::new(
            self.size.width,
            self.scale as f32,
            Arc::new(move || {
                let _ = redraw_proxy.send_event(UserEvent::Redraw);
            }),
        ));
        self.window = Some(window);

        let urls = std::mem::take(&mut self.start_urls);
        for (i, url) in urls.iter().enumerate() {
            self.open_tab(url);
            if i == 0 {
                if let Some(first) = self.browser.tab_ids().first().copied() {
                    self.active = Some(first);
                }
            }
        }
        if let Some(first) = self.browser.tab_ids().first().copied() {
            self.active = Some(first);
        }
        self.sync_chrome();
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Browser(ev) => self.handle_browser_event(ev),
            UserEvent::Redraw => self.request_redraw(),
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                self.size = size;
                if let Some(r) = self.renderer.as_mut() {
                    r.set_size(size.width.max(1), size.height.max(1));
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
                match self.pointer_target() {
                    PointerTarget::Chrome => {
                        if let Some(c) = self.chrome.as_mut() {
                            let ev = {
                                let x = (position.x / self.scale) as f32;
                                let y = (position.y / self.scale) as f32;
                                engine::input::to_ui_event(
                                    &InputEvent::MouseMove { x, y, buttons: self.buttons, mods: self.mods },
                                    (0.0, 0.0),
                                )
                            };
                            if let Some(ev) = ev {
                                let actions = c.handle_ui_event(ev);
                                let cur = c.cursor().unwrap_or(CursorIcon::Default);
                                self.set_cursor(cur);
                                self.run_actions(actions, event_loop);
                            }
                            // Leaving the content area.
                            self.send_content(InputEvent::MouseLeave);
                        }
                        self.request_redraw();
                    }
                    PointerTarget::Content => {
                        let (x, y) = self.content_point();
                        self.send_content(InputEvent::MouseMove { x, y, buttons: self.buttons, mods: self.mods });
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
                self.send_content(InputEvent::MouseLeave);
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
                let target = self.pointer_target();
                if state == ElementState::Pressed {
                    self.buttons |= bit;
                    self.capture = Some(target);
                } else {
                    self.buttons &= !bit;
                }
                match target {
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
        self.browser.shutdown();
    }
}

/// Built-in new tab page.
pub fn newtab_html() -> String {
    r#"<!DOCTYPE html><html><head><meta charset="utf-8"><title>Neuer Tab</title><style>
body{margin:0;font-family:"Segoe UI",system-ui,sans-serif;background:#f8f9fb;color:#1f1f1f}
.wrap{display:flex;flex-direction:column;align-items:center;padding-top:18vh}
h1{font-weight:300;font-size:44px;margin:0 0 28px;color:#3c4043;letter-spacing:-1px}
form{display:flex;width:560px;max-width:90vw}
input{flex:1;height:46px;border:1px solid #dadce0;border-radius:23px;padding:0 22px;font-size:16px;background:#fff;outline:none}
input:focus{border-color:#0b57d0}
.tiles{display:flex;gap:18px;margin-top:44px;flex-wrap:wrap;justify-content:center;max-width:640px}
.tile{display:flex;flex-direction:column;align-items:center;width:96px;text-decoration:none;color:#3c4043;font-size:12px}
.ico{width:48px;height:48px;border-radius:24px;background:#e8eaed;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:600;color:#0b57d0;margin-bottom:8px}
.tile:hover .ico{background:#dde3ea}
</style></head><body><div class="wrap">
<h1>Wohin heute?</h1>
<form action="https://duckduckgo.com/" method="get"><input name="q" placeholder="Im Web suchen" autocomplete="off"></form>
<div class="tiles">
<a class="tile" href="https://de.wikipedia.org"><div class="ico">W</div>Wikipedia</a>
<a class="tile" href="https://www.tagesschau.de"><div class="ico">T</div>Tagesschau</a>
<a class="tile" href="https://www.heise.de"><div class="ico">H</div>heise</a>
<a class="tile" href="https://news.ycombinator.com"><div class="ico">Y</div>Hacker News</a>
<a class="tile" href="https://www.youtube.com"><div class="ico">▶</div>YouTube</a>
<a class="tile" href="https://github.com"><div class="ico">G</div>GitHub</a>
</div></div></body></html>"#
        .to_string()
}

/// Run the windowed browser. Returns when the last window closes.
pub fn run(opts: BrowserOptions, start_urls: Vec<String>) -> Result<(), String> {
    let event_loop = EventLoop::<UserEvent>::with_user_event()
        .build()
        .map_err(|e| e.to_string())?;
    event_loop.set_control_flow(ControlFlow::Wait);
    let proxy = event_loop.create_proxy();
    let browser = Browser::new(opts).map_err(|e| e.to_string())?;

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
    };
    let _ = Instant::now();
    event_loop.run_app(&mut app).map_err(|e| e.to_string())
}
