//! [`BlitzNetProvider`]: Blitz' `NetProvider` on top of a [`NetClient`].
//!
//! * Blitz requests are mapped to [`NetRequest`]s; the destination is inferred from the
//!   `Accept` header or the URL extension (css → Style, images → Image, fonts → Font,
//!   js → Script, else Other). Form bodies are encoded according to `content_type`
//!   (urlencoded, multipart, text/plain).
//! * A successful response (2xx/3xx, data:, file:) is delivered with
//!   `handler.bytes(final_url, body)`, then the waker is called.
//! * On failure the error is logged at debug level. By default the handler then receives
//!   an **empty body** instead of simply being dropped: blitz-dom 0.3 only clears its
//!   "pending critical resource" bookkeeping inside `bytes()`, so a dropped handler for a
//!   failed `<head>` stylesheet would block rendering forever (an empty stylesheet is what
//!   browsers effectively apply; image handlers report a decode error, which also clears
//!   their pending state). Use [`BlitzNetProvider::drop_handler_on_error`] for the plain
//!   "drop the handler" behaviour.
//! * `AbortSignal`s are polled by one lightweight watcher thread (every 50 ms while any
//!   request with a signal is in flight) and turned into [`NetClient::abort`].

use blitz_traits::net::{AbortSignal, Body, Bytes, EntryValue, FormData, NetHandler, NetProvider, Request};
use common::protocol::{CacheMode, Destination, NetRequest};
use parking_lot::{Condvar, Mutex};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::time::Duration;

use crate::client::NetClient;

const ABORT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Blitz `NetProvider` backed by the browser's network stack.
pub struct BlitzNetProvider {
    client: NetClient,
    waker: Arc<dyn Fn() + Send + Sync>,
    empty_body_on_error: bool,
    aborts: Arc<AbortWatcher>,
}

impl BlitzNetProvider {
    /// `waker` is called after every delivered response so the renderer's event loop
    /// wakes up and processes the resource.
    pub fn new(client: NetClient, waker: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            client,
            waker,
            empty_body_on_error: true,
            aborts: Arc::new(AbortWatcher::default()),
        }
    }

    /// On failure, drop the handler instead of delivering an empty body (see the module
    /// documentation for why that is not the default).
    pub fn drop_handler_on_error(mut self) -> Self {
        self.empty_body_on_error = false;
        self
    }
}

impl NetProvider for BlitzNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        if request.signal.as_ref().is_some_and(AbortSignal::aborted) {
            return;
        }
        let signal = request.signal.clone();
        let callback_signal = signal.clone();
        let destination = infer_destination(&request);
        let net_request = to_net_request(request, destination);
        let url = net_request.url.clone();
        let waker = Arc::clone(&self.waker);
        let empty_body_on_error = self.empty_body_on_error;
        let aborts = Arc::clone(&self.aborts);
        let id = self.client.fetch(
            net_request,
            Box::new(move |response| {
                if let Some(signal) = &callback_signal {
                    aborts.unregister(response.id);
                    if signal.aborted() {
                        return;
                    }
                }
                if response.is_ok() {
                    handler.bytes(response.url, Bytes::from(response.body));
                } else {
                    log::debug!(
                        "resource load failed: {url}: {}",
                        response
                            .error
                            .as_deref()
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("HTTP {}", response.status))
                    );
                    if empty_body_on_error {
                        let final_url = if response.url.is_empty() { url } else { response.url };
                        handler.bytes(final_url, Bytes::new());
                    }
                }
                waker();
            }),
        );
        if let Some(signal) = signal {
            // The response may already have completed (and unregistered the id); the
            // watcher remembers such ids and skips the registration.
            self.aborts.register(id, signal, self.client.clone());
        }
    }
}

/// Infers the request destination from `Accept` or the URL's file extension.
fn infer_destination(request: &Request) -> Destination {
    if let Some(accept) = request.headers.get(http::header::ACCEPT).and_then(|v| v.to_str().ok()) {
        let accept = accept.to_ascii_lowercase();
        if accept.starts_with("text/css") {
            return Destination::Style;
        }
        if accept.starts_with("image/") {
            return Destination::Image;
        }
        if accept.starts_with("font/") || accept.starts_with("application/font") {
            return Destination::Font;
        }
        if accept.starts_with("text/html") {
            return Destination::Document;
        }
    }
    let path = request.url.path();
    let extension = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some("css") => Destination::Style,
        Some(
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "ico" | "bmp" | "apng"
            | "tif" | "tiff" | "jxl",
        ) => Destination::Image,
        Some("woff" | "woff2" | "ttf" | "otf" | "eot" | "ttc") => Destination::Font,
        Some("js" | "mjs") => Destination::Script,
        _ => Destination::Other,
    }
}

