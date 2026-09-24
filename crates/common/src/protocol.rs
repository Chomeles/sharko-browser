//! Message types exchanged between the processes.
//!
//! Process model (like Chromium):
//!
//! ```text
//!                 +--------------------+
//!                 |  Browser process   |  UI, tabs, session history, compositor (GPU)
//!                 +--------------------+
//!                   |  ToRenderer  ^ FromRenderer          ToNetwork / FromNetwork
//!                   v              |                                 |
//!  +--------------------------+    |     +----------------------------v--+
//!  | Renderer process (1/tab) |----+     |  Network process (1)          |
//!  | DOM, CSS, layout, JS(V8) |<-------->|  HTTP/1.1/2/3, TLS, cache,    |
//!  | paint -> DisplayList     |  direct  |  cookies                      |
//!  +--------------------------+  channel +-------------------------------+
//! ```
//!
//! The browser process spawns the network process, then hands every renderer the
//! network process' endpoint so that resource loads don't hop through the browser.

use crate::display_list::DisplayList;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/// What a request is for (affects Accept headers, priorities, and caching).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Destination {
    Document,
    Script,
    Style,
    Image,
    Font,
    /// `fetch()` / `XMLHttpRequest`
    Fetch,
    Media,
    Other,
}

/// Mirrors the Fetch spec's `RequestCache` modes.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheMode {
    #[default]
    Default,
    NoStore,
    Reload,
    NoCache,
    ForceCache,
    OnlyIfCached,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NetRequest {
    /// Unique per requesting client connection.
    pub id: u64,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    pub body: Option<Vec<u8>>,
    pub destination: Destination,
    pub referrer: Option<String>,
    /// Send/store cookies for this request.
    pub credentials: bool,
    /// Follow redirects automatically (true for everything except `redirect: "manual"`).
    pub follow_redirects: bool,
    pub cache_mode: CacheMode,
}

impl NetRequest {
    pub fn get(id: u64, url: impl Into<String>, destination: Destination) -> Self {
        Self {
            id,
            url: url.into(),
            method: "GET".into(),
            headers: Vec::new(),
            body: None,
            destination,
            referrer: None,
            credentials: true,
            follow_redirects: true,
            cache_mode: CacheMode::Default,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct NetResponse {
    pub id: u64,
    /// 0 on network error (then `error` is set).
    pub status: u16,
    pub status_text: String,
    /// Final URL after redirects.
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Decoded (decompressed) body.
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub error: Option<String>,
    pub from_cache: bool,
    /// e.g. "HTTP/1.1", "HTTP/2", "HTTP/3"
    pub http_version: String,
    /// Total time in milliseconds.
    pub duration_ms: f64,
}

impl NetResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    pub fn is_ok(&self) -> bool {
        self.error.is_none() && (200..400).contains(&self.status)
    }
}

/// Client -> network process.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ToNetwork {
    Fetch(NetRequest),
    Abort(u64),
    /// Reply: `FromNetwork::Cookies` with the same id (the `document.cookie` string).
    GetCookies { id: u64, url: String },
    /// `document.cookie = "..."`
    SetCookie { url: String, cookie: String },
    /// Browser only: persist state and exit.
    Shutdown,
}

/// Network process -> client.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum FromNetwork {
    Response(NetResponse),
    Cookies { id: u64, cookies: String },
}

// ---------------------------------------------------------------------------
// Browser <-> renderer
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct ViewportInfo {
    /// Physical pixels.
    pub width: u32,
    pub height: u32,
    /// Device pixel ratio (HiDPI factor).
    pub scale: f32,
    /// Page zoom (1.0 = 100%).
    pub zoom: f32,
    pub dark_mode: bool,
}

