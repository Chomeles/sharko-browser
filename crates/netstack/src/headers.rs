//! Request headers: sanitizing client-supplied headers and adding Chrome-like defaults
//! (`Accept` per destination, `Accept-Language`, `Accept-Encoding`, `User-Agent`,
//! `Referer` with the default `strict-origin-when-cross-origin` policy, `Origin` for
//! unsafe methods, `Sec-Fetch-*`, `Upgrade-Insecure-Requests`).

use common::protocol::Destination;
use http::header::{COOKIE, RANGE, REFERER};
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
        Destination::Document | Destination::Iframe => config.document_accept.as_str(),
        // AVIF is deliberately not advertised for images (see `NetConfig::image_accept`).
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

fn is_safe_method(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE)
}

/// Chromium's `Priority` header (RFC 9218) per resource type: Blink's load priority
/// (`ResourceFetcher::ComputeLoadPriority`: style VeryHigh, script/font/fetch High,
/// image/media Low, once visible Medium) mapped to a urgency by `net::RequestPriority`
/// (HIGHEST 0, MEDIUM 1, LOW 2), with `i` for everything that is not render-blocking.
fn priority_for(destination: Destination) -> &'static str {
    match destination {
        Destination::Document | Destination::Iframe => "u=0, i",
        Destination::Style => "u=0",
        Destination::Script => "u=1",
        Destination::Font | Destination::Fetch | Destination::Other => "u=1, i",
        Destination::Image | Destination::Media => "u=2, i",
    }
}

fn sec_fetch_dest(destination: Destination) -> &'static str {
    match destination {
        Destination::Document => "document",
        Destination::Iframe => "iframe",
        Destination::Script => "script",
        Destination::Style => "style",
        Destination::Image => "image",
        Destination::Font => "font",
        Destination::Media => "video",
        Destination::Fetch | Destination::Other => "empty",
    }
}

/// Removes and returns the client-supplied value of `name` (keeping the order of the rest).
fn take(client: &mut Vec<(HeaderName, HeaderValue)>, name: &str) -> Option<HeaderValue> {
    let i = client.iter().position(|(n, _)| n.as_str() == name)?;
    Some(client.remove(i).1)
}

