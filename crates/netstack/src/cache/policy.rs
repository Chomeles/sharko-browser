//! RFC 9111 (HTTP Caching) rules for a private (single-user) cache: storability,
//! freshness lifetime, age calculation, validators and 304 header merging.
//!
//! Everything here is a pure function of headers and timestamps, so it is unit-tested
//! in isolation.

use std::time::{Duration, SystemTime};

use crate::alt_svc::split_outside_quotes;
use crate::util::{find_header, find_headers};

/// Upper bound for heuristic freshness (RFC 9111 4.2.2 suggests an upper limit; Firefox
/// uses one week as well).
pub(crate) const MAX_HEURISTIC_FRESHNESS: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Heuristic lifetime of permanent redirects without explicit freshness (Chrome caches
/// them indefinitely; one year is "indefinitely" for practical purposes).
pub(crate) const PERMANENT_REDIRECT_FRESHNESS: Duration = Duration::from_secs(365 * 24 * 60 * 60);
/// RFC 9111 1.2.2: delta-seconds that overflow are treated as 2^31.
const DELTA_SECONDS_MAX: u64 = 2_147_483_648;

/// Parsed `Cache-Control` directives (request or response).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct CacheControl {
    pub no_store: bool,
    pub no_cache: bool,
    pub private: bool,
    pub public: bool,
    pub must_revalidate: bool,
    pub immutable: bool,
    pub max_age: Option<u64>,
    pub stale_while_revalidate: Option<u64>,
    /// Request only.
    pub min_fresh: Option<u64>,
    /// Request only: `Some(None)` = any staleness accepted.
    pub max_stale: Option<Option<u64>>,
    /// Request only.
    pub only_if_cached: bool,
}

fn delta_seconds(v: Option<&str>) -> Option<u64> {
    let v = v?.trim().trim_matches('"');
    if v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(v.parse::<u64>().unwrap_or(DELTA_SECONDS_MAX).min(DELTA_SECONDS_MAX))
}

impl CacheControl {
    /// Parses all `Cache-Control` values of a message. For duplicated directives the first
    /// occurrence wins; an invalid `max-age` counts as `0` (stale), as RFC 9111 4.2.1
    /// encourages.
    pub fn parse<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let mut cc = Self::default();
        for value in values {
            for directive in split_outside_quotes(value, ',') {
                let (name, arg) = match directive.split_once('=') {
                    Some((n, a)) => (n.trim(), Some(a.trim())),
                    None => (directive.trim(), None),
                };
                match name.to_ascii_lowercase().as_str() {
                    "no-store" => cc.no_store = true,
                    // The qualified form (`no-cache="field"`) is treated like the
                    // unqualified one: always revalidate (conservative).
                    "no-cache" => cc.no_cache = true,
                    "private" => cc.private = true,
                    "public" => cc.public = true,
                    "must-revalidate" => cc.must_revalidate = true,
                    "immutable" => cc.immutable = true,
                    "only-if-cached" => cc.only_if_cached = true,
                    "max-age" if cc.max_age.is_none() => {
                        cc.max_age = Some(delta_seconds(arg).unwrap_or(0));
                    }
                    "stale-while-revalidate" if cc.stale_while_revalidate.is_none() => {
                        cc.stale_while_revalidate = delta_seconds(arg);
                    }
                    "min-fresh" if cc.min_fresh.is_none() => cc.min_fresh = delta_seconds(arg),
                    "max-stale" if cc.max_stale.is_none() => cc.max_stale = Some(delta_seconds(arg)),
                    _ => {}
                }
            }
        }
        cc
    }

    /// Parses the `Cache-Control` of a header list. `Pragma: no-cache` counts as
    /// `no-cache` when there is no `Cache-Control` (RFC 9111 5.4).
    pub fn from_headers(headers: &[(String, String)]) -> Self {
        let mut cc = Self::parse(find_headers(headers, "cache-control"));
        if find_header(headers, "cache-control").is_none()
            && find_headers(headers, "pragma").any(|p| p.to_ascii_lowercase().contains("no-cache"))
        {
            cc.no_cache = true;
        }
        cc
    }
}

