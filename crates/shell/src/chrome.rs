//! The browser chrome (tab strip + toolbar) is itself an HTML/CSS document rendered
//! by the same engine (Blitz), like Firefox's HTML-based UI. It lives in the browser
//! process and has no JavaScript: Rust reacts to clicks on elements with `data-action`.

use blitz_dom::node::{SpecialElementData, TextInputData};
use blitz_dom::{BaseDocument, DocumentConfig, EventDriver, EventHandler, LocalName, NodeId};
use blitz_traits::events::{DomEvent, DomEventData, EventState, UiEvent};
use blitz_traits::shell::{ClipboardError, ColorScheme, ShellProvider, Viewport};
use std::cell::RefCell;

macro_rules! t {
    ($k:expr) => {
        common::i18n::t($k)
    };
}
use std::rc::Rc;
use std::sync::Arc;

/// Height of the chrome in CSS pixels (tab strip 38 + toolbar 42 + 1px border).
pub const CHROME_HEIGHT: f32 = 81.0;

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    NewTab,
    SelectTab(u32),
    CloseTab(u32),
    Back,
    Forward,
    Reload,
    Stop,
    /// Navigate the active tab to what the user typed in the address bar.
    Go(String),
    /// Escape in the address bar.
    RevertUrl,
    Home,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    /// Restart into a freshly installed update.
    Restart,
}

/// What the chrome shows for one tab.
#[derive(Clone, Debug, PartialEq)]
pub struct TabView {
    pub id: u32,
    pub title: String,
    pub loading: bool,
    pub crashed: bool,
}

/// What the toolbar shows.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ToolbarView {
    pub tab: u32,
    pub url: String,
    pub can_back: bool,
    pub can_forward: bool,
    pub loading: bool,
    pub zoom: f32,
    pub secure: bool,
}

struct ClipboardShell {
    redraw: Arc<dyn Fn() + Send + Sync>,
}

impl ShellProvider for ClipboardShell {
    fn request_redraw(&self) {
        (self.redraw)();
    }
    fn get_clipboard_text(&self) -> Result<String, ClipboardError> {
        arboard::Clipboard::new()
            .and_then(|mut c| c.get_text())
            .map_err(|_| ClipboardError)
    }
    fn set_clipboard_text(&self, text: String) -> Result<(), ClipboardError> {
        arboard::Clipboard::new()
            .and_then(|mut c| c.set_text(text))
            .map_err(|_| ClipboardError)
    }
}


/// Toolbar/tab icons (SVG), loaded from `resources/ui/icons/`.
struct Icons {
    back: String,
    forward: String,
    reload: String,
    stop: String,
    home: String,
    close: String,
    plus: String,
    lock: String,
    info: String,
}

