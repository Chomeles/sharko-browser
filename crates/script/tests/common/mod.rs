#![allow(dead_code)]

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::protocol::{NetRequest, NetResponse};
use script::{RuntimeOptions, ScriptHost, ScriptRuntime};

#[derive(Debug, Clone, PartialEq)]
pub struct Nav {
    pub url: String,
    pub replace: bool,
    pub method: String,
    pub body: Option<Vec<u8>>,
    pub content_type: Option<String>,
}

/// Records everything the runtime asks of the host.
#[derive(Default)]
pub struct MockHost {
    pub fetches: RefCell<Vec<NetRequest>>,
    pub aborted: RefCell<Vec<u64>>,
    pub console: RefCell<Vec<(String, String)>>,
    pub navigations: RefCell<Vec<Nav>>,
    pub new_tabs: RefCell<Vec<String>>,
    pub history: RefCell<Vec<i32>>,
    pub url_changes: RefCell<Vec<String>>,
    pub titles: RefCell<Vec<String>>,
    pub redraws: Cell<u32>,
    pub cookies: RefCell<HashMap<String, String>>,
    /// URL -> (content type, body) served by `serve_fetches` and `fetch_sync`.
    pub files: RefCell<HashMap<String, (String, String)>>,
    pub sync_fetches: RefCell<Vec<NetRequest>>,
    pub history_pushes: RefCell<Vec<(String, bool)>>,
    pub referrer: RefCell<String>,
    pub clipboard: RefCell<Vec<String>>,
}

impl ScriptHost for MockHost {
    fn fetch(&self, req: NetRequest) {
        self.fetches.borrow_mut().push(req);
    }
    fn abort_fetch(&self, id: u64) {
        self.aborted.borrow_mut().push(id);
    }
    fn get_cookies(&self, _url: &str) -> String {
        let c = self.cookies.borrow();
        let mut v: Vec<String> = c.iter().map(|(k, v)| format!("{k}={v}")).collect();
        v.sort();
        v.join("; ")
    }
    fn set_cookie(&self, _url: &str, cookie: &str) {
        let pair = cookie.split(';').next().unwrap_or("");
        if let Some((k, v)) = pair.split_once('=') {
            self.cookies
                .borrow_mut()
                .insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    fn navigate(
        &self,
        url: &str,
        replace: bool,
        method: &str,
        body: Option<Vec<u8>>,
        content_type: Option<String>,
    ) {
        self.navigations.borrow_mut().push(Nav {
            url: url.to_string(),
            replace,
            method: method.to_string(),
            body,
            content_type,
        });
    }
    fn open_new_tab(&self, url: &str) {
        self.new_tabs.borrow_mut().push(url.to_string());
    }
    fn history_go(&self, delta: i32) {
        self.history.borrow_mut().push(delta);
    }
    fn url_changed(&self, url: &str) {
        self.url_changes.borrow_mut().push(url.to_string());
    }
    fn title_changed(&self, title: &str) {
        self.titles.borrow_mut().push(title.to_string());
    }
    fn console(&self, level: &str, message: &str) {
        if std::env::var_os("SCRIPT_TEST_VERBOSE").is_some() {
            eprintln!("[console.{level}] {message}");
        }
        self.console
            .borrow_mut()
            .push((level.to_string(), message.to_string()));
    }
    fn request_redraw(&self) {
        self.redraws.set(self.redraws.get() + 1);
    }
    fn history_push(&self, url: &str, replace: bool) {
        self.history_pushes
            .borrow_mut()
            .push((url.to_string(), replace));
    }
    fn referrer(&self) -> String {
        self.referrer.borrow().clone()
    }
    fn clipboard_write(&self, text: &str) {
        self.clipboard.borrow_mut().push(text.to_string());
    }
    fn fetch_sync(&self, req: NetRequest) -> Option<NetResponse> {
        let resp = self.respond(&req);
        self.sync_fetches.borrow_mut().push(req);
        Some(resp)
    }
}

impl MockHost {
    pub fn errors(&self) -> Vec<String> {
        self.console
            .borrow()
            .iter()
            .filter(|(l, _)| l == "error")
            .map(|(_, m)| m.clone())
            .collect()
    }
    pub fn logs(&self) -> Vec<String> {
        self.console
            .borrow()
            .iter()
            .map(|(_, m)| m.clone())
            .collect()
    }
    /// Response for `req` from `files` (404 otherwise).
    pub fn respond(&self, req: &NetRequest) -> NetResponse {
        let file = self.files.borrow().get(&req.url).cloned();
        match file {
            Some((ct, body)) => NetResponse {
                id: req.id,
                status: 200,
                status_text: "OK".into(),
                url: req.url.clone(),
                headers: vec![("content-type".into(), ct)],
                body: body.into_bytes(),
                ..Default::default()
            },
            None => NetResponse {
                id: req.id,
                status: 404,
                status_text: "Not Found".into(),
                url: req.url.clone(),
                ..Default::default()
            },
        }
    }

    pub fn serve(&self, url: &str, content_type: &str, body: &str) {
        self.files.borrow_mut().insert(
            url.to_string(),
            (content_type.to_string(), body.to_string()),
        );
    }
}

pub const DOC_URL: &str = "https://example.com/dir/page.html";

pub fn make_doc(html: &str) -> HtmlDocument {
    let mut config = DocumentConfig {
        base_url: Some(DOC_URL.to_string()),
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        ..Default::default()
    };
    script::configure_document(&mut config);
    HtmlDocument::from_html(html, config)
}

pub fn options(profile: PathBuf, js: bool) -> RuntimeOptions {
    RuntimeOptions {
        document_url: DOC_URL.to_string(),
        user_agent: "TestBrowser/1.0".to_string(),
        profile_dir: profile,
        load_js_layer: js,
    }
}

pub struct Env {
    pub host: Rc<MockHost>,
    pub rt: ScriptRuntime,
    pub doc: HtmlDocument,
}

impl Env {
    pub fn new(html: &str) -> Env {
        Self::with_profile(html, PathBuf::new(), false)
    }

    pub fn with_profile(html: &str, profile: PathBuf, js: bool) -> Env {
        let host = Rc::new(MockHost::default());
        let rt = ScriptRuntime::new(host.clone(), options(profile, js));
        let doc = make_doc(html);
        Env { host, rt, doc }
    }

    /// Evaluate and return the stringified result; panics on exceptions.
    pub fn eval(&mut self, src: &str) -> String {
        match self.rt.eval(&mut self.doc, src) {
            Ok(s) => s,
            Err(e) => panic!("eval failed: {e}\nsource: {src}"),
        }
    }

    pub fn eval_err(&mut self, src: &str) -> String {
        match self.rt.eval(&mut self.doc, src) {
            Ok(s) => panic!("expected an exception, got {s}"),
            Err(e) => e,
        }
    }

    /// Serve pending fetches from `host.files` (404 otherwise) until none are left.
    pub fn serve_fetches(&mut self) -> usize {
        let mut served = 0;
        loop {
            let reqs: Vec<NetRequest> = std::mem::take(&mut *self.host.fetches.borrow_mut());
            if reqs.is_empty() {
                return served;
            }
            for req in reqs {
                served += 1;
                let resp = self.host.respond(&req);
                self.rt.deliver_fetch(&mut self.doc, resp);
            }
        }
    }
}

/// A unique temporary directory for a test.
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("script-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
