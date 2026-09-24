//! The browser process: spawns and supervises the network service and one renderer
//! process per tab, keeps each tab's session history and latest frame, and routes
//! messages. Used by both the windowed UI and the headless driver.

pub mod headless;
pub mod update;

use common::display_list::ResourceCache;
use common::ipc::{self, IpcListener, IpcSender};
use common::protocol::{
    CursorKind, Frame, FromRenderer, LoadEvent, ToRenderer, ViewportInfo,
};
use crossbeam_channel::{Receiver, Sender};
use netstack::NetClient;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::process::Child;
use std::time::{Duration, Instant};

pub type TabId = u32;

#[derive(Clone, Debug)]
pub struct BrowserOptions {
    /// Run network service and renderers as threads instead of processes (debugging).
    pub single_process: bool,
    pub profile_dir: PathBuf,
    pub javascript: bool,
    pub user_agent: String,
    /// Print page console messages to stderr.
    pub verbose: bool,
    /// Version of the running build (for the updater).
    pub app_version: String,
    /// Check for and install updates in the background.
    pub auto_update: bool,
}

impl Default for BrowserOptions {
    fn default() -> Self {
        Self {
            single_process: false,
            profile_dir: default_profile_dir(),
            javascript: true,
            user_agent: common::USER_AGENT.to_string(),
            verbose: false,
            app_version: String::new(),
            auto_update: true,
        }
    }
}

/// `%LOCALAPPDATA%\browser\profile` on Windows, `~/.local/share/browser/profile` on Linux,
/// `~/Library/Application Support/browser/profile` on macOS.
pub fn default_profile_dir() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("browser")
        .join("profile")
}

/// Events delivered to the embedder (UI / headless driver).
#[derive(Debug)]
pub enum BrowserEvent {
    Tab(TabId, FromRenderer),
    /// The renderer process went away (crash or kill).
    TabCrashed(TabId),
    /// Raw message from a renderer connection (`None` = disconnected). Internal:
    /// [`Browser::process_event`] turns it into `Tab` / `TabCrashed`, or drops it when it
    /// comes from a renderer that has since been replaced.
    #[doc(hidden)]
    Renderer {
        tab: TabId,
        epoch: u32,
        msg: Option<FromRenderer>,
    },
}

#[derive(Clone, Debug)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    /// Entries with the same `doc_seq` belong to one document (pushState / fragments):
    /// moving between them doesn't reload.
    pub doc_seq: u64,
    /// Position of this entry among its document's entries (for `popstate` state).
    pub doc_index: u32,
}