/// Sets the default request headers of one request (hop) in Chrome's wire order, so that
/// the order (a fingerprint the same as the values) matches Chromium 140 on Windows:
///
/// `sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, [upgrade-insecure-requests,]
/// user-agent, <client headers>, accept, [origin,] sec-fetch-site, sec-fetch-mode,
/// [sec-fetch-user,] sec-fetch-dest, [referer,] accept-encoding, accept-language,
/// [cookie,] [priority]`
///
/// Client-supplied `User-Agent`, `Accept`, `Accept-Language`, `Origin` and `Sec-Fetch-*`
/// values win (the caller knows the real initiator; `Sec-Fetch-Mode` also carries the
/// request mode of script loads and `no-cors` fetches); they move to the slot of the
/// default. `Cookie` is added by [`insert_cookie`], which keeps it before `priority`.
pub(crate) fn apply_defaults(
    map: &mut HeaderMap,
    url: &Url,
    method: &Method,
    destination: Destination,
    referrer: Option<&Url>,
    config: &NetConfig,
) {
    let mut client: Vec<(HeaderName, HeaderValue)> =
        map.iter().map(|(n, v)| (n.clone(), v.clone())).collect();
    let has_range = map.contains_key(RANGE);
    let secure = is_potentially_trustworthy(url);
    let mut out = HeaderMap::with_capacity(client.len() + 16);
    fn put(out: &mut HeaderMap, name: &'static str, value: HeaderValue) {
        out.append(HeaderName::from_static(name), value);
    }

    // User-agent client hints are only sent to potentially trustworthy origins.
    if secure {
        for (name, value) in [
            ("sec-ch-ua", config.sec_ch_ua.as_str()),
            ("sec-ch-ua-mobile", "?0"),
            ("sec-ch-ua-platform", config.sec_ch_ua_platform.as_str()),
        ] {
            let _ = take(&mut client, name);
            if let Ok(v) = HeaderValue::from_str(value) {
                put(&mut out, name, v);
            }
        }
    }
    let navigation = matches!(destination, Destination::Document | Destination::Iframe);
    if navigation {
        put(&mut out, "upgrade-insecure-requests", HeaderValue::from_static("1"));
    }
    let ua = take(&mut client, "user-agent").or_else(|| HeaderValue::from_str(&config.user_agent).ok());
    let accept = take(&mut client, "accept").unwrap_or_else(|| accept_for(destination, config));
    let language = take(&mut client, "accept-language")
        .or_else(|| HeaderValue::from_str(&config.accept_language).ok());
    let client_origin = take(&mut client, "origin");
    let _ = take(&mut client, "referer");
    let _ = take(&mut client, "upgrade-insecure-requests");
    let client_dest = take(&mut client, "sec-fetch-dest");
    let client_mode = take(&mut client, "sec-fetch-mode");
    let client_site = take(&mut client, "sec-fetch-site");
    let client_user = take(&mut client, "sec-fetch-user");
    let _ = take(&mut client, "priority");

    if let Some(ua) = ua {
        put(&mut out, "user-agent", ua);
    }
    for (name, value) in client {
        out.append(name, value);
    }
    put(&mut out, "accept", accept);

    let mode = client_mode
        .as_ref()
        .and_then(|m| m.to_str().ok())
        .unwrap_or(match destination {
            Destination::Document | Destination::Iframe => "navigate",
            Destination::Fetch | Destination::Font => "cors",
            _ => "no-cors",
        })
        .to_owned();
    // Fetch "append a request Origin header": for cors-mode requests to another origin
    // (fetch/XHR, fonts, `crossorigin` scripts), whatever the method; otherwise only for
    // unsafe methods.
    let cross_origin_cors = mode == "cors" && referrer.is_some_and(|r| r.origin() != url.origin());
    let origin = client_origin.or_else(|| {
        if !(cross_origin_cors || !is_safe_method(method)) {
            return None;
        }
        HeaderValue::from_str(&referrer?.origin().ascii_serialization()).ok()
    });
    if let Some(origin) = origin {
        put(&mut out, "origin", origin);
    }

    if secure {
        // Sec-Fetch-Site is always sent; a request without initiator (the address bar, the
        // browser itself) is "none".
        let site = match referrer {
            None => "none",
            Some(r) if r.origin() == url.origin() => "same-origin",
            Some(r) if same_site(r, url) => "same-site",
            Some(_) => "cross-site",
        };
        put(&mut out, "sec-fetch-site", client_site.unwrap_or_else(|| HeaderValue::from_static(site)));
        put(
            &mut out,
            "sec-fetch-mode",
            HeaderValue::from_str(&mode).unwrap_or_else(|_| HeaderValue::from_static("no-cors")),
        );
        if destination == Destination::Document && referrer.is_none() {
            put(&mut out, "sec-fetch-user", client_user.unwrap_or_else(|| HeaderValue::from_static("?1")));
        }
        put(
            &mut out,
            "sec-fetch-dest",
            client_dest.unwrap_or_else(|| HeaderValue::from_static(sec_fetch_dest(destination))),
        );
    }
    if let Some(value) = referrer
        .and_then(|r| referrer_value(r, url))
        .and_then(|v| HeaderValue::from_str(&v).ok())
    {
        put(&mut out, "referer", value);
    }
    // Byte ranges of a content-coded representation can't be decoded piecewise; media
    // elements always ask for the identity coding.
    let encoding = if destination == Destination::Media {
        HeaderValue::from_static("identity;q=1, *;q=0")
    } else if has_range {
        HeaderValue::from_static("identity")
    } else {
        HeaderValue::from_static(SUPPORTED_ENCODINGS)
    };
    put(&mut out, "accept-encoding", encoding);
    if let Some(language) = language {
        put(&mut out, "accept-language", language);
    }
    // Chrome sends `Priority` on h2/h3 only, i.e. (in practice) over TLS.
    if url.scheme() == "https" {
        put(&mut out, "priority", HeaderValue::from_static(priority_for(destination)));
    }
    *map = out;
}