/// Status codes this cache understands and may store.
fn is_understood_status(status: u16) -> bool {
    matches!(
        status,
        200 | 203 | 204 | 300 | 301 | 302 | 303 | 307 | 308 | 404 | 405 | 410 | 414 | 501
    )
}

/// Status codes that are "heuristically cacheable" (RFC 9110 15.1).
fn is_heuristically_cacheable(status: u16) -> bool {
    matches!(status, 200 | 203 | 204 | 300 | 301 | 308 | 404 | 405 | 410 | 414 | 501)
}

/// The `Vary` header of a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Vary {
    /// Lower-cased header names, sorted and de-duplicated (may be empty).
    Headers(Vec<String>),
    /// `Vary: *` — never matches, never stored.
    Any,
}

impl Vary {
    pub fn from_headers(headers: &[(String, String)]) -> Self {
        let mut names = Vec::new();
        for value in find_headers(headers, "vary") {
            for name in value.split(',') {
                let name = name.trim();
                if name == "*" {
                    return Vary::Any;
                }
                if !name.is_empty() {
                    names.push(name.to_ascii_lowercase());
                }
            }
        }
        names.sort();
        names.dedup();
        Vary::Headers(names)
    }
}

/// RFC 9111 section 3: may this response to a GET request be stored?
pub(crate) fn is_storable(
    status: u16,
    request_cc: &CacheControl,
    response_cc: &CacheControl,
    headers: &[(String, String)],
) -> bool {
    if request_cc.no_store || response_cc.no_store || !is_understood_status(status) {
        return false;
    }
    if Vary::from_headers(headers) == Vary::Any {
        return false;
    }
    response_cc.public
        || response_cc.private
        || response_cc.max_age.is_some()
        || find_header(headers, "expires").is_some()
        || is_heuristically_cacheable(status)
}

fn parse_date(headers: &[(String, String)], name: &str) -> Option<SystemTime> {
    find_header(headers, name).and_then(|v| httpdate::parse_http_date(v.trim()).ok())
}

/// Freshness lifetime (RFC 9111 4.2.1 / 4.2.2) of a stored response.
pub(crate) fn freshness_lifetime(
    status: u16,
    cc: &CacheControl,
    headers: &[(String, String)],
    response_time: SystemTime,
) -> Duration {
    if let Some(max_age) = cc.max_age {
        return Duration::from_secs(max_age);
    }
    let date = parse_date(headers, "date").unwrap_or(response_time);
    if let Some(expires) = find_header(headers, "expires") {
        // Invalid dates (notably "0") mean "already expired".
        return match httpdate::parse_http_date(expires.trim()) {
            Ok(expires) => expires.duration_since(date).unwrap_or(Duration::ZERO),
            Err(_) => Duration::ZERO,
        };
    }
    if !(is_heuristically_cacheable(status) || cc.public) {
        return Duration::ZERO;
    }
    if matches!(status, 301 | 308) {
        return PERMANENT_REDIRECT_FRESHNESS;
    }
    if let Some(last_modified) = parse_date(headers, "last-modified")
        && let Ok(since) = date.duration_since(last_modified)
    {
        return (since / 10).min(MAX_HEURISTIC_FRESHNESS);
    }
    Duration::ZERO
}

/// Current age (RFC 9111 4.2.3).
pub(crate) fn current_age(
    headers: &[(String, String)],
    request_time: SystemTime,
    response_time: SystemTime,
    now: SystemTime,
) -> Duration {
    let date = parse_date(headers, "date").unwrap_or(response_time);
    let apparent_age = response_time.duration_since(date).unwrap_or(Duration::ZERO);
    let age_value = delta_seconds(find_header(headers, "age")).unwrap_or(0);
    let response_delay = response_time.duration_since(request_time).unwrap_or(Duration::ZERO);
    let corrected_age_value = Duration::from_secs(age_value) + response_delay;
    let corrected_initial_age = apparent_age.max(corrected_age_value);
    let resident_time = now.duration_since(response_time).unwrap_or(Duration::ZERO);
    corrected_initial_age + resident_time
}

/// Result of checking a stored response against a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Freshness {
    /// May be used without contacting the server.
    Fresh,
    /// Stale, but `stale-while-revalidate` allows serving it while revalidating in the
    /// background.
    StaleWhileRevalidate,
    /// Must be revalidated (or refetched).
    Stale,
}