fn same_document(a: &str, b: &str) -> bool {
    match (url_without_fragment(a), url_without_fragment(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn url_without_fragment(u: &str) -> Option<&str> {
    if u.starts_with("about:") {
        return None;
    }
    Some(u.split('#').next().unwrap_or(u))
}

pub struct Tab {
    pub id: TabId,
    sender: IpcSender<ToRenderer>,
    /// Incremented whenever the renderer is replaced (crash recovery), so that late
    /// messages from the old one are ignored.
    epoch: u32,
    child: Option<Child>,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub crashed: bool,
    pub history: Vec<HistoryEntry>,
    pub history_index: usize,
    pub viewport: ViewportInfo,
    /// Latest frame from the renderer (resources already moved into `resources`).
    pub frame: Option<Box<Frame>>,
    pub resources: ResourceCache,
    pub cursor: CursorKind,
    pub ime_allowed: bool,
    pub load_started: Option<Instant>,
    pub dom_content_loaded: Option<Duration>,
    pub load_finished: Option<Duration>,
    pub first_frame: Option<Duration>,
    pub frames: u64,
    pub console: Vec<(String, String)>,
    /// Last `Metrics` report: (parse, initial script, style+layout, paint) in ms.
    pub metrics: Option<(f64, f64, f64, f64)>,
}

impl Tab {
    pub fn send(&self, msg: ToRenderer) {
        let _ = self.sender.send(&msg);
    }
    pub fn can_go_back(&self) -> bool {
        self.history_index > 0
    }
    pub fn can_go_forward(&self) -> bool {
        self.history_index + 1 < self.history.len()
    }
}

pub struct Browser {
    pub opts: BrowserOptions,
    net_endpoint: String,
    net_child: Option<Child>,
    net: NetClient,
    tabs: HashMap<TabId, Tab>,
    order: Vec<TabId>,
    next_tab: TabId,
    next_doc_seq: u64,
    events_tx: Sender<BrowserEvent>,
    pub events: Receiver<BrowserEvent>,
}

impl Browser {
    /// Start the network service (process, or thread in single-process mode).
    pub fn new(opts: BrowserOptions) -> io::Result<Self> {
        std::fs::create_dir_all(&opts.profile_dir)?;
        let net_endpoint = ipc::random_endpoint("net");
        let mut net_child = None;
        if opts.single_process {
            let ep = net_endpoint.clone();
            let profile = opts.profile_dir.clone();
            let listener = IpcListener::bind(&ep)?;
            std::thread::Builder::new()
                .name("network-service".into())
                .spawn(move || netstack::run_service(listener, profile))?;
        } else {
            net_child = Some(ipc::spawn_child(
                "network",
                &net_endpoint,
                &[format!("--profile={}", opts.profile_dir.display())],
            )?);
        }
        // Don't wait for the network process to come up: requests are queued until it
        // accepts the connection (startup runs in parallel with window/GPU creation).
        let net = NetClient::connect_in_background(&net_endpoint, Duration::from_secs(20));
        let (events_tx, events) = crossbeam_channel::unbounded();
        Ok(Self {
            opts,
            net_endpoint,
            net_child,
            net,
            tabs: HashMap::new(),
            order: Vec::new(),
            next_tab: 1,
            next_doc_seq: 1,
            events_tx,
            events,
        })
    }

    pub fn net(&self) -> &NetClient {
        &self.net
    }

    pub fn tab(&self, id: TabId) -> Option<&Tab> {
        self.tabs.get(&id)
    }
    pub fn tab_mut(&mut self, id: TabId) -> Option<&mut Tab> {
        self.tabs.get_mut(&id)
    }
    /// Tabs in creation / strip order.
    pub fn tab_ids(&self) -> &[TabId] {
        &self.order
    }

    /// Start a renderer process (or thread) for tab `id` and send it `Init`.
    fn spawn_renderer(
        &self,
        id: TabId,
        epoch: u32,
        viewport: ViewportInfo,
    ) -> io::Result<(IpcSender<ToRenderer>, Option<Child>)> {
        let listener = IpcListener::new("renderer")?;
        let endpoint = listener.endpoint();
        let mut child = None;
        if self.opts.single_process {
            let ep = endpoint.clone();
            let verbose = self.opts.verbose;
            std::thread::Builder::new()
                .name(format!("renderer-{id}"))
                .stack_size(32 * 1024 * 1024)
                .spawn(move || engine::renderer_main(&ep, verbose))?;
        } else {
            let mut args = Vec::new();
            if self.opts.verbose {
                args.push("--verbose".to_string());
            }
            child = Some(ipc::spawn_child("renderer", &endpoint, &args)?);
        }

        // Never block on the renderer starting up: the connection is accepted in the
        // background and messages (Init, Navigate, …) are queued until then. A renderer
        // that doesn't connect in time is reported as crashed.
        let tx = self.events_tx.clone();
        let sender: IpcSender<ToRenderer> = listener.accept_in_background(
            Duration::from_secs(20),
            &format!("tab-{id}-ipc"),
            move |msg: Option<FromRenderer>| {
                let _ = tx.send(BrowserEvent::Renderer { tab: id, epoch, msg });
            },
        );
        let _ = sender.send(&ToRenderer::Init {
            net_endpoint: self.net_endpoint.clone(),
            viewport,
            user_agent: self.opts.user_agent.clone(),
            profile_dir: self.opts.profile_dir.display().to_string(),
            javascript: self.opts.javascript,
        });
        Ok((sender, child))
    }

    /// Create a tab with its own renderer and start loading `url`.
    pub fn new_tab(&mut self, url: &str, viewport: ViewportInfo) -> io::Result<TabId> {
        let id = self.next_tab;
        self.next_tab += 1;
        let (sender, child) = self.spawn_renderer(id, 0, viewport)?;
        let tab = Tab {
            id,
            sender,
            epoch: 0,
            child,
            url: url.to_string(),
            title: String::new(),
            loading: false,
            crashed: false,
            history: Vec::new(),
            history_index: 0,
            viewport,
            frame: None,
            resources: ResourceCache::default(),
            cursor: CursorKind::Default,
            ime_allowed: false,
            load_started: None,
            dom_content_loaded: None,
            load_finished: None,
            first_frame: None,
            frames: 0,
            console: Vec::new(),
            metrics: None,
        };
        self.tabs.insert(id, tab);
        self.order.push(id);
        if !url.is_empty() {
            self.navigate(id, url);
        }
        Ok(id)
    }

    /// Replace a crashed tab's renderer with a fresh one. The tab keeps its history; the
    /// new renderer shows `html` (e.g. an error page) or reloads the current entry.
    pub fn respawn_tab(&mut self, id: TabId, html: Option<String>) -> io::Result<()> {
        let (viewport, epoch) = match self.tabs.get(&id) {
            Some(t) => (t.viewport, t.epoch.wrapping_add(1)),
            None => return Ok(()),
        };
        let (sender, child) = self.spawn_renderer(id, epoch, viewport)?;
        let tab = self.tabs.get_mut(&id).expect("tab exists");
        tab.epoch = epoch;
        if let Some(mut old) = tab.child.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        tab.sender = sender;
        tab.child = child;
        tab.crashed = false;
        tab.frame = None;
        tab.resources = ResourceCache::default();
        let url = tab.url.clone();
        match html {
            Some(html) => tab.send(ToRenderer::LoadHtml { url, html }),
            None => tab.send(ToRenderer::Navigate {
                url,
                method: "GET".into(),
                body: None,
                content_type: None,
            }),
        }
        Ok(())
    }

    pub fn close_tab(&mut self, id: TabId) {
        if let Some(mut tab) = self.tabs.remove(&id) {
            tab.send(ToRenderer::Shutdown);
            if let Some(mut child) = tab.child.take() {
                // Give it a moment to flush localStorage, then make sure it's gone.
                std::thread::spawn(move || {
                    for _ in 0..50 {
                        if let Ok(Some(_)) = child.try_wait() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                });
            }
        }
        self.order.retain(|t| *t != id);
    }

    /// User-initiated navigation (address bar, link): new history entry.
    pub fn navigate(&mut self, id: TabId, url: &str) {
        self.open(id, url, "GET", None, None, false);
    }

    fn open(
        &mut self,
        id: TabId,
        url: &str,
        method: &str,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
        replace: bool,
    ) {
        let next_seq = self.next_doc_seq;
        let Some(tab) = self.tabs.get_mut(&id) else { return };
        let current = tab.history.get(tab.history_index).cloned();
        // Fragment-only change of a GET: same document, no reload.
        let same_doc = method.eq_ignore_ascii_case("GET")
            && url.contains('#')
            && current.as_ref().is_some_and(|c| same_document(&c.url, url));
        let entry = match (&current, same_doc) {
            (Some(c), true) => HistoryEntry {
                url: url.to_string(),
                title: c.title.clone(),
                doc_seq: c.doc_seq,
                doc_index: if replace { c.doc_index } else { c.doc_index + 1 },
            },
            _ => {
                self.next_doc_seq += 1;
                HistoryEntry {
                    url: url.to_string(),
                    title: String::new(),
                    doc_seq: next_seq,
                    doc_index: 0,
                }
            }
        };
        if tab.history.is_empty() {
            tab.history.push(entry);
            tab.history_index = 0;
        } else if replace {
            tab.history[tab.history_index] = entry;
        } else {
            tab.history.truncate(tab.history_index + 1);
            tab.history.push(entry);
            tab.history_index = tab.history.len() - 1;
        }
        tab.url = url.to_string();
        if !same_doc {
            tab.loading = true;
            tab.load_started = Some(Instant::now());
            tab.dom_content_loaded = None;
            tab.load_finished = None;
        }
        tab.send(ToRenderer::Navigate {
            url: url.to_string(),
            method: method.to_string(),
            body,
            content_type,
        });
    }

    pub fn go(&mut self, id: TabId, delta: i32) {
        let Some(tab) = self.tabs.get_mut(&id) else { return };
        if delta == 0 {
            tab.send(ToRenderer::Reload);
            return;
        }
        let target = tab.history_index as i64 + delta as i64;
        if target < 0 || target >= tab.history.len() as i64 {
            return;
        }
        let cur_seq = tab.history[tab.history_index].doc_seq;
        tab.history_index = target as usize;
        let entry = tab.history[tab.history_index].clone();
        tab.url = entry.url.clone();
        if entry.doc_seq == cur_seq {
            tab.send(ToRenderer::HistoryTraverse {
                url: entry.url,
                index: entry.doc_index,
            });
        } else {
            // Loading another document: its old same-document entries become a new one.
            let new_seq = self.next_doc_seq;
            self.next_doc_seq += 1;
            let old_seq = entry.doc_seq;
            for e in tab.history.iter_mut().filter(|e| e.doc_seq == old_seq) {
                e.doc_seq = new_seq;
            }
            tab.history[tab.history_index].doc_index = 0;
            tab.loading = true;
            tab.load_started = Some(Instant::now());
            tab.send(ToRenderer::Navigate {
                url: entry.url,
                method: "GET".into(),
                body: None,
                content_type: None,
            });
        }
    }

    pub fn reload(&mut self, id: TabId) {
        if let Some(tab) = self.tabs.get_mut(&id) {
            tab.loading = true;
            tab.load_started = Some(Instant::now());
            tab.send(ToRenderer::Reload);
        }
    }

    pub fn stop(&mut self, id: TabId) {
        if let Some(tab) = self.tabs.get_mut(&id) {
            tab.loading = false;
            tab.send(ToRenderer::Stop);
        }
    }

    pub fn resize(&mut self, id: TabId, viewport: ViewportInfo) {
        if let Some(tab) = self.tabs.get_mut(&id) {
            if tab.viewport != viewport {
                tab.viewport = viewport;
                tab.send(ToRenderer::Resize(viewport));
            }
        }
    }

    pub fn send(&self, id: TabId, msg: ToRenderer) {
        if let Some(tab) = self.tabs.get(&id) {
            tab.send(msg);
        }
    }

    /// Apply an event to the browser state. Returns an optional follow-up the embedder
    /// should know about (e.g. a new tab was opened).
    pub fn process_event(&mut self, ev: BrowserEvent) -> Option<BrowserEvent> {
        let ev = match ev {
            BrowserEvent::Renderer { tab, epoch, msg } => {
                if self.tabs.get(&tab).is_none_or(|t| t.epoch != epoch) {
                    return None; // closed tab or replaced renderer
                }
                match msg {
                    Some(m) => BrowserEvent::Tab(tab, m),
                    None => BrowserEvent::TabCrashed(tab),
                }
            }
            other => other,
        };
        match ev {
            BrowserEvent::TabCrashed(id) => {
                if let Some(tab) = self.tabs.get_mut(&id) {
                    tab.crashed = true;
                    tab.loading = false;
                }
                Some(BrowserEvent::TabCrashed(id))
            }
            BrowserEvent::Renderer { .. } => None, // converted above
            BrowserEvent::Tab(id, msg) => {
                let verbose = self.opts.verbose;
                let tab = self.tabs.get_mut(&id)?;
                match msg {
                    FromRenderer::Frame(mut frame) => {
                        tab.resources.ingest(&mut frame.list);
                        tab.frames += 1;
                        if tab.first_frame.is_none() {
                            tab.first_frame = tab.load_started.map(|t| t.elapsed());
                        }
                        let is_capture = frame.capture_id.is_some();
                        if is_capture {
                            return Some(BrowserEvent::Tab(id, FromRenderer::Frame(frame)));
                        }
                        tab.frame = Some(frame);
                        None
                    }
                    FromRenderer::Title(t) => {
                        tab.title = t.clone();
                        if let Some(e) = tab.history.get_mut(tab.history_index) {
                            e.title = t.clone();
                        }
                        Some(BrowserEvent::Tab(id, FromRenderer::Title(t)))
                    }
                    FromRenderer::UrlChanged(u) => {
                        tab.url = u.clone();
                        if let Some(e) = tab.history.get_mut(tab.history_index) {
                            e.url = u.clone();
                        }
                        Some(BrowserEvent::Tab(id, FromRenderer::UrlChanged(u)))
                    }
                    FromRenderer::Load { event, url, error } => {
                        match event {
                            LoadEvent::Started => tab.loading = true,
                            LoadEvent::DomContentLoaded => {
                                tab.dom_content_loaded = tab.load_started.map(|t| t.elapsed())
                            }
                            LoadEvent::Load | LoadEvent::Failed => {
                                tab.loading = false;
                                tab.load_finished = tab.load_started.map(|t| t.elapsed());
                            }
                        }
                        Some(BrowserEvent::Tab(id, FromRenderer::Load { event, url, error }))
                    }
                    FromRenderer::OpenUrl {
                        url,
                        method,
                        body,
                        content_type,
                        new_tab,
                        replace,
                    } => {
                        if new_tab {
                            let vp = tab.viewport;
                            if let Ok(new_id) = self.new_tab(&url, vp) {
                                return Some(BrowserEvent::Tab(
                                    new_id,
                                    FromRenderer::UrlChanged(url),
                                ));
                            }
                            None
                        } else {
                            self.open(id, &url, &method, body, content_type, replace);
                            Some(BrowserEvent::Tab(id, FromRenderer::UrlChanged(url)))
                        }
                    }
                    FromRenderer::HistoryGo(delta) => {
                        self.go(id, delta);
                        None
                    }
                    FromRenderer::HistoryPush { url, replace } => {
                        if let Some(cur) = tab.history.get(tab.history_index).cloned() {
                            let entry = HistoryEntry {
                                url: url.clone(),
                                title: cur.title.clone(),
                                doc_seq: cur.doc_seq,
                                doc_index: if replace { cur.doc_index } else { cur.doc_index + 1 },
                            };
                            if replace {
                                tab.history[tab.history_index] = entry;
                            } else {
                                tab.history.truncate(tab.history_index + 1);
                                tab.history.push(entry);
                                tab.history_index = tab.history.len() - 1;
                            }
                        }
                        tab.url = url.clone();
                        Some(BrowserEvent::Tab(id, FromRenderer::UrlChanged(url)))
                    }
                    FromRenderer::Cursor(c) => {
                        tab.cursor = c;
                        Some(BrowserEvent::Tab(id, FromRenderer::Cursor(c)))
                    }
                    FromRenderer::ImeAllowed(a) => {
                        tab.ime_allowed = a;
                        Some(BrowserEvent::Tab(id, FromRenderer::ImeAllowed(a)))
                    }
                    FromRenderer::Console { level, message } => {
                        if verbose {
                            eprintln!("[tab {id}] console.{level}: {message}");
                        }
                        if tab.console.len() < 10_000 {
                            tab.console.push((level.clone(), message.clone()));
                        }
                        Some(BrowserEvent::Tab(id, FromRenderer::Console { level, message }))
                    }
                    FromRenderer::Metrics { parse_ms, script_ms, style_layout_ms, paint_ms } => {
                        tab.metrics = Some((parse_ms, script_ms, style_layout_ms, paint_ms));
                        None
                    }
                    other => Some(BrowserEvent::Tab(id, other)),
                }
            }
        }
    }

    pub fn shutdown(&mut self) {
        // Renderers first (they flush localStorage / cookies through the network
        // service), then the network service.
        let mut children = Vec::new();
        for id in self.order.clone() {
            if let Some(mut tab) = self.tabs.remove(&id) {
                tab.send(ToRenderer::Shutdown);
                if let Some(c) = tab.child.take() {
                    children.push(c);
                }
            }
        }
        self.order.clear();
        let deadline = Instant::now() + Duration::from_millis(1500);
        for mut c in children {
            loop {
                if let Ok(Some(_)) = c.try_wait() {
                    break;
                }
                if Instant::now() > deadline {
                    let _ = c.kill();
                    let _ = c.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        self.net.shutdown_service();
        if let Some(mut child) = self.net_child.take() {
            for _ in 0..100 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Main of the `--type=network` process.
pub fn network_main(endpoint: &str, profile_dir: PathBuf) {
    match IpcListener::bind(endpoint) {
        Ok(listener) => netstack::run_service(listener, profile_dir),
        Err(e) => eprintln!("[network] cannot listen: {e}"),
    }
}