/// Adds the `Cookie` header in Chrome's slot (after `accept-language`, before `priority`).
pub(crate) fn insert_cookie(map: &mut HeaderMap, cookie: HeaderValue) {
    // `priority` is the last entry, so removing and re-adding it keeps the others in place.
    let priority = map.remove("priority");
    map.insert(COOKIE, cookie);
    if let Some(priority) = priority {
        map.insert("priority", priority);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::{ACCEPT, ACCEPT_ENCODING, ACCEPT_LANGUAGE, ORIGIN, USER_AGENT};

    fn names(map: &HeaderMap) -> Vec<&str> {
        map.keys().map(|k| k.as_str()).collect()
    }

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
        assert!(map[ACCEPT].to_str().unwrap().contains("image/avif"));
        assert!(map[ACCEPT].to_str().unwrap().ends_with("application/signed-exchange;v=b3;q=0.7"));

        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://api.other.org/v1"), &Method::POST, Destination::Fetch, Some(&referrer), &config);
        assert_eq!(map[ORIGIN], "https://www.example.com");
        assert_eq!(map["sec-fetch-site"], "cross-site");
        assert_eq!(map["sec-fetch-mode"], "cors");

        // A cross-origin cors GET carries Origin too; a same-origin one does not.
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://accounts.other.org/status"), &Method::GET, Destination::Fetch, Some(&referrer), &config);
        assert_eq!(map[ORIGIN], "https://www.example.com");
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://www.example.com/api"), &Method::GET, Destination::Fetch, Some(&referrer), &config);
        assert!(!map.contains_key(ORIGIN));

        // No Sec-Fetch-* for insecure origins; ranges are not content-coded.
        let mut map = HeaderMap::new();
        map.insert(RANGE, HeaderValue::from_static("bytes=0-"));
        apply_defaults(&mut map, &url("http://example.com/v.mp4"), &Method::GET, Destination::Fetch, None, &config);
        assert!(!map.contains_key("sec-fetch-dest"));
        assert_eq!(map[ACCEPT_ENCODING], "identity");
    }

    #[test]
    fn chrome_navigation_header_order() {
        let config = NetConfig::ephemeral();
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://www.example.com/"), &Method::GET, Destination::Document, None, &config);
        insert_cookie(&mut map, HeaderValue::from_static("a=b"));
        assert_eq!(
            names(&map),
            [
                "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests",
                "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user",
                "sec-fetch-dest", "accept-encoding", "accept-language", "cookie", "priority",
            ]
        );
        assert_eq!(map["sec-ch-ua"], config.sec_ch_ua.as_str());
        assert_eq!(map["sec-ch-ua-mobile"], "?0");
        assert_eq!(map["sec-ch-ua-platform"], "\"Windows\"");
        assert_eq!(map["priority"], "u=0, i");
        assert_eq!(map["sec-fetch-dest"], "document");
    }

    #[test]
    fn chrome_subresource_header_order_and_values() {
        let config = NetConfig::ephemeral();
        let page = url("https://www.example.com/index.html");
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://www.example.com/app.js"), &Method::GET, Destination::Script, Some(&page), &config);
        insert_cookie(&mut map, HeaderValue::from_static("a=b"));
        assert_eq!(
            names(&map),
            [
                "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "user-agent", "accept",
                "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "referer", "accept-encoding",
                "accept-language", "cookie", "priority",
            ]
        );
        assert_eq!(map["sec-fetch-dest"], "script");
        assert_eq!(map["sec-fetch-mode"], "no-cors");
        assert_eq!(map["sec-fetch-site"], "same-origin");
        assert_eq!(map["referer"], "https://www.example.com/index.html");
        assert_eq!(map["priority"], "u=1");
        assert!(!map.contains_key(ORIGIN));

        // A `crossorigin` script (mode carried as Sec-Fetch-Mode) to another origin sends Origin.
        let mut map = HeaderMap::new();
        map.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        apply_defaults(&mut map, &url("https://cdn.other.org/app.js"), &Method::GET, Destination::Script, Some(&page), &config);
        assert_eq!(map["sec-fetch-mode"], "cors");
        assert_eq!(map["origin"], "https://www.example.com");
        assert_eq!(map["sec-fetch-site"], "cross-site");
        assert_eq!(map["sec-fetch-dest"], "script");

        // Client headers (content-type, custom) sit between user-agent and accept.
        let mut map = HeaderMap::new();
        map.insert("content-type", HeaderValue::from_static("application/json"));
        map.insert("x-custom", HeaderValue::from_static("y"));
        map.append("x-custom", HeaderValue::from_static("z"));
        apply_defaults(&mut map, &url("https://www.example.com/api"), &Method::POST, Destination::Fetch, Some(&page), &config);
        let n = names(&map);
        assert_eq!(&n[3..8], ["user-agent", "content-type", "x-custom", "accept", "origin"]);
        assert_eq!(map.get_all("x-custom").iter().count(), 2);
        assert_eq!(map["priority"], "u=1, i");
        assert_eq!(map["sec-fetch-dest"], "empty");
    }

    #[test]
    fn iframe_font_media_and_insecure() {
        let config = NetConfig::ephemeral();
        let page = url("https://www.example.com/");
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://www.example.com/frame.html"), &Method::GET, Destination::Iframe, Some(&page), &config);
        assert_eq!(map["sec-fetch-dest"], "iframe");
        assert_eq!(map["sec-fetch-mode"], "navigate");
        assert_eq!(map["sec-fetch-site"], "same-origin");
        assert!(!map.contains_key("sec-fetch-user"));
        assert_eq!(map["upgrade-insecure-requests"], "1");
        assert_eq!(map[ACCEPT], config.document_accept.as_str());

        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://fonts.other.org/a.woff2"), &Method::GET, Destination::Font, Some(&page), &config);
        assert_eq!(map["sec-fetch-dest"], "font");
        assert_eq!(map["sec-fetch-mode"], "cors");
        assert_eq!(map["origin"], "https://www.example.com");

        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://www.example.com/v.mp4"), &Method::GET, Destination::Media, Some(&page), &config);
        assert_eq!(map["sec-fetch-dest"], "video");
        assert_eq!(map[ACCEPT_ENCODING], "identity;q=1, *;q=0");

        // Client hints and Priority only go to trustworthy origins / TLS; Sec-Fetch-Site is
        // always sent otherwise (and "none" without initiator).
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("http://example.com/a.png"), &Method::GET, Destination::Image, Some(&page), &config);
        assert!(!map.contains_key("sec-ch-ua") && !map.contains_key("priority") && !map.contains_key("sec-fetch-site"));
        let mut map = HeaderMap::new();
        apply_defaults(&mut map, &url("https://www.example.com/x.css"), &Method::GET, Destination::Style, None, &config);
        assert_eq!(map["sec-fetch-site"], "none");
        assert_eq!(map["priority"], "u=0");
    }
}