/// Evaluates a stored response for a request with `request_cc` at time `now`.
pub(crate) fn evaluate(
    status: u16,
    headers: &[(String, String)],
    request_time: SystemTime,
    response_time: SystemTime,
    request_cc: &CacheControl,
    now: SystemTime,
) -> Freshness {
    let cc = CacheControl::from_headers(headers);
    if cc.no_cache || request_cc.no_cache {
        return Freshness::Stale;
    }
    let lifetime = freshness_lifetime(status, &cc, headers, response_time);
    let age = current_age(headers, request_time, response_time, now);
    if request_cc.max_age.is_some_and(|max| age > Duration::from_secs(max)) {
        return Freshness::Stale;
    }
    if let Some(min_fresh) = request_cc.min_fresh
        && lifetime.saturating_sub(age) < Duration::from_secs(min_fresh)
    {
        return Freshness::Stale;
    }
    if lifetime > age {
        return Freshness::Fresh;
    }
    let staleness = age - lifetime;
    if !cc.must_revalidate {
        match request_cc.max_stale {
            Some(None) => return Freshness::Fresh,
            Some(Some(max_stale)) if staleness <= Duration::from_secs(max_stale) => {
                return Freshness::Fresh;
            }
            _ => {}
        }
        if let Some(swr) = cc.stale_while_revalidate
            && staleness < Duration::from_secs(swr)
        {
            return Freshness::StaleWhileRevalidate;
        }
    }
    Freshness::Stale
}

/// Conditional request headers for revalidating a stored response.
pub(crate) fn validators(headers: &[(String, String)]) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if let Some(etag) = find_header(headers, "etag") {
        out.push(("if-none-match", etag.to_owned()));
    }
    if let Some(lm) = find_header(headers, "last-modified") {
        out.push(("if-modified-since", lm.to_owned()));
    }
    out
}

/// Headers of a 304 that must not replace stored ones (RFC 9111 3.2 / 4.3.4): framing,
/// hop-by-hop and cookie headers. Content-Encoding is excluded because stored bodies are
/// already decoded.
fn is_excluded_from_update(name: &str) -> bool {
    matches!(
        name,
        "content-length"
            | "content-encoding"
            | "content-range"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "upgrade"
            | "set-cookie"
            | "set-cookie2"
    )
}

/// Merges the headers of a `304 Not Modified` into the stored headers: every field
/// present in the 304 replaces all stored values of that field.
pub(crate) fn merge_not_modified(stored: &mut Vec<(String, String)>, fresh: &[(String, String)]) {
    let mut replaced: Vec<&str> = Vec::new();
    for (name, _) in fresh {
        let lname = name.as_str();
        if is_excluded_from_update(lname) || replaced.contains(&lname) {
            continue;
        }
        replaced.push(lname);
        stored.retain(|(k, _)| !k.eq_ignore_ascii_case(lname));
        stored.extend(
            fresh
                .iter()
                .filter(|(k, _)| k.eq_ignore_ascii_case(lname))
                .map(|(k, v)| (k.clone(), v.clone())),
        );
    }
}

