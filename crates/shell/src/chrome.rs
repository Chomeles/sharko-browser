//! The browser chrome (tab strip + toolbar) is itself an HTML/CSS document rendered
//! by the same engine (Blitz), like Firefox's HTML-based UI. It lives in the browser
//! process and has no JavaScript: Rust reacts to clicks on elements with `data-action`.

use blitz_dom::node::{SpecialElementData, TextInputData};
use blitz_dom::{BaseDocument, DocumentConfig, EventDriver, EventHandler, LocalName, NodeId};
use blitz_traits::events::{DomEvent, DomEventData, EventState, UiEvent};
use blitz_traits::shell::{ClipboardError, ColorScheme, ShellProvider, Viewport};
use std::cell::RefCell;
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

const CSS: &str = r#"
:root { font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, "Noto Sans", "DejaVu Sans", sans-serif; font-size: 13px; }
html, body { margin: 0; padding: 0; background: #dee1e6; overflow: hidden; cursor: default; }
#strip { display: flex; align-items: flex-end; height: 38px; padding: 0 8px 0 8px; }
.tab { position: relative; display: flex; align-items: center; flex: 0 1 230px; min-width: 48px;
       height: 32px; padding: 0 6px 0 12px; margin-right: 1px; border-radius: 9px 9px 0 0;
       color: #45474a; overflow: hidden; }
.tab:hover { background: #eceef1; }
.tab.active { background: #ffffff; color: #1f1f1f; }
.tab .fav { width: 14px; height: 14px; margin-right: 8px; flex: none; border-radius: 3px; background: #c4c7cc; }
.tab.active .fav { background: #a8c7fa; }
.tab .spin { width: 10px; height: 10px; margin: 0 10px 0 2px; flex: none; border-radius: 50%;
             border: 2px solid #c2d5f7; border-top-color: #1a73e8; }
.tab .title { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tab .close { flex: none; width: 20px; height: 20px; border-radius: 10px; display: flex;
              align-items: center; justify-content: center; margin-left: 4px; }
.tab .close:hover { background: #d3d6db; }
.tab.crashed .title { color: #b3261e; }
#new { width: 28px; height: 28px; margin: 0 0 3px 4px; border-radius: 14px; display: flex;
       align-items: center; justify-content: center; flex: none; }
#new:hover { background: #cfd2d8; }
#toolbar { display: flex; align-items: center; height: 42px; padding: 0 8px; background: #ffffff;
           border-bottom: 1px solid #d3d6db; }
.btn { width: 34px; height: 34px; border-radius: 17px; display: flex; align-items: center;
       justify-content: center; flex: none; margin-right: 2px; }
.btn:hover { background: #eef0f3; }
.btn:active { background: #e1e4e8; }
.btn.off { opacity: 0.32; }
.btn.off:hover { background: transparent; }
#omnibox { flex: 1 1 auto; display: flex; align-items: center; height: 34px; margin: 0 6px;
           border-radius: 17px; background: #f0f2f4; padding: 0 6px 0 12px; }
#omnibox:hover { background: #e8eaed; }
#omnibox:focus-within { background: #ffffff; box-shadow: 0 0 0 2px #0b57d0; }
#lock { width: 16px; height: 16px; flex: none; margin-right: 8px; display: flex; align-items: center; }
#url { flex: 1 1 auto; height: 30px; border: none; outline: none; background: transparent;
       font-size: 14px; color: #1f1f1f; padding: 0; font-family: inherit; }
#zoom { flex: none; font-size: 11px; color: #45474a; padding: 2px 8px; border-radius: 10px; background: #e3e6ea; margin-left: 6px; }
#zoom.hidden { display: none; }
svg { display: block; }
"#;

const ICON_BACK: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" fill="#474747"/></svg>"##;
const ICON_FWD: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z" fill="#474747"/></svg>"##;
const ICON_RELOAD: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="#474747"/></svg>"##;
const ICON_STOP: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="#474747"/></svg>"##;
const ICON_HOME: &str = r##"<svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 5.69l5 4.5V18h-2v-6H9v6H7v-7.81l5-4.5M12 3 2 12h3v8h6v-6h2v6h6v-8h3L12 3z" fill="#474747"/></svg>"##;
const ICON_CLOSE: &str = r##"<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 9 9M9 1 1 9" stroke="#474747" stroke-width="1.4"/></svg>"##;
const ICON_PLUS: &str = r##"<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12M1 7h12" stroke="#474747" stroke-width="1.6"/></svg>"##;
const ICON_LOCK: &str = r##"<svg width="14" height="14" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10z" fill="#5f6368"/></svg>"##;
const ICON_INFO: &str = r##"<svg width="14" height="14" viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="#5f6368"/></svg>"##;

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
        let html = format!(
            r#"<!DOCTYPE html><html><head><style>{CSS}</style></head><body>
<div id="strip"></div>
<div id="toolbar"><div id="nav" style="display:flex"></div>
  <div id="omnibox"><div id="lock"></div><input id="url" type="text" spellcheck="false" placeholder="Suchen oder Webadresse eingeben"><div id="zoom" class="hidden" data-action="zoom"></div></div>
</div></body></html>"#
        );
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
                if t.loading { "Lädt …".to_string() } else { "Neuer Tab".to_string() }
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
                r#"<div class="{class}" data-action="select" data-tab="{id}" title="{t}">{icon}<div class="title">{t}</div><div class="close" data-action="close" data-tab="{id}">{ICON_CLOSE}</div></div>"#,
                id = t.id,
                t = esc(&title)
            ));
        }
        html.push_str(&format!(r#"<div id="new" data-action="new" title="Neuer Tab">{ICON_PLUS}</div>"#));
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
        let nav_html = format!(
            r#"<div class="btn{b}" data-action="back" title="Zurück">{ICON_BACK}</div><div class="btn{f}" data-action="forward" title="Vorwärts">{ICON_FWD}</div>{reload}<div class="btn" data-action="home" title="Startseite">{ICON_HOME}</div>"#,
            b = if view.can_back { "" } else { " off" },
            f = if view.can_forward { "" } else { " off" },
            reload = if view.loading {
                format!(r#"<div class="btn" data-action="stop" title="Laden abbrechen">{ICON_STOP}</div>"#)
            } else {
                format!(r#"<div class="btn" data-action="reload" title="Neu laden (F5)">{ICON_RELOAD}</div>"#)
            }
        );
        let nav = self.nav;
        self.doc.mutate().set_inner_html(nav, &nav_html);

        if let Some(lock) = self.doc.get_element_by_id("lock") {
            let icon = if view.secure { ICON_LOCK } else { ICON_INFO };
            self.doc.mutate().set_inner_html(lock, icon);
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