fn to_net_request(request: Request, destination: Destination) -> NetRequest {
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(k, v)| (k.as_str().to_owned(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let referrer = headers
        .iter()
        .position(|(k, _)| k.eq_ignore_ascii_case("referer"))
        .map(|i| headers.remove(i).1);
    let has_content_type = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type"));
    let body = match request.body {
        Body::Empty => None,
        Body::Bytes(bytes) => {
            if !has_content_type && let Some(ct) = &request.content_type {
                headers.push(("content-type".into(), ct.clone()));
            }
            Some(bytes.to_vec())
        }
        Body::Form(form) => {
            let (body, content_type) = encode_form_body(&form, request.content_type.as_deref());
            if !has_content_type {
                headers.push(("content-type".into(), content_type));
            }
            Some(body)
        }
    };
    NetRequest {
        id: 0,
        url: request.url.to_string(),
        method: request.method.as_str().to_owned(),
        headers,
        body,
        destination,
        referrer,
        credentials: true,
        follow_redirects: true,
        cache_mode: CacheMode::Default,
        progress: false,
    }
}

fn random_boundary() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
    );
    let a = hasher.finish();
    let b = RandomState::new().build_hasher().finish();
    format!("----BlitzFormBoundary{a:016x}{b:016x}")
}

/// Escapes a multipart field or file name like browsers do (HTML spec, "multipart/form-data
/// encoding algorithm"): `"` → `%22`, CR → `%0D`, LF → `%0A`.
fn escape_multipart_name(s: &str) -> String {
    s.replace('"', "%22").replace('\r', "%0D").replace('\n', "%0A")
}

