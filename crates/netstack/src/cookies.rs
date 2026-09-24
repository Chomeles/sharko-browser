//! Cookie jar shared by all requests of a network stack instance.
//!
//! Storage and RFC 6265 domain/path/expiry matching come from the `cookie_store` crate,
//! with the public suffix list (vendored in `data/`) so that `Domain=co.uk` and similar
//! super-cookies are rejected. On top of it this module implements browser rules that
//! `cookie_store` leaves out:
//!
//! * the "non-HTTP API" (`document.cookie`) can neither create nor overwrite `HttpOnly`
//!   cookies and never sees them;
//! * `Secure` cookies can only be set from secure origins (https or localhost), and an
//!   insecure origin cannot shadow an existing secure cookie ("leave secure cookies
//!   alone", RFC 6265bis 5.7);
//! * `__Secure-` / `__Host-` name prefixes;
//! * 4096-byte name+value limit, control characters are rejected;
//! * the `Cookie` header orders longer paths first (RFC 6265 5.4).
//!
//! `SameSite` is not enforced: requests don't carry the top-level site that would be
//! needed to evaluate it.
//!
//! Persistence: persistent (non-session, unexpired) cookies are saved as JSON to
//! `<profile>/cookies.json` via an atomic write.

use cookie_store::{CookieStore, RawCookie};
use http::HeaderMap;
use parking_lot::RwLock;
use std::io::{self, BufReader};
use std::path::PathBuf;
use std::sync::OnceLock;
use url::Url;

use crate::util::write_atomic;

static PUBLIC_SUFFIX_LIST: &str = include_str!("../data/public_suffix_list.dat");

/// The parsed public suffix list (parsed once per process, ~10k rules).
pub(crate) fn public_suffix_list() -> Option<&'static publicsuffix::List> {
    static LIST: OnceLock<Option<publicsuffix::List>> = OnceLock::new();
    LIST.get_or_init(|| match PUBLIC_SUFFIX_LIST.parse::<publicsuffix::List>() {
        Ok(list) => Some(list),
        Err(e) => {
            log::warn!("public suffix list unavailable ({e}); cookie domains are not PSL-checked");
            None
        }
    })
    .as_ref()
}

/// Registrable domain ("eTLD+1") of a host name, e.g. `www.example.co.uk` →
/// `example.co.uk`. `None` for IP addresses, public suffixes themselves and unknown TLDs.
pub(crate) fn registrable_domain(host: &str) -> Option<String> {
    use publicsuffix::Psl;
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let domain = public_suffix_list()?.domain(host.as_bytes())?;
    std::str::from_utf8(domain.as_bytes()).ok().map(str::to_owned)
}

/// Maximum size of name + value (RFC 6265bis).
const MAX_NAME_VALUE_BYTES: usize = 4096;

/// RFC 6265 distinguishes cookies set by HTTP responses from those set by scripts.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Source {
    Http,
    Script,
}

pub(crate) struct CookieJar {
    store: RwLock<CookieStore>,
    path: Option<PathBuf>,
}

impl CookieJar {
    /// Opens the jar, loading persisted cookies from `path` if it exists.
    pub fn open(path: Option<PathBuf>) -> Self {
        let store = path.as_ref().and_then(load).unwrap_or_default();
        let store = match public_suffix_list() {
            Some(list) => store.with_suffix_list(list.clone()),
            None => store,
        };
        Self {
            store: RwLock::new(store),
            path,
        }
    }

    /// Value for the `Cookie` request header, or `None` if no cookie matches.
    pub fn request_header(&self, url: &Url) -> Option<String> {
        let store = self.store.read();
        let mut cookies = store.matches(url);
        if cookies.is_empty() {
            return None;
        }
        cookies.sort_by_key(|c| std::cmp::Reverse(c.path.as_ref().len()));
        Some(join_pairs(cookies.iter().map(|c| (c.name(), c.value()))))
    }