impl Default for ViewportInfo {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 800,
            scale: 1.0,
            zoom: 1.0,
            dark_mode: false,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

/// Mouse button numbers follow the DOM: 0 = primary, 1 = middle (aux), 2 = secondary,
/// 3 = back, 4 = forward.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum InputEvent {
    /// Coordinates are in CSS pixels relative to the viewport (not scrolled).
    MouseMove { x: f32, y: f32, buttons: u8, mods: Modifiers },
    MouseDown { x: f32, y: f32, button: u8, buttons: u8, mods: Modifiers },
    MouseUp { x: f32, y: f32, button: u8, buttons: u8, mods: Modifiers },
    MouseLeave,
    /// Scroll deltas in CSS pixels (positive = scroll down/right).
    Wheel { x: f32, y: f32, dx: f64, dy: f64, mods: Modifiers },
    /// `key` is the DOM `KeyboardEvent.key` value ("a", "Enter", "ArrowLeft", ...),
    /// `code` the DOM `KeyboardEvent.code` ("KeyA", ...), `text` the produced text.
    KeyDown { key: String, code: String, text: Option<String>, repeat: bool, location: u8, mods: Modifiers },
    KeyUp { key: String, code: String, location: u8, mods: Modifiers },
    ImeEnabled,
    ImePreedit { text: String, cursor: Option<(usize, usize)> },
    ImeCommit(String),
    ImeDisabled,
    /// Window focus changed.
    Focus(bool),
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorKind {
    Default,
    Pointer,
    Text,
    Wait,
    Progress,
    Crosshair,
    Move,
    NotAllowed,
    Grab,
    Grabbing,
    EwResize,
    NsResize,
    NeswResize,
    NwseResize,
    ColResize,
    RowResize,
    Help,
    ZoomIn,
    ZoomOut,
    None,
}

/// Browser -> renderer.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ToRenderer {
    /// First message. `net_endpoint` is the network process endpoint to connect to.
    Init {
        net_endpoint: String,
        viewport: ViewportInfo,
        user_agent: String,
        /// Directory for per-profile data (localStorage, ...)
        profile_dir: String,
        /// Disable JavaScript entirely.
        javascript: bool,
    },
    /// Load a new document into this renderer (replaces the current one).
    Navigate {
        url: String,
        method: String,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
    },
    /// Load the given HTML string as a document at `url` (used for about: pages / tests).
    LoadHtml { url: String, html: String },
    Stop,
    Reload,
    Resize(ViewportInfo),
    Input(InputEvent),
    /// Run JS in the page (headless `--eval`, devtools console). Reply: `EvalResult`.
    Eval { id: u64, source: String },
    /// Reply: `Dom` with the serialized document.
    GetDom { id: u64 },
    /// Ask for a frame covering the full page height (for full-page screenshots).
    /// Reply: `Frame` with `full_page = true`.
    CaptureFullPage { id: u64, max_height: u32 },
    /// Back/forward to a same-document history entry (created by pushState or a
    /// fragment navigation): update the URL and fire `popstate` instead of reloading.
    HistoryTraverse { url: String, index: u32 },
    Shutdown,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadEvent {
    /// A navigation started (network request sent).
    Started,
    /// The response arrived and the DOM was built.
    DomContentLoaded,
    /// All subresources loaded and the `load` event fired.
    Load,
    /// Navigation failed (network error, bad status, ...).
    Failed,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Frame {
    /// Monotonic per renderer.
    pub seq: u64,
    /// Physical size the frame was painted for.
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    /// Full document size in CSS px (for scrollbars / full page screenshots).
    pub content_width: f32,
    pub content_height: f32,
    pub scroll_x: f32,
    pub scroll_y: f32,
    /// Set when this frame answers `CaptureFullPage`.
    pub capture_id: Option<u64>,
    pub list: DisplayList,
}

/// Renderer -> browser.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum FromRenderer {
    Ready,
    Frame(Box<Frame>),
    Title(String),
    /// The document URL changed (navigation committed, pushState, hash change).
    UrlChanged(String),
    Load { event: LoadEvent, url: String, error: Option<String> },
    /// The page wants to navigate (link click, form submit, `location = ...`,
    /// `window.open`). The browser decides where (same renderer, new tab, ...).
    OpenUrl {
        url: String,
        method: String,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
        new_tab: bool,
        replace: bool,
    },
    /// `history.back()` etc.
    HistoryGo(i32),
    /// `history.pushState` / `replaceState` / fragment navigation created (or replaced)
    /// a same-document session history entry.
    HistoryPush { url: String, replace: bool },
    Cursor(CursorKind),
    Console { level: String, message: String },
    EvalResult { id: u64, ok: bool, value: String },
    Dom { id: u64, html: String },
    /// Renderer wants the browser to show/hide the IME (text input focused).
    ImeAllowed(bool),
    /// Performance numbers for the last load (ms).
    Metrics { parse_ms: f64, script_ms: f64, style_layout_ms: f64, paint_ms: f64 },
}