/// Encodes a form submission body. `enctype` is the form's content type
/// (`application/x-www-form-urlencoded` by default, `multipart/form-data` or
/// `text/plain`). Returns the body and the `Content-Type` header value (with the
/// multipart boundary).
pub fn encode_form_body(form: &FormData, enctype: Option<&str>) -> (Vec<u8>, String) {
    let enctype = enctype
        .map(|e| e.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    match enctype.as_str() {
        "multipart/form-data" => {
            let boundary = random_boundary();
            let mut body = Vec::new();
            for entry in form.iter() {
                body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
                let name = escape_multipart_name(&entry.name);
                match &entry.value {
                    EntryValue::String(value) => {
                        body.extend_from_slice(
                            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                        );
                        body.extend_from_slice(value.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
                    }
                    EntryValue::File(path) => {
                        let file_name = path
                            .file_name()
                            .map(|n| escape_multipart_name(&n.to_string_lossy()))
                            .unwrap_or_default();
                        let mime = mime_guess::from_path(path).first_raw().unwrap_or("application/octet-stream");
                        body.extend_from_slice(
                            format!(
                                "Content-Disposition: form-data; name=\"{name}\"; filename=\"{file_name}\"\r\nContent-Type: {mime}\r\n\r\n"
                            )
                            .as_bytes(),
                        );
                        match std::fs::read(path) {
                            Ok(data) => body.extend_from_slice(&data),
                            Err(e) => log::warn!("cannot read form upload {}: {e}", path.display()),
                        }
                    }
                    EntryValue::EmptyFile => {
                        body.extend_from_slice(
                            format!(
                                "Content-Disposition: form-data; name=\"{name}\"; filename=\"\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                            )
                            .as_bytes(),
                        );
                    }
                }
                body.extend_from_slice(b"\r\n");
            }
            body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
            (body, format!("multipart/form-data; boundary={boundary}"))
        }
        "text/plain" => {
            let mut body = String::new();
            for entry in form.iter() {
                body.push_str(&entry.name);
                body.push('=');
                body.push_str(entry.value.as_ref());
                body.push_str("\r\n");
            }
            (body.into_bytes(), "text/plain;charset=UTF-8".into())
        }
        _ => {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            for entry in form.iter() {
                let value = match &entry.value {
                    EntryValue::String(s) => s.clone(),
                    EntryValue::File(p) => p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    EntryValue::EmptyFile => String::new(),
                };
                serializer.append_pair(&entry.name, &value);
            }
            (serializer.finish().into_bytes(), "application/x-www-form-urlencoded".into())
        }
    }
}

/// Polls `AbortSignal`s of in-flight requests and aborts them in the [`NetClient`].
#[derive(Default)]
struct AbortWatcher {
    state: Mutex<WatchState>,
    wake: Condvar,
}

#[derive(Default)]
struct WatchState {
    watched: Vec<(u64, AbortSignal, NetClient)>,
    finished: Vec<u64>,
    thread_running: bool,
}

impl AbortWatcher {
    fn register(self: &Arc<Self>, id: u64, signal: AbortSignal, client: NetClient) {
        let mut state = self.state.lock();
        if let Some(pos) = state.finished.iter().position(|f| *f == id) {
            // Completed before it could be registered.
            state.finished.swap_remove(pos);
            return;
        }
        state.watched.push((id, signal, client));
        if !state.thread_running {
            let me = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("net-abort-watcher".into())
                .spawn(move || me.run());
            match spawned {
                Ok(_) => state.thread_running = true,
                Err(e) => log::warn!("cannot spawn abort watcher: {e}"),
            }
        }
        self.wake.notify_one();
    }

    fn unregister(&self, id: u64) {
        let mut state = self.state.lock();
        if let Some(pos) = state.watched.iter().position(|(w, _, _)| *w == id) {
            state.watched.swap_remove(pos);
        } else {
            state.finished.push(id);
        }
    }

    fn run(&self) {
        let mut state = self.state.lock();
        loop {
            if state.watched.is_empty() {
                // Idle: park until a request with a signal is registered (or give up the
                // thread after a while; it is restarted on demand).
                if self.wake.wait_for(&mut state, Duration::from_secs(30)).timed_out()
                    && state.watched.is_empty()
                {
                    state.thread_running = false;
                    return;
                }
                continue;
            }
            let mut aborted = Vec::new();
            state.watched.retain(|(id, signal, client)| {
                if signal.aborted() {
                    aborted.push((*id, client.clone()));
                    false
                } else {
                    true
                }
            });
            parking_lot::MutexGuard::unlocked(&mut state, || {
                for (id, client) in aborted {
                    client.abort(id);
                }
                std::thread::sleep(ABORT_POLL_INTERVAL);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use blitz_traits::net::Entry;
    use url::Url;

    fn req(url: &str) -> Request {
        Request::get(Url::parse(url).unwrap())
    }

    #[test]
    fn destination_inference() {
        assert_eq!(infer_destination(&req("https://a.com/s/site.CSS?v=1")), Destination::Style);
        assert_eq!(infer_destination(&req("https://a.com/i/logo.webp")), Destination::Image);
        assert_eq!(infer_destination(&req("https://a.com/f/x.woff2")), Destination::Font);
        assert_eq!(infer_destination(&req("https://a.com/app.mjs")), Destination::Script);
        assert_eq!(infer_destination(&req("https://a.com/css2?family=Roboto")), Destination::Other);
        let mut r = req("https://fonts.googleapis.com/css2?family=Roboto");
        r.headers.insert(http::header::ACCEPT, http::HeaderValue::from_static("text/css,*/*;q=0.1"));
        assert_eq!(infer_destination(&r), Destination::Style);
    }

    fn form() -> FormData {
        FormData(vec![
            Entry { name: "q".into(), value: EntryValue::String("a b&c".into()) },
            Entry { name: "x\"y".into(), value: EntryValue::String("line1\nline2".into()) },
        ])
    }

    #[test]
    fn form_encodings() {
        let (body, ct) = encode_form_body(&form(), None);
        assert_eq!(ct, "application/x-www-form-urlencoded");
        assert_eq!(String::from_utf8(body).unwrap(), "q=a+b%26c&x%22y=line1%0Aline2");

        let (body, ct) = encode_form_body(&form(), Some("text/plain"));
        assert_eq!(ct, "text/plain;charset=UTF-8");
        assert_eq!(String::from_utf8(body).unwrap(), "q=a b&c\r\nx\"y=line1\nline2\r\n");

        let (body, ct) = encode_form_body(&form(), Some("multipart/form-data"));
        let boundary = ct.strip_prefix("multipart/form-data; boundary=").unwrap();
        let text = String::from_utf8(body).unwrap();
        assert!(text.starts_with(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"q\"\r\n\r\na b&c\r\n")));
        assert!(text.contains("name=\"x%22y\"\r\n\r\nline1\r\nline2\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
    }

    #[test]
    fn request_mapping() {
        let mut r = req("https://a.com/submit");
        r.method = http::Method::POST;
        r.body = Body::Form(form());
        r.content_type = Some("application/x-www-form-urlencoded".into());
        r.headers.insert(http::header::REFERER, http::HeaderValue::from_static("https://a.com/page"));
        let n = to_net_request(r, Destination::Document);
        assert_eq!(n.method, "POST");
        assert_eq!(n.referrer.as_deref(), Some("https://a.com/page"));
        assert!(n.headers.iter().any(|(k, v)| k == "content-type" && v == "application/x-www-form-urlencoded"));
        assert!(!n.headers.iter().any(|(k, _)| k == "referer"));
        assert!(n.body.is_some());
    }
}
