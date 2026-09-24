//! `Alt-Svc` (RFC 7838) bookkeeping for the HTTP/3 upgrade, modelled after Chrome:
//!
//! * An `https` response with `Alt-Svc: h3=":443"; ma=86400` records that the origin
//!   speaks HTTP/3 on the same port until the max-age expires. A new `Alt-Svc` header
//!   replaces the previous information, `clear` removes it.
//! * The first HTTP/3 use of an origin is a *race*: QUIC gets a head start, then TCP
//!   (h2/h1.1) is started in parallel and the first response wins (idempotent requests
//!   only). While that probe runs, other requests to the origin use TCP.
//! * A QUIC success marks the origin *confirmed*: later requests go straight to HTTP/3.
//! * A failure marks the origin *broken* for 5 minutes, doubling with each consecutive
//!   failure (capped at 2 days), like Chrome's broken-alternative-service backoff.
//! * Three consecutive QUIC failures on different origins without any success suggest
//!   that UDP is blocked on this network; HTTP/3 is then paused globally for 5 minutes.
//!
//! Alternatives on another host or port are ignored: reqwest dials HTTP/3 to the URL's
//! own authority. In practice every major deployment advertises `h3=":443"`.
//!
//! Advertisements (not the broken/confirmed state) are persisted to
//! `<profile>/alt-svc.json` so a new session can use HTTP/3 right away.
//!
//! Without the `http3` feature advertisements are still parsed and persisted (so a
//! profile can be shared with HTTP/3-enabled builds), but never acted upon.
#![cfg_attr(not(feature = "http3"), allow(dead_code))]

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use crate::util::{from_unix_ms, unix_ms, write_atomic};

const DEFAULT_MAX_AGE: u64 = 24 * 60 * 60;
const BROKEN_BASE: Duration = Duration::from_secs(5 * 60);
const BROKEN_MAX: Duration = Duration::from_secs(2 * 24 * 60 * 60);
const GLOBAL_FAILURE_THRESHOLD: u32 = 3;
const GLOBAL_PAUSE: Duration = Duration::from_secs(5 * 60);
const MAX_ORIGINS: usize = 10_000;

/// One alternative from an `Alt-Svc` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AltService {
    /// ALPN protocol id, percent-decoded (e.g. `h3`).
    pub protocol: String,
    /// Alternative host; empty means "same host as the origin".
    pub host: String,
    pub port: u16,
    /// Freshness lifetime in seconds (`ma`, default 24 h).
    pub max_age: u64,
}

/// A parsed `Alt-Svc` header value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AltSvcValue {
    Clear,
    Services(Vec<AltService>),
}