/// Filters headers before storing: hop-by-hop fields and cookies are not cached.
pub(crate) fn storable_headers(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            !matches!(
                k.as_str(),
                "connection"
                    | "keep-alive"
                    | "proxy-connection"
                    | "te"
                    | "trailer"
                    | "transfer-encoding"
                    | "upgrade"
                    | "set-cookie"
                    | "set-cookie2"
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn t(secs: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(secs)
    }

    fn date(secs: u64) -> String {
        httpdate::fmt_http_date(t(secs))
    }

    const T0: u64 = 1_700_000_000;

    #[test]
    fn cache_control_parsing() {
        let cc = CacheControl::parse(["public, max-age=60, Must-Revalidate", "no-cache=\"set-cookie\""]);
        assert!(cc.public && cc.must_revalidate && cc.no_cache);
        assert_eq!(cc.max_age, Some(60));
        // First occurrence wins, invalid values are stale, quoted values accepted.
        assert_eq!(CacheControl::parse(["max-age=5, max-age=100"]).max_age, Some(5));
        assert_eq!(CacheControl::parse(["max-age=abc"]).max_age, Some(0));
        assert_eq!(CacheControl::parse(["max-age=\"30\""]).max_age, Some(30));
        assert_eq!(CacheControl::parse(["max-age=99999999999999999999"]).max_age, Some(DELTA_SECONDS_MAX));
        let req = CacheControl::parse(["max-stale, min-fresh=10, only-if-cached"]);
        assert_eq!(req.max_stale, Some(None));
        assert_eq!(req.min_fresh, Some(10));
        assert!(req.only_if_cached);
        // Pragma: no-cache only counts without Cache-Control.
        assert!(CacheControl::from_headers(&h(&[("pragma", "no-cache")])).no_cache);
        assert!(!CacheControl::from_headers(&h(&[("pragma", "no-cache"), ("cache-control", "max-age=5")])).no_cache);
    }

    #[test]
    fn freshness_max_age_beats_expires() {
        let headers = h(&[("date", &date(T0)), ("expires", &date(T0 + 10)), ("cache-control", "max-age=100")]);
        let cc = CacheControl::from_headers(&headers);
        assert_eq!(freshness_lifetime(200, &cc, &headers, t(T0)), Duration::from_secs(100));
    }

    #[test]
    fn freshness_expires_relative_to_date() {
        let headers = h(&[("date", &date(T0)), ("expires", &date(T0 + 3600))]);
        let cc = CacheControl::from_headers(&headers);
        // Even if our clock is off (response_time far away), Expires - Date is used.
        assert_eq!(freshness_lifetime(200, &cc, &headers, t(T0 + 500)), Duration::from_secs(3600));
        // Invalid Expires = already expired.
        let headers = h(&[("date", &date(T0)), ("expires", "0")]);
        assert_eq!(freshness_lifetime(200, &CacheControl::default(), &headers, t(T0)), Duration::ZERO);
    }

    #[test]
    fn heuristic_freshness_is_ten_percent() {
        let headers = h(&[("date", &date(T0)), ("last-modified", &date(T0 - 10_000))]);
        let cc = CacheControl::default();
        assert_eq!(freshness_lifetime(200, &cc, &headers, t(T0)), Duration::from_secs(1_000));
        // Capped at one week.
        let old = h(&[("date", &date(T0)), ("last-modified", &date(T0 - 1000 * 24 * 3600))]);
        assert_eq!(freshness_lifetime(200, &cc, &old, t(T0)), MAX_HEURISTIC_FRESHNESS);
        // Not for non-heuristic statuses (e.g. 302) and not without Last-Modified.
        assert_eq!(freshness_lifetime(302, &cc, &headers, t(T0)), Duration::ZERO);
        assert_eq!(freshness_lifetime(200, &cc, &h(&[("date", &date(T0))]), t(T0)), Duration::ZERO);
        // Permanent redirects are cached "forever".
        assert_eq!(freshness_lifetime(301, &cc, &h(&[]), t(T0)), PERMANENT_REDIRECT_FRESHNESS);
    }

    #[test]
    fn age_calculation() {
        // Response generated at T0 with Age: 10, request sent at T0+1, received T0+3.
        let headers = h(&[("date", &date(T0)), ("age", "10")]);
        let age = current_age(&headers, t(T0 + 1), t(T0 + 3), t(T0 + 20));
        // corrected_age_value = 10 + (3-1) = 12; apparent = 3; resident = 17 => 29
        assert_eq!(age, Duration::from_secs(29));
        // Date in the future (clock skew) doesn't produce negative ages.
        let skewed = h(&[("date", &date(T0 + 1000))]);
        assert_eq!(current_age(&skewed, t(T0), t(T0), t(T0 + 5)), Duration::from_secs(5));
    }

    #[test]
    fn evaluate_fresh_stale_and_request_directives() {
        let headers = h(&[("date", &date(T0)), ("cache-control", "max-age=60")]);
        let none = CacheControl::default();
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &none, t(T0 + 30)), Freshness::Fresh);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &none, t(T0 + 61)), Freshness::Stale);
        // Request no-cache / max-age=0 force revalidation.
        let no_cache = CacheControl::parse(["no-cache"]);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &no_cache, t(T0 + 1)), Freshness::Stale);
        let max_age0 = CacheControl::parse(["max-age=0"]);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &max_age0, t(T0 + 1)), Freshness::Stale);
        // min-fresh.
        let min_fresh = CacheControl::parse(["min-fresh=50"]);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &min_fresh, t(T0 + 20)), Freshness::Stale);
        // max-stale accepts stale responses unless must-revalidate.
        let max_stale = CacheControl::parse(["max-stale=100"]);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &max_stale, t(T0 + 120)), Freshness::Fresh);
        let mr = h(&[("date", &date(T0)), ("cache-control", "max-age=60, must-revalidate")]);
        assert_eq!(evaluate(200, &mr, t(T0), t(T0), &max_stale, t(T0 + 120)), Freshness::Stale);
        // Response no-cache: always revalidate even if "fresh".
        let nc = h(&[("date", &date(T0)), ("cache-control", "no-cache, max-age=600")]);
        assert_eq!(evaluate(200, &nc, t(T0), t(T0), &none, t(T0 + 1)), Freshness::Stale);
    }

    #[test]
    fn stale_while_revalidate_window() {
        let headers = h(&[("date", &date(T0)), ("cache-control", "max-age=10, stale-while-revalidate=30")]);
        let none = CacheControl::default();
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &none, t(T0 + 5)), Freshness::Fresh);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &none, t(T0 + 20)), Freshness::StaleWhileRevalidate);
        assert_eq!(evaluate(200, &headers, t(T0), t(T0), &none, t(T0 + 50)), Freshness::Stale);
    }

    #[test]
    fn storability() {
        let none = CacheControl::default();
        let plain = h(&[]);
        assert!(is_storable(200, &none, &none, &plain));
        assert!(!is_storable(206, &none, &none, &plain));
        assert!(!is_storable(500, &none, &none, &plain));
        // 302 only with explicit freshness.
        assert!(!is_storable(302, &none, &none, &plain));
        let ma = CacheControl::parse(["max-age=10"]);
        assert!(is_storable(302, &none, &ma, &plain));
        // no-store in request or response.
        let ns = CacheControl::parse(["no-store"]);
        assert!(!is_storable(200, &ns, &none, &plain));
        assert!(!is_storable(200, &none, &ns, &plain));
        // Vary: * is never stored.
        assert!(!is_storable(200, &none, &ma, &h(&[("vary", "Accept, *")])));
    }

    #[test]
    fn vary_parsing() {
        assert_eq!(
            Vary::from_headers(&h(&[("vary", "Accept-Encoding, Origin"), ("Vary", "accept-encoding")])),
            Vary::Headers(vec!["accept-encoding".into(), "origin".into()])
        );
        assert_eq!(Vary::from_headers(&h(&[])), Vary::Headers(vec![]));
        assert_eq!(Vary::from_headers(&h(&[("vary", "*")])), Vary::Any);
    }

    #[test]
    fn validators_and_304_merge() {
        let mut stored = h(&[
            ("content-type", "text/css"),
            ("etag", "\"v1\""),
            ("last-modified", "Mon, 01 Jan 2024 00:00:00 GMT"),
            ("cache-control", "max-age=0"),
            ("link", "<a>"),
            ("link", "<b>"),
        ]);
        let v = validators(&stored);
        assert_eq!(v[0], ("if-none-match", "\"v1\"".to_string()));
        assert_eq!(v[1].0, "if-modified-since");
        let fresh = h(&[
            ("cache-control", "max-age=60"),
            ("etag", "\"v1\""),
            ("content-length", "0"),
            ("set-cookie", "a=b"),
            ("link", "<c>"),
        ]);
        merge_not_modified(&mut stored, &fresh);
        assert_eq!(find_header(&stored, "cache-control"), Some("max-age=60"));
        assert_eq!(find_header(&stored, "content-type"), Some("text/css"));
        assert!(find_header(&stored, "content-length").is_none());
        assert!(find_header(&stored, "set-cookie").is_none());
        assert_eq!(find_headers(&stored, "link").collect::<Vec<_>>(), vec!["<c>"]);
    }

    #[test]
    fn storable_headers_filter() {
        let out = storable_headers(h(&[("Set-Cookie", "a=b"), ("connection", "close"), ("etag", "x")]));
        assert_eq!(out, h(&[("etag", "x")]));
    }
}
