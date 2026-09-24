//! Request headers: sanitizing client-supplied headers and adding Chrome-like defaults
//! (`Accept` per destination, `Accept-Language`, `Accept-Encoding`, `User-Agent`,
//! `Referer` with the default `strict-origin-when-cross-origin` policy, `Origin` for
//! unsafe methods, `Sec-Fetch-*`, `Upgrade-Insecure-Requests`).

use common::protocol::Destination;
use http::header::{
    ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, ORIGIN, RANGE, REFERER, USER_AGENT,
};
use http::{HeaderMap, HeaderName, HeaderValue, Method};
use url::Url;

use crate::config::NetConfig;
use crate::cookies::registrable_domain;

/// Encodings the stack can decode (the decoders are enabled in reqwest).
pub(crate) const SUPPORTED_ENCODINGS: &str = "gzip, deflate, br, zstd";

/// Headers the network stack owns: framing/connection management, credentials and
/// content coding. Values supplied by clients are dropped.
fn is_controlled(name: &HeaderName) -> bool {
    let n = name.as_str();
    matches!(
        n,
        "host"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "keep-alive"
            | "upgrade"
            | "te"
            | "trailer"
            | "expect"
            | "cookie"
            | "cookie2"
            | "accept-encoding"
    ) || n.starts_with("proxy-")
}

/// Converts client-supplied headers into a header map. Invalid names/values and headers
/// controlled by the network stack are dropped. Returns the map and a client-supplied
/// `Referer` (used when the request has no explicit referrer).
pub(crate) fn sanitize(headers: &[(String, String)]) -> (HeaderMap, Option<String>) {
    let mut map = HeaderMap::with_capacity(headers.len() + 12);
    let mut referer = None;
    for (name, value) in headers {
        let Ok(name) = HeaderName::from_bytes(name.trim().as_bytes()) else {
            log::debug!("dropping request header with invalid name {name:?}");
            continue;
        };
        if is_controlled(&name) {
            continue;
        }
        if name == REFERER {
            referer = Some(value.trim().to_owned());
            continue;
        }
        match HeaderValue::from_str(value.trim()) {
            Ok(value) => {
                map.append(name, value);
            }
            Err(_) => log::debug!("dropping request header {name} with invalid value"),
        }
    }
    (map, referer)
}

/// Whether a URL is "potentially trustworthy" (https, or loopback over http).
pub(crate) fn is_potentially_trustworthy(url: &Url) -> bool {
    match url.scheme() {
        "https" | "wss" | "file" => true,
        "http" | "ws" => match url.host() {
            Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        },
        _ => false,
    }
}

/// `Referer` value under the default `strict-origin-when-cross-origin` policy:
/// full URL (without fragment and credentials) for same-origin requests, the origin for
/// cross-origin requests, nothing when downgrading from https to http.
pub(crate) fn referrer_value(referrer: &Url, target: &Url) -> Option<String> {
    if !matches!(referrer.scheme(), "http" | "https") {
        return None;
    }
    if referrer.scheme() == "https" && !is_potentially_trustworthy(target) {
        return None;
    }
    if referrer.origin() == target.origin() {
        let mut r = referrer.clone();
        r.set_fragment(None);
        let _ = r.set_username("");
        let _ = r.set_password(None);
        Some(r.into())
    } else {
        Some(format!("{}/", referrer.origin().ascii_serialization()))
    }
}

fn same_site(a: &Url, b: &Url) -> bool {
    if a.scheme() != b.scheme() {
        return false;
    }
    match (a.host(), b.host()) {
        (Some(url::Host::Domain(x)), Some(url::Host::Domain(y))) => {
            match (registrable_domain(x), registrable_domain(y)) {
                (Some(rx), Some(ry)) => rx == ry,
                _ => x.eq_ignore_ascii_case(y),
            }
        }
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn accept_for(destination: Destination, config: &NetConfig) -> HeaderValue {
    let value = match destination {
        Destination::Document => config.document_accept.as_str(),
        Destination::Image => config.image_accept.as_str(),
        Destination::Style => "text/css,*/*;q=0.1",
        Destination::Script
        | Destination::Font
        | Destination::Fetch
        | Destination::Media
        | Destination::Other => "*/*",
    };
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static("*/*"))
}

fn set_if_absent(map: &mut HeaderMap, name: HeaderName, value: HeaderValue) {
    if !map.contains_key(&name) {
        map.insert(name, value);
    }
}

fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE)
}

/// Adds the default request headers for one request (hop).
pub(crate) fn apply_defaults(
    map: &mut HeaderMap,
    url: &Url,
    method: &Method,
    destination: Destination,
    referrer: Option<&Url>,
    config: &NetConfig,
) {
    if let Ok(ua) = HeaderValue::from_str(&config.user_agent) {
        set_if_absent(map, USER_AGENT, ua);
    }
    set_if_absent(map, ACCEPT, accept_for(destination, config));
    if let Ok(lang) = HeaderValue::from_str(&config.accept_language) {
        set_if_absent(map, ACCEPT_LANGUAGE, lang);
    }
    // Byte ranges of a content-coded representation can't be decoded piecewise.
    let encoding = if map.contains_key(RANGE) {
        HeaderValue::from_static("identity")
    } else {
        HeaderValue::from_static(SUPPORTED_ENCODINGS)
    };
    map.insert(ACCEPT_ENCODING, encoding);

    map.remove(REFERER);
    if let Some(value) = referrer
        .and_then(|r| referrer_value(r, url))
        .and_then(|v| HeaderValue::from_str(&v).ok())
    {
        map.insert(REFERER, value);
    }
    if !is_safe_method(method)
        && !map.contains_key(ORIGIN)
        && let Some(r) = referrer
        && let Ok(origin) = HeaderValue::from_str(&r.origin().ascii_serialization())
    {
        map.insert(ORIGIN, origin);
    }
    if destination == Destination::Document {
        set_if_absent(
            map,
            HeaderName::from_static("upgrade-insecure-requests"),
            HeaderValue::from_static("1"),
        );
    }
    if is_potentially_trustworthy(url) {
        apply_sec_fetch(map, url, destination, referrer);
    }
}