    /// Stores the `Set-Cookie` headers of a response received from `url`.
    /// Returns `true` if the jar changed (so it needs to be persisted).
    pub fn store_response(&self, url: &Url, headers: &HeaderMap) -> bool {
        let mut values = headers
            .get_all(http::header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .peekable();
        if values.peek().is_none() {
            return false;
        }
        let mut store = self.store.write();
        let mut changed = false;
        for value in values {
            match RawCookie::parse(value.to_owned()) {
                Ok(raw) => changed |= insert(&mut store, raw, url, Source::Http),
                Err(e) => log::debug!("ignoring malformed Set-Cookie from {url}: {e}"),
            }
        }
        changed
    }

    /// The `document.cookie` string for a page at `url` (never contains HttpOnly cookies).
    pub fn document_cookie(&self, url: &Url) -> String {
        if !is_http(url) {
            return String::new();
        }
        let store = self.store.read();
        let mut cookies: Vec<_> = store
            .matches(url)
            .into_iter()
            .filter(|c| c.http_only() != Some(true))
            .collect();
        cookies.sort_by_key(|c| std::cmp::Reverse(c.path.as_ref().len()));
        join_pairs(cookies.iter().map(|c| (c.name(), c.value())))
    }

    /// `document.cookie = cookie` on a page at `url`. HttpOnly cookies are rejected.
    /// Returns `true` if the jar changed.
    pub fn set_from_script(&self, url: &Url, cookie: &str) -> bool {
        if !is_http(url) {
            return false;
        }
        let raw = match RawCookie::parse(cookie.to_owned()) {
            Ok(raw) => raw,
            Err(e) => {
                log::debug!("ignoring malformed document.cookie assignment: {e}");
                return false;
            }
        };
        if raw.http_only() == Some(true) {
            log::debug!("document.cookie cannot set HttpOnly cookie `{}`", raw.name());
            return false;
        }
        let mut store = self.store.write();
        insert(&mut store, raw, url, Source::Script)
    }

    /// Writes persistent cookies to disk (atomically). No-op for ephemeral jars.
    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let mut buf = Vec::with_capacity(4096);
        {
            let store = self.store.read();
            cookie_store::serde::json::save(&store, &mut buf)
                .map_err(|e| io::Error::other(e.to_string()))?;
        }
        write_atomic(path, &buf, true)
    }
}

fn load(path: &PathBuf) -> Option<CookieStore> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("cannot open {}: {e}", path.display());
            return None;
        }
    };
    match cookie_store::serde::json::load(BufReader::new(file)) {
        Ok(store) => Some(store),
        Err(e) => {
            log::warn!("ignoring corrupt cookie file {}: {e}", path.display());
            None
        }
    }
}