/// Parses an `Alt-Svc` header value. Invalid alternatives are skipped; `None` is returned
/// when nothing usable remains.
pub(crate) fn parse_alt_svc(value: &str) -> Option<AltSvcValue> {
    let trimmed = value.trim();
    if trimmed == "clear" {
        return Some(AltSvcValue::Clear);
    }
    let mut services = Vec::new();
    for alternative in split_outside_quotes(trimmed, ',') {
        let mut parts = split_outside_quotes(alternative, ';').into_iter();
        let Some(first) = parts.next() else { continue };
        let Some((protocol, authority)) = first.split_once('=') else {
            continue;
        };
        let protocol = percent_encoding::percent_decode_str(protocol.trim())
            .decode_utf8_lossy()
            .into_owned();
        if protocol.is_empty() {
            continue;
        }
        let authority = unquote(authority.trim());
        let Some((host, port)) = authority.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port.parse::<u16>() else { continue };
        if port == 0 {
            continue;
        }
        let mut max_age = DEFAULT_MAX_AGE;
        for param in parts {
            if let Some((k, v)) = param.split_once('=')
                && k.trim().eq_ignore_ascii_case("ma")
            {
                // Invalid max-age values make the alternative unusable.
                max_age = unquote(v.trim()).parse::<u64>().unwrap_or(0);
            }
        }
        services.push(AltService {
            protocol,
            host: host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase(),
            port,
            max_age,
        });
    }
    if services.is_empty() {
        None
    } else {
        Some(AltSvcValue::Services(services))
    }
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let inner = &s[1..s.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut escaped = false;
        for c in inner.chars() {
            if escaped {
                out.push(c);
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else {
                out.push(c);
            }
        }
        out
    } else {
        s.to_owned()
    }
}

/// Splits on `sep` outside of double-quoted strings, trimming and dropping empty parts.
pub(crate) fn split_outside_quotes(s: &str, sep: char) -> Vec<&str> {
    let mut out = Vec::new();
    let mut in_quotes = false;
    let mut escaped = false;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' if in_quotes => escaped = true,
            '"' => in_quotes = !in_quotes,
            c if c == sep && !in_quotes => {
                let part = s[start..i].trim();
                if !part.is_empty() {
                    out.push(part);
                }
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    let part = s[start..].trim();
    if !part.is_empty() {
        out.push(part);
    }
    out
}

/// What to do for a request to an `https` origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum H3Plan {
    /// Use TCP (h2 / h1.1) only.
    Tcp,
    /// Try QUIC first, race TCP after a head start (the attempt is the origin's probe).
    Race,
    /// QUIC is confirmed for this origin: use HTTP/3, fall back to TCP on failure.
    Direct,
}

#[derive(Debug, Default)]
struct OriginState {
    /// HTTP/3 advertised on the origin's own port until this time.
    h3_until: Option<SystemTime>,
    confirmed: bool,
    probing: bool,
    broken_until: Option<Instant>,
    broken_count: u32,
}

#[derive(Default)]
struct Inner {
    origins: HashMap<String, OriginState>,
    global_failures: u32,
    global_pause_until: Option<Instant>,
}

/// Per-origin HTTP/3 state.
pub(crate) struct AltSvcCache {
    inner: Mutex<Inner>,
    path: Option<PathBuf>,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
struct Persisted {
    /// origin (`host:port`) → advertisement expiry (unix ms)
    h3: Vec<(String, u64)>,
}

pub(crate) fn origin_key(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_ascii_lowercase())
}

impl AltSvcCache {
    pub fn open(path: Option<PathBuf>, enabled: bool) -> Self {
        let mut inner = Inner::default();
        if let Some(p) = &path {
            match std::fs::read(p) {
                Ok(bytes) => match serde_json::from_slice::<Persisted>(&bytes) {
                    Ok(persisted) => {
                        let now = SystemTime::now();
                        for (origin, until) in persisted.h3 {
                            let until = from_unix_ms(until);
                            if until > now {
                                inner.origins.entry(origin).or_default().h3_until = Some(until);
                            }
                        }
                    }
                    Err(e) => log::warn!("ignoring corrupt {}: {e}", p.display()),
                },
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => log::warn!("cannot read {}: {e}", p.display()),
            }
        }
        Self {
            inner: Mutex::new(inner),
            path,
            enabled,
        }
    }

    /// Records the `Alt-Svc` header of a response from `https://host:port`.
    /// Returns `true` if persisted state changed.
    pub fn on_header(&self, host: &str, port: u16, value: &str) -> bool {
        let Some(parsed) = parse_alt_svc(value) else {
            return false;
        };
        let key = origin_key(host, port);
        let now = SystemTime::now();
        let h3_until = match parsed {
            AltSvcValue::Clear => None,
            AltSvcValue::Services(services) => services
                .iter()
                .filter(|s| {
                    s.protocol == "h3"
                        && s.port == port
                        && (s.host.is_empty() || s.host.eq_ignore_ascii_case(host))
                        && s.max_age > 0
                })
                .map(|s| now + Duration::from_secs(s.max_age.min(365 * 24 * 60 * 60)))
                .max(),
        };
        let mut inner = self.inner.lock();
        if h3_until.is_none() && !inner.origins.contains_key(&key) {
            return false;
        }
        if inner.origins.len() >= MAX_ORIGINS && !inner.origins.contains_key(&key) {
            // Bound memory: forget origins without an advertisement first.
            inner.origins.retain(|_, s| s.h3_until.is_some_and(|t| t > now));
            if inner.origins.len() >= MAX_ORIGINS {
                return false;
            }
        }
        let state = inner.origins.entry(key).or_default();
        let was_advertised = state.h3_until.is_some();
        state.h3_until = h3_until;
        if h3_until.is_none() {
            state.confirmed = false;
        }
        // Only a new or removed advertisement is worth persisting; refreshed max-ages
        // are persisted with the next change or at shutdown.
        was_advertised != h3_until.is_some()
    }

    /// Decides how to reach `https://host:port` for a request.
    pub fn plan(&self, host: &str, port: u16, idempotent: bool) -> H3Plan {
        if !self.enabled {
            return H3Plan::Tcp;
        }
        let now = Instant::now();
        let mut inner = self.inner.lock();
        if inner.global_pause_until.is_some_and(|t| t > now) {
            return H3Plan::Tcp;
        }
        let Some(state) = inner.origins.get_mut(&origin_key(host, port)) else {
            return H3Plan::Tcp;
        };
        if state.h3_until.is_none_or(|t| t <= SystemTime::now()) {
            return H3Plan::Tcp;
        }
        if state.broken_until.is_some_and(|t| t > now) || state.probing {
            return H3Plan::Tcp;
        }
        if state.confirmed {
            H3Plan::Direct
        } else if idempotent {
            state.probing = true;
            H3Plan::Race
        } else {
            H3Plan::Tcp
        }
    }

    /// HTTP/3 worked for the origin.
    pub fn mark_confirmed(&self, host: &str, port: u16) {
        let mut inner = self.inner.lock();
        inner.global_failures = 0;
        if let Some(state) = inner.origins.get_mut(&origin_key(host, port)) {
            state.confirmed = true;
            state.probing = false;
            state.broken_count = 0;
            state.broken_until = None;
        }
    }

    /// HTTP/3 failed for the origin: back off exponentially.
    pub fn mark_broken(&self, host: &str, port: u16) {
        let now = Instant::now();
        let mut inner = self.inner.lock();
        inner.global_failures += 1;
        if inner.global_failures >= GLOBAL_FAILURE_THRESHOLD {
            log::info!("HTTP/3 failed on {} origins in a row; pausing QUIC for {GLOBAL_PAUSE:?}", inner.global_failures);
            inner.global_pause_until = Some(now + GLOBAL_PAUSE);
            inner.global_failures = 0;
        }
        if let Some(state) = inner.origins.get_mut(&origin_key(host, port)) {
            state.confirmed = false;
            state.probing = false;
            let factor = 1u32 << state.broken_count.min(10);
            let backoff = BROKEN_BASE.saturating_mul(factor).min(BROKEN_MAX);
            state.broken_until = Some(now + backoff);
            state.broken_count = state.broken_count.saturating_add(1);
            log::debug!("HTTP/3 to {host}:{port} marked broken for {backoff:?}");
        }
    }

    /// Persists unexpired advertisements.
    pub fn save(&self) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let now = SystemTime::now();
        let persisted = {
            let inner = self.inner.lock();
            Persisted {
                h3: inner
                    .origins
                    .iter()
                    .filter_map(|(k, s)| {
                        s.h3_until
                            .filter(|t| *t > now)
                            .map(|t| (k.clone(), unix_ms(t)))
                    })
                    .collect(),
            }
        };
        let json = serde_json::to_vec(&persisted).map_err(io::Error::other)?;
        write_atomic(path, &json, false)
    }

    #[cfg(test)]
    fn is_broken(&self, host: &str, port: u16) -> bool {
        let inner = self.inner.lock();
        inner
            .origins
            .get(&origin_key(host, port))
            .and_then(|s| s.broken_until)
            .is_some_and(|t| t > Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_common_forms() {
        let v = parse_alt_svc(r#"h3=":443"; ma=2592000, h3-29=":443"; ma=2592000"#).unwrap();
        let AltSvcValue::Services(s) = v else { panic!() };
        assert_eq!(s.len(), 2);
        assert_eq!(
            s[0],
            AltService { protocol: "h3".into(), host: String::new(), port: 443, max_age: 2_592_000 }
        );
        assert_eq!(s[1].protocol, "h3-29");

        assert_eq!(parse_alt_svc("clear"), Some(AltSvcValue::Clear));
        let v = parse_alt_svc(r#"h2="alt.example.com:8443", h3=":443""#).unwrap();
        let AltSvcValue::Services(s) = v else { panic!() };
        assert_eq!(s[0].host, "alt.example.com");
        assert_eq!(s[0].port, 8443);
        assert_eq!(s[0].max_age, DEFAULT_MAX_AGE);
        assert_eq!(s[1].protocol, "h3");
    }

    #[test]
    fn parse_edge_cases() {
        // Percent-encoded protocol id, quoted params, persist, unquoted authority.
        let v = parse_alt_svc(r#"w%3Dx%3Ay=":80"; ma="60"; persist=1, h3=:443"#).unwrap();
        let AltSvcValue::Services(s) = v else { panic!() };
        assert_eq!(s[0].protocol, "w=x:y");
        assert_eq!(s[0].max_age, 60);
        assert_eq!(s[1].port, 443);
        // Garbage is ignored.
        assert_eq!(parse_alt_svc("h3"), None);
        assert_eq!(parse_alt_svc(r#"h3=":notaport""#), None);
        assert_eq!(parse_alt_svc(""), None);
        // IPv6 alternative host.
        let v = parse_alt_svc(r#"h3="[::1]:443""#).unwrap();
        let AltSvcValue::Services(s) = v else { panic!() };
        assert_eq!(s[0].host, "::1");
    }

    #[test]
    fn state_machine() {
        let c = AltSvcCache::open(None, true);
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Tcp);
        // Other port / other host / draft versions are not used.
        c.on_header("example.com", 443, r#"h3=":8443", h3-29=":443", h3="other.com:443""#);
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Tcp);
        c.on_header("example.com", 443, r#"h3=":443"; ma=3600"#);
        // Non-idempotent requests don't probe.
        assert_eq!(c.plan("example.com", 443, false), H3Plan::Tcp);
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Race);
        // While the probe runs, everything else uses TCP.
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Tcp);
        c.mark_confirmed("example.com", 443);
        assert_eq!(c.plan("example.com", 443, false), H3Plan::Direct);
        c.mark_broken("example.com", 443);
        assert!(c.is_broken("example.com", 443));
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Tcp);
        // `clear` forgets the advertisement.
        c.on_header("example.com", 443, "clear");
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Tcp);
    }

    #[test]
    fn global_pause_after_repeated_failures() {
        let c = AltSvcCache::open(None, true);
        for host in ["a.com", "b.com", "c.com", "d.com"] {
            c.on_header(host, 443, r#"h3=":443""#);
        }
        for host in ["a.com", "b.com", "c.com"] {
            assert_eq!(c.plan(host, 443, true), H3Plan::Race);
            c.mark_broken(host, 443);
        }
        assert_eq!(c.plan("d.com", 443, true), H3Plan::Tcp);
    }

    #[test]
    fn disabled_and_persistence() {
        let c = AltSvcCache::open(None, false);
        c.on_header("example.com", 443, r#"h3=":443""#);
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Tcp);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alt-svc.json");
        let c = AltSvcCache::open(Some(path.clone()), true);
        assert!(c.on_header("example.com", 443, r#"h3=":443"; ma=600"#));
        c.save().unwrap();
        let c = AltSvcCache::open(Some(path), true);
        assert_eq!(c.plan("example.com", 443, true), H3Plan::Race);
    }
}