/// Fetch metadata request headers. Values supplied by the client (which knows the real
/// request initiator) are kept; otherwise they are derived from the referrer.
fn apply_sec_fetch(map: &mut HeaderMap, url: &Url, destination: Destination, referrer: Option<&Url>) {
    let dest = match destination {
        Destination::Document => "document",
        Destination::Script => "script",
        Destination::Style => "style",
        Destination::Image => "image",
        Destination::Font => "font",
        Destination::Media => "video",
        Destination::Fetch | Destination::Other => "empty",
    };
    let mode = match destination {
        Destination::Document => "navigate",
        Destination::Fetch | Destination::Font => "cors",
        _ => "no-cors",
    };
    set_if_absent(map, HeaderName::from_static("sec-fetch-dest"), HeaderValue::from_static(dest));
    set_if_absent(map, HeaderName::from_static("sec-fetch-mode"), HeaderValue::from_static(mode));
    let site = match referrer {
        None if destination == Destination::Document => Some("none"),
        None => None,
        Some(r) if r.origin() == url.origin() => Some("same-origin"),
        Some(r) if same_site(r, url) => Some("same-site"),
        Some(_) => Some("cross-site"),
    };
    if let Some(site) = site {
        set_if_absent(map, HeaderName::from_static("sec-fetch-site"), HeaderValue::from_static(site));
    }
    if destination == Destination::Document && referrer.is_none() {
        set_if_absent(map, HeaderName::from_static("sec-fetch-user"), HeaderValue::from_static("?1"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn sanitize_drops_controlled_headers() {
        let (map, referer) = sanitize(&[
            ("Host".into(), "evil".into()),
            ("Cookie".into(), "a=b".into()),
            ("Proxy-Authorization".into(), "x".into()),
            ("Accept-Encoding".into(), "identity".into()),
            ("X-Custom".into(), " v ".into()),
            ("Referer".into(), "https://r.com/p".into()),
            ("bad name".into(), "v".into()),
            ("X-Bad".into(), "a\nb".into()),
        ]);
        assert_eq!(map.len(), 1);
        assert_eq!(map["x-custom"], "v");
        assert_eq!(referer.as_deref(), Some("https://r.com/p"));
    }

    #[test]
    fn referrer_policy() {
        let r = url("https://user:pw@a.com/page?q=1#frag");
        assert_eq!(referrer_value(&r, &url("https://a.com/x")).as_deref(), Some("https://a.com/page?q=1"));
        assert_eq!(referrer_value(&r, &url("https://b.com/x")).as_deref(), Some("https://a.com/"));
        assert_eq!(referrer_value(&r, &url("http://a.com/x")), None);
        assert_eq!(referrer_value(&r, &url("http://localhost/x")).as_deref(), Some("https://a.com/"));
        assert_eq!(referrer_value(&url("file:///x.html"), &url("https://a.com/")), None);
    }

    #[test]
    fn defaults_per_destination() {
        let config = NetConfig::ephemeral();
        let target = url("https://img.example.com/a.png");
        let referrer = url("https://www.example.com/index.html");
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &target, &Method::GET, Destination::Image, Some(&referrer), &config);
        assert_eq!(map[ACCEPT], config.image_accept.as_str());
        assert_eq!(map[ACCEPT_ENCODING], SUPPORTED_ENCODINGS);
        assert_eq!(map[USER_AGENT], common::USER_AGENT);
        assert_eq!(map[ACCEPT_LANGUAGE], "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7");
        assert_eq!(map[REFERER], "https://www.example.com/");
        assert_eq!(map["sec-fetch-dest"], "image");
        assert_eq!(map["sec-fetch-mode"], "no-cors");
        assert_eq!(map["sec-fetch-site"], "same-site");
        assert!(!map.contains_key(ORIGIN));

        let mut map = HeaderMap::new();
        map.insert(USER_AGENT, HeaderValue::from_static("custom"));
        let doc = url("https://www.example.com/");
        apply_defaults(&mut map, &doc, &Method::POST, Destination::Document, None, &config);
        assert_eq!(map[USER_AGENT], "custom");
        assert!(map[ACCEPT].to_str().unwrap().starts_with("text/html"));
        assert_eq!(map["sec-fetch-site"], "none");
        assert_eq!(map["sec-fetch-user"], "?1");
        assert_eq!(map["upgrade-insecure-requests"], "1");

        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://api.other.org/v1"), &Method::POST, Destination::Fetch, Some(&referrer), &config);
        assert_eq!(map[ORIGIN], "https://www.example.com");
        assert_eq!(map["sec-fetch-site"], "cross-site");
        assert_eq!(map["sec-fetch-mode"], "cors");

        // No Sec-Fetch-* for insecure origins; ranges are not content-coded.
        let mut map = HeaderMap::new();
        map.insert(RANGE, HeaderValue::from_static("bytes=0-"));
        apply_defaults(&mut map, &url("http://example.com/v.mp4"), &Method::GET, Destination::Media, None, &config);
        assert!(!map.contains_key("sec-fetch-dest"));
        assert_eq!(map[ACCEPT_ENCODING], "identity");
    }
}