fn is_http(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// https, or http to a loopback host (Chrome treats those as potentially trustworthy).
fn is_secure(url: &Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => match url.host() {
            Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

fn has_forbidden_chars(s: &str) -> bool {
    s.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f)
}

fn has_prefix(name: &str, prefix: &str) -> bool {
    name.len() >= prefix.len() && name[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// Applies the browser rules and inserts the cookie. Returns `true` if the jar changed.
fn insert(store: &mut CookieStore, raw: RawCookie<'static>, url: &Url, source: Source) -> bool {
    let name = raw.name();
    let value = raw.value();
    if name.is_empty() && value.is_empty() {
        return false;
    }
    if name.len() + value.len() > MAX_NAME_VALUE_BYTES
        || has_forbidden_chars(name)
        || has_forbidden_chars(value)
    {
        log::debug!("rejecting oversized or malformed cookie from {url}");
        return false;
    }
    let secure_origin = is_secure(url);
    let secure_attr = raw.secure() == Some(true);
    if secure_attr && !secure_origin {
        log::debug!("rejecting Secure cookie `{name}` from insecure origin {url}");
        return false;
    }
    if has_prefix(name, "__Secure-") && !(secure_attr && secure_origin) {
        return false;
    }
    if has_prefix(name, "__Host-")
        && !(secure_attr && secure_origin && raw.domain().is_none() && raw.path() == Some("/"))
    {
        return false;
    }
    let cookie = match cookie_store::Cookie::try_from_raw_cookie(&raw, url) {
        Ok(c) => c,
        Err(e) => {
            log::debug!("rejecting cookie `{name}` from {url}: {e}");
            return false;
        }
    };
    let domain = String::from(&cookie.domain);
    let path = String::from(&cookie.path);
    if source == Source::Script
        && store
            .get_any(&domain, &path, cookie.name())
            .is_some_and(|old| old.http_only() == Some(true))
    {
        log::debug!("document.cookie cannot overwrite HttpOnly cookie `{name}`");
        return false;
    }
    if !secure_origin && !secure_attr {
        // Leave secure cookies alone: an insecure origin must not shadow a secure cookie.
        let shadows_secure = store.iter_unexpired().any(|c| {
            c.name() == cookie.name()
                && c.secure() == Some(true)
                && c.domain.matches(url)
                && path.starts_with(c.path.as_ref())
        });
        if shadows_secure {
            log::debug!("insecure origin {url} cannot overwrite secure cookie `{name}`");
            return false;
        }
    }
    match store.insert(cookie.into_owned(), url) {
        Ok(_) => true,
        Err(e) => {
            log::debug!("cookie `{name}` from {url} not stored: {e}");
            false
        }
    }
}

fn join_pairs<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) -> String {
    let mut out = String::new();
    for (name, value) in pairs {
        if !out.is_empty() {
            out.push_str("; ");
        }
        if !name.is_empty() {
            out.push_str(name);
            out.push('=');
        }
        out.push_str(value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn set_cookie_headers(values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(http::header::SET_COOKIE, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn http_only_hidden_from_script_but_sent() {
        let jar = CookieJar::open(None);
        let u = url("https://example.com/a/b");
        assert!(jar.store_response(&u, &set_cookie_headers(&["sid=1; HttpOnly; Path=/", "ui=dark; Path=/"])));
        assert_eq!(jar.document_cookie(&u), "ui=dark");
        let header = jar.request_header(&u).unwrap();
        assert!(header.contains("sid=1") && header.contains("ui=dark"), "{header}");
    }

    #[test]
    fn script_cannot_set_or_overwrite_http_only() {
        let jar = CookieJar::open(None);
        let u = url("https://example.com/");
        assert!(!jar.set_from_script(&u, "a=1; HttpOnly"));
        jar.store_response(&u, &set_cookie_headers(&["sid=server; HttpOnly; Path=/"]));
        assert!(!jar.set_from_script(&u, "sid=evil; Path=/"));
        assert_eq!(jar.request_header(&u).as_deref(), Some("sid=server"));
        assert!(jar.set_from_script(&u, "theme=light"));
        assert_eq!(jar.document_cookie(&u), "theme=light");
    }

    #[test]
    fn public_suffix_domain_rejected() {
        let jar = CookieJar::open(None);
        let u = url("https://www.example.co.uk/");
        jar.store_response(&u, &set_cookie_headers(&["evil=1; Domain=co.uk", "good=1; Domain=example.co.uk"]));
        assert_eq!(jar.request_header(&url("https://other.co.uk/")), None);
        assert_eq!(jar.request_header(&url("https://shop.example.co.uk/")).as_deref(), Some("good=1"));
    }

    #[test]
    fn secure_rules_and_prefixes() {
        let jar = CookieJar::open(None);
        let insecure = url("http://example.com/");
        let secure = url("https://example.com/");
        // Secure cookies only from secure origins.
        assert!(!jar.store_response(&insecure, &set_cookie_headers(&["s=1; Secure"])));
        assert!(jar.store_response(&secure, &set_cookie_headers(&["s=1; Secure; Path=/"])));
        // Not sent over http, sent over https.
        assert_eq!(jar.request_header(&insecure), None);
        assert_eq!(jar.request_header(&secure).as_deref(), Some("s=1"));
        // Insecure origin cannot shadow it.
        assert!(!jar.store_response(&insecure, &set_cookie_headers(&["s=2; Path=/"])));
        // Prefixes.
        assert!(!jar.set_from_script(&secure, "__Secure-a=1"));
        assert!(jar.set_from_script(&secure, "__Secure-a=1; Secure"));
        assert!(!jar.set_from_script(&secure, "__Host-b=1; Secure; Path=/; Domain=example.com"));
        assert!(jar.set_from_script(&secure, "__Host-b=1; Secure; Path=/"));
        // localhost over http counts as secure.
        assert!(jar.set_from_script(&url("http://localhost:8080/"), "l=1; Secure"));
    }

    #[test]
    fn ordering_longer_paths_first_and_expiry() {
        let jar = CookieJar::open(None);
        let u = url("https://example.com/docs/page");
        jar.store_response(&u, &set_cookie_headers(&["a=root; Path=/", "b=docs; Path=/docs"]));
        assert_eq!(jar.request_header(&u).as_deref(), Some("b=docs; a=root"));
        // Deleting via an expired cookie.
        assert!(jar.store_response(&u, &set_cookie_headers(&["b=; Path=/docs; Max-Age=0"])));
        assert_eq!(jar.request_header(&u).as_deref(), Some("a=root"));
    }

    #[test]
    fn registrable_domains() {
        assert_eq!(registrable_domain("www.example.co.uk").as_deref(), Some("example.co.uk"));
        assert_eq!(registrable_domain("Example.COM.").as_deref(), Some("example.com"));
        assert_eq!(registrable_domain("co.uk"), None);
        // Private-section suffixes count too (github.io pages are separate sites).
        assert_eq!(registrable_domain("a.b.github.io").as_deref(), Some("b.github.io"));
    }

    #[test]
    fn limits_and_non_http_urls() {
        let jar = CookieJar::open(None);
        let u = url("https://example.com/");
        let big = format!("big={}", "x".repeat(5000));
        assert!(!jar.set_from_script(&u, &big));
        assert!(!jar.set_from_script(&url("file:///tmp/x.html"), "a=1"));
        assert_eq!(jar.document_cookie(&url("about:blank")), "");
    }

    #[test]
    fn persistence_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cookies.json");
        {
            let jar = CookieJar::open(Some(path.clone()));
            let u = url("https://example.com/");
            jar.store_response(
                &u,
                &set_cookie_headers(&["keep=1; Max-Age=3600; Path=/", "session=1; Path=/"]),
            );
            jar.save().unwrap();
        }
        let jar = CookieJar::open(Some(path));
        // Session cookies are not persisted.
        assert_eq!(jar.request_header(&url("https://example.com/")).as_deref(), Some("keep=1"));
    }
}