impl Icons {
    fn load() -> Self {
        let i = |n: &str| common::resources::text(&format!("ui/icons/{n}.svg")).trim().to_string();
        Self {
            back: i("back"),
            forward: i("forward"),
            reload: i("reload"),
            stop: i("stop"),
            home: i("home"),
            close: i("close"),
            plus: i("plus"),
            lock: i("lock"),
            info: i("info"),
        }
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Collects actions triggered while blitz dispatches a UI event through the chrome.
struct ChromeHandler {
    actions: Rc<RefCell<Vec<Action>>>,
    url_input: NodeId,
}

impl EventHandler for ChromeHandler {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn blitz_dom::Document,
        _state: &mut EventState,
    ) {
        let action_attr = LocalName::from("data-action");
        let tab_attr = LocalName::from("data-tab");
        let doc = doc.inner();
        let find = |doc: &BaseDocument| -> Option<(String, Option<u32>)> {
            for id in chain {
                let node = doc.get_node(*id)?;
                if let Some(a) = node.attr(action_attr.clone()) {
                    let tab = chain
                        .iter()
                        .filter_map(|i| doc.get_node(*i))
                        .find_map(|n| n.attr(tab_attr.clone()))
                        .and_then(|t| t.parse().ok());
                    return Some((a.to_string(), tab));
                }
            }
            None
        };
        match &event.data {
            DomEventData::MouseDown(ev) => {
                // Tabs activate on press (like Chrome); middle button closes.
                if let Some((a, Some(tab))) = find(&doc) {
                    if a == "select" {
                        let action = if ev.button == blitz_traits::events::MouseEventButton::Auxiliary {
                            Action::CloseTab(tab)
                        } else {
                            Action::SelectTab(tab)
                        };
                        self.actions.borrow_mut().push(action);
                    }
                }
            }
            DomEventData::Click(_) => {
                if let Some((a, tab)) = find(&doc) {
                    let action = match (a.as_str(), tab) {
                        ("close", Some(t)) => Some(Action::CloseTab(t)),
                        ("new", _) => Some(Action::NewTab),
                        ("back", _) => Some(Action::Back),
                        ("forward", _) => Some(Action::Forward),
                        ("reload", _) => Some(Action::Reload),
                        ("stop", _) => Some(Action::Stop),
                        ("home", _) => Some(Action::Home),
                        ("zoom", _) => Some(Action::ZoomReset),
                        ("restart", _) => Some(Action::Restart),
                        _ => None,
                    };
                    if let Some(action) = action {
                        self.actions.borrow_mut().push(action);
                    }
                }
            }
            DomEventData::KeyDown(k) if event.target == self.url_input => {
                use keyboard_types::Key;
                match &k.key {
                    Key::Enter => {
                        let text = doc
                            .get_node(self.url_input)
                            .and_then(|n| n.element_data())
                            .and_then(|e| e.text_input_data())
                            .map(|t| t.editor.raw_text().to_string())
                            .unwrap_or_default();
                        self.actions.borrow_mut().push(Action::Go(text));
                    }
                    Key::Escape => self.actions.borrow_mut().push(Action::RevertUrl),
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

pub struct Chrome {
    pub doc: BaseDocument,
    icons: Icons,
    update_shown: bool,
    actions: Rc<RefCell<Vec<Action>>>,
    url_input: NodeId,
    strip: NodeId,
    nav: NodeId,
    tabs_shown: Vec<TabView>,
    active_shown: Option<u32>,
    toolbar_shown: Option<ToolbarView>,
}

impl Chrome {
    pub fn new(width_px: u32, scale: f32, redraw: Arc<dyn Fn() + Send + Sync>) -> Self {
        let css = common::resources::text("ui/chrome.css");
        let template = common::i18n::localize(&common::resources::text("ui/chrome.html"));
        let html = template.replace("{{css}}", &css);
        let config = DocumentConfig {
            viewport: Some(Viewport::new(
                width_px,
                (CHROME_HEIGHT * scale).ceil() as u32,
                scale,
                ColorScheme::Light,
            )),
            base_url: Some("about:chrome".into()),
            shell_provider: Some(Arc::new(ClipboardShell { redraw })),
            html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
            ..Default::default()
        };
        let doc = blitz_html::HtmlDocument::from_html(&html, config).into_inner();
        let url_input = doc.get_element_by_id("url").expect("url input");
        let strip = doc.get_element_by_id("strip").expect("strip");
        let nav = doc.get_element_by_id("nav").expect("nav");
        Self {
            doc,
            icons: Icons::load(),
            update_shown: false,
            actions: Rc::new(RefCell::new(Vec::new())),
            url_input,
            strip,
            nav,
            tabs_shown: Vec::new(),
            active_shown: None,
            toolbar_shown: None,
        }
    }

    pub fn height_px(&self, scale: f32) -> u32 {
        (CHROME_HEIGHT * scale).ceil() as u32
    }

    pub fn resize(&mut self, width_px: u32, scale: f32) {
        self.doc.set_viewport(Viewport::new(
            width_px,
            self.height_px(scale),
            scale,
            ColorScheme::Light,
        ));
    }

    /// Update the tab strip if anything changed.
    pub fn set_tabs(&mut self, tabs: &[TabView], active: Option<u32>) {
        if self.tabs_shown == tabs && self.active_shown == active {
            return;
        }
        let mut html = String::new();
        for t in tabs {
            let title = if t.title.is_empty() {
                if t.loading { t!("tab.loading") } else { t!("tab.new") }.to_string()
            } else {
                t.title.clone()
            };
            let class = format!(
                "tab{}{}",
                if Some(t.id) == active { " active" } else { "" },
                if t.crashed { " crashed" } else { "" }
            );
            let icon = if t.loading {
                r#"<div class="spin"></div>"#
            } else {
                r#"<div class="fav"></div>"#
            };
            html.push_str(&format!(
                r#"<div class="{class}" data-action="select" data-tab="{id}" title="{t}">{icon}<div class="title">{t}</div><div class="close" data-action="close" data-tab="{id}" title="{close_title}">{close}</div></div>"#,
                id = t.id,
                t = esc(&title),
                close = self.icons.close,
                close_title = esc(t!("tab.close")),
            ));
        }
        html.push_str(&format!(
            r#"<div id="new" data-action="new" title="{}">{}</div>"#,
            esc(t!("tab.new")),
            self.icons.plus
        ));
        let strip = self.strip;
        self.doc.mutate().set_inner_html(strip, &html);
        self.tabs_shown = tabs.to_vec();
        self.active_shown = active;
    }

    /// Update the toolbar (buttons + address bar). The address bar text is only replaced
    /// while the user isn't editing it.
    pub fn set_toolbar(&mut self, view: &ToolbarView) {
        if self.toolbar_shown.as_ref() == Some(view) {
            return;
        }
        let ic = &self.icons;
        let nav_html = format!(
            r#"<div class="btn{b}" data-action="back" title="{tb}">{back}</div><div class="btn{f}" data-action="forward" title="{tf}">{fwd}</div>{reload}<div class="btn" data-action="home" title="{th}">{home}</div>"#,
            b = if view.can_back { "" } else { " off" },
            f = if view.can_forward { "" } else { " off" },
            tb = esc(t!("toolbar.back")),
            tf = esc(t!("toolbar.forward")),
            th = esc(t!("toolbar.home")),
            back = ic.back,
            fwd = ic.forward,
            home = ic.home,
            reload = if view.loading {
                format!(r#"<div class="btn" data-action="stop" title="{}">{}</div>"#, esc(t!("toolbar.stop")), ic.stop)
            } else {
                format!(r#"<div class="btn" data-action="reload" title="{}">{}</div>"#, esc(t!("toolbar.reload")), ic.reload)
            }
        );
        let nav = self.nav;
        self.doc.mutate().set_inner_html(nav, &nav_html);

        if let Some(lock) = self.doc.get_element_by_id("lock") {
            let icon = if view.secure { self.icons.lock.clone() } else { self.icons.info.clone() };
            self.doc.mutate().set_inner_html(lock, &icon);
        }
        if let Some(zoom) = self.doc.get_element_by_id("zoom") {
            let pct = (view.zoom * 100.0).round() as i32;
            let mut m = self.doc.mutate();
            if pct == 100 {
                m.set_attribute(zoom, blitz_dom::QualName::new(None, blitz_dom::ns!(), LocalName::from("class")), "hidden");
            } else {
                m.set_attribute(zoom, blitz_dom::QualName::new(None, blitz_dom::ns!(), LocalName::from("class")), "");
            }
            drop(m);
            self.doc.mutate().set_inner_html(zoom, &format!("{pct} %"));
        }

        let url_changed = self.toolbar_shown.as_ref().map(|t| &t.url) != Some(&view.url);
        let tab_changed = self.toolbar_shown.as_ref().map(|t| t.tab) != Some(view.tab);
        if tab_changed || (url_changed && !self.url_focused()) {
            self.set_url_text(&display_url(&view.url));
        }
        self.toolbar_shown = Some(view.clone());
    }

    /// Show or hide the "update ready – restart" button.
    pub fn set_update_ready(&mut self, ready: bool) {
        if self.update_shown == ready {
            return;
        }
        self.update_shown = ready;
        if let Some(el) = self.doc.get_element_by_id("update") {
            let class = blitz_dom::QualName::new(None, blitz_dom::ns!(), LocalName::from("class"));
            self.doc
                .mutate()
                .set_attribute(el, class, if ready { "" } else { "hidden" });
        }
    }

    pub fn url_focused(&self) -> bool {
        self.doc.get_focussed_node_id() == Some(self.url_input)
    }

    pub fn set_url_text(&mut self, text: &str) {
        let id = self.url_input;
        if let Some(el) = self.doc.get_node_mut(id).and_then(|n| n.element_data_mut()) {
            if !matches!(el.special_data, SpecialElementData::TextInput(_)) {
                el.special_data = SpecialElementData::TextInput(TextInputData::new(false));
            }
        }
        self.doc.with_text_input(id, |mut d| {
            d.editor.set_text(text);
            d.move_to_text_start();
        });
    }

    /// Focus the address bar and select its content (Ctrl+L / F6).
    pub fn focus_url(&mut self) {
        let id = self.url_input;
        self.doc.set_focus_to(id);
        self.doc.with_text_input(id, |mut d| d.select_all());
    }

    pub fn blur(&mut self) {
        self.doc.clear_focus();
    }

    /// Restore the address bar to the page URL.
    pub fn revert_url(&mut self) {
        if let Some(url) = self.toolbar_shown.as_ref().map(|t| display_url(&t.url)) {
            self.set_url_text(&url);
        }
        self.blur();
    }

    /// Dispatch a UI event into the chrome and return the triggered actions.
    pub fn handle_ui_event(&mut self, ev: UiEvent) -> Vec<Action> {
        let was_focused = self.url_focused();
        let is_down = matches!(ev, UiEvent::PointerDown(_));
        let handler = ChromeHandler {
            actions: self.actions.clone(),
            url_input: self.url_input,
        };
        let mut driver = EventDriver::new(&mut self.doc, handler);
        driver.handle_ui_event(ev);
        // Clicking into the address bar selects everything (like other browsers).
        if is_down && !was_focused && self.url_focused() {
            let id = self.url_input;
            self.doc.with_text_input(id, |mut d| d.select_all());
        }
        std::mem::take(&mut *self.actions.borrow_mut())
    }

    pub fn cursor(&self) -> Option<cursor_icon::CursorIcon> {
        self.doc.get_cursor()
    }
}

/// Show URLs like other browsers: hide "https://" for clean display? We keep the full
/// URL (transparent + copy-friendly) except for internal pages.
pub fn display_url(url: &str) -> String {
    if url == "about:newtab" || url == "about:blank" {
        String::new()
    } else {
        url.to_string()
    }
}

/// Turn address bar input into a URL: full URLs stay, things that look like hosts get
/// https://, everything else becomes a web search.
pub fn fixup_input(input: &str) -> String {
    let s = input.trim();
    if s.is_empty() {
        return "about:newtab".into();
    }
    if s.contains("://") || s.starts_with("about:") || s.starts_with("data:") || s.starts_with("file:") {
        return s.to_string();
    }
    let looks_like_host = !s.contains(' ')
        && (s.contains('.') || s.starts_with("localhost"))
        && !s.starts_with('.')
        && !s.ends_with('.');
    if looks_like_host {
        return format!("https://{s}");
    }
    let q: String = s
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("https://duckduckgo.com/?q={q}")
}
