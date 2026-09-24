//! The HTTP(S) fetch pipeline, structured like the Fetch spec:
//!
//! * `http_fetch` — main fetch: method/header sanitizing and the redirect loop (up to
//!   20 hops, 301/302 POST→GET and 303→GET rewriting, `Authorization` dropped across
//!   origins, fragment inheritance). Redirects are followed here rather than inside
//!   reqwest so that every hop gets its own cookies, cache lookup, `Referer` and
//!   HTTP/3 decision.
//! * `fetch_hop` — HTTP-network-or-cache fetch: default headers, cookies, cache modes,
//!   freshness, conditional revalidation (304 merging), stale-while-revalidate,
//!   storing, invalidation by unsafe methods.
//! * `network` — HTTP/1.1 / HTTP/2 over TCP, or HTTP/3 over QUIC for origins that
//!   advertised it (see `alt_svc`), with fallback; response body reading with an idle
//!   timeout.

use bytes::Bytes;
use common::protocol::{CacheMode, Destination, NetRequest};
use http::header::{
    ALT_SVC, AUTHORIZATION, CACHE_CONTROL, CONTENT_LOCATION, COOKIE, LOCATION, PRAGMA, RANGE,
};
use http::{HeaderMap, HeaderValue, Method, Version};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::sync::OwnedSemaphorePermit;
use url::Url;

use crate::cache::policy::{self, CacheControl, Freshness, Vary};
use crate::cache::{StoredResponse, primary_key};
use crate::core::NetworkCore;
use crate::error::NetError;
use crate::headers;
#[cfg(feature = "http3")]
use crate::alt_svc::H3Plan;
use crate::util::{MAX_BODY_BYTES, Response, concat_chunks, find_header, headers_to_vec, version_str};

const MAX_REDIRECTS: usize = 20;

/// One request of a (possibly redirected) fetch.
#[derive(Clone, Debug)]
pub(crate) struct Hop {
    url: Url,
    method: Method,
    /// Client-supplied headers (sanitized), without the defaults added per hop.
    headers: HeaderMap,
    body: Option<Bytes>,
    destination: Destination,
    referrer: Option<Url>,
    credentials: bool,
    cache_mode: CacheMode,
}

impl Hop {
    /// Follows a redirect response with `status` to `next` (Fetch spec, HTTP-redirect
    /// fetch steps 11-13 and 18).
    fn redirect(mut self, status: u16, mut next: Url) -> Hop {
        if next.fragment().is_none()
            && let Some(fragment) = self.url.fragment()
        {
            next.set_fragment(Some(fragment));
        }
        let to_get = ((status == 301 || status == 302) && self.method == Method::POST)
            || (status == 303 && self.method != Method::GET && self.method != Method::HEAD);
        if to_get {
            self.method = Method::GET;
            self.body = None;
            for name in ["content-type", "content-encoding", "content-language", "content-location"] {
                self.headers.remove(name);
            }
        }
        if self.url.origin() != next.origin() {
            self.headers.remove(AUTHORIZATION);
        }
        self.url = next;
        self
    }
}

/// A response as received from the network.
struct NetResult {
    status: u16,
    version: Version,
    headers: HeaderMap,
    body: Bytes,
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn is_safe(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE)
}

/// Normalizes the method like the Fetch spec (case-insensitive for the common ones).
fn parse_method(raw: &str) -> Result<Method, NetError> {
    let raw = raw.trim();
    let upper = raw.to_ascii_uppercase();
    let name = match upper.as_str() {
        "DELETE" | "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" => upper.as_str(),
        _ => raw,
    };
    if raw.is_empty() {
        return Ok(Method::GET);
    }
    if matches!(upper.as_str(), "CONNECT" | "TRACE" | "TRACK") {
        return Err(NetError::new("ERR_METHOD_NOT_SUPPORTED", format!("method {raw} is forbidden")));
    }
    Method::from_bytes(name.as_bytes())
        .map_err(|_| NetError::new("ERR_METHOD_NOT_SUPPORTED", format!("invalid method {raw:?}")))
}

fn has_conditional_headers(headers: &HeaderMap) -> bool {
    ["if-modified-since", "if-none-match", "if-unmodified-since", "if-match", "if-range"]
        .iter()
        .any(|h| headers.contains_key(*h))
}

fn cached_response(stored: &StoredResponse, url: &Url) -> Response {
    Response {
        status: stored.status,
        url: url.to_string(),
        headers: stored.headers.clone(),
        body: stored.body.clone(),
        from_cache: true,
        http_version: stored.http_version,
    }
}

/// `https://host:port` of a URL (the per-origin key for limits and Alt-Svc).
fn origin_parts(url: &Url) -> (String, u16, String) {
    let host = url.host_str().unwrap_or_default().to_owned();
    let port = url.port_or_known_default().unwrap_or(0);
    let origin = format!("{}://{}:{}", url.scheme(), host, port);
    (host, port, origin)
}

async fn read_body(mut resp: reqwest::Response, idle: Duration) -> Result<Bytes, NetError> {
    let mut chunks = Vec::new();
    let mut total = 0usize;
    loop {
        match tokio::time::timeout(idle, resp.chunk()).await {
            Err(_) => {
                return Err(NetError::timed_out(format!(
                    "no data received for {}s while reading the body",
                    idle.as_secs()
                )));
            }
            Ok(Err(e)) => return Err(NetError::from_reqwest(&e)),
            Ok(Ok(Some(chunk))) => {
                total += chunk.len();
                if total > MAX_BODY_BYTES {
                    return Err(NetError::too_big());
                }
                chunks.push(chunk);
            }
            Ok(Ok(None)) => break,
        }
    }
    Ok(concat_chunks(chunks, total))
}

impl NetworkCore {
    /// Main fetch for http(s) URLs, including the redirect loop.
    pub(crate) async fn http_fetch(self: &Arc<Self>, req: NetRequest, url: Url) -> Result<Response, NetError> {
        let method = parse_method(&req.method)?;
        let (client_headers, header_referrer) = headers::sanitize(&req.headers);
        let referrer = req
            .referrer
            .as_deref()
            .or(header_referrer.as_deref())
            .filter(|r| !r.is_empty() && *r != "no-referrer" && *r != "client")
            .and_then(|r| Url::parse(r).ok());
        let mut hop = Hop {
            url,
            method,
            headers: client_headers,
            body: req.body.map(Bytes::from),
            destination: req.destination,
            referrer,
            credentials: req.credentials,
            cache_mode: req.cache_mode,
        };
        let mut redirects = 0;
        loop {
            let response = self.fetch_hop(&hop).await?;
            if !req.follow_redirects || !is_redirect(response.status) {
                return Ok(response);
            }
            let Some(location) = find_header(&response.headers, "location") else {
                return Ok(response);
            };
            let next = hop.url.join(location.trim()).map_err(|e| {
                NetError::new("ERR_INVALID_REDIRECT", format!("bad Location {location:?}: {e}"))
            })?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(NetError::new(
                    "ERR_UNSAFE_REDIRECT",
                    format!("redirect to non-HTTP URL {next}"),
                ));
            }
            redirects += 1;
            if redirects > MAX_REDIRECTS {
                return Err(NetError::new(
                    "ERR_TOO_MANY_REDIRECTS",
                    format!("more than {MAX_REDIRECTS} redirects"),
                ));
            }
            log::debug!("redirect {} -> {next}", hop.url);
            hop = hop.redirect(response.status, next);
        }
    }

    /// Final request headers of a hop: client headers + defaults + cookies.
    fn request_headers(&self, hop: &Hop) -> HeaderMap {
        let mut headers = hop.headers.clone();
        headers::apply_defaults(
            &mut headers,
            &hop.url,
            &hop.method,
            hop.destination,
            hop.referrer.as_ref(),
            &self.config,
        );
        if hop.credentials
            && let Some(cookie) = self.cookies.request_header(&hop.url)
        {
            match HeaderValue::from_str(&cookie) {
                Ok(v) => {
                    headers.insert(COOKIE, v);
                }
                Err(_) => log::debug!("cookie header for {} is not a valid header value", hop.url),
            }
        }
        headers
    }

    /// HTTP-network-or-cache fetch for one hop.
    async fn fetch_hop(self: &Arc<Self>, hop: &Hop) -> Result<Response, NetError> {
        let mut headers = self.request_headers(hop);

        let mut request_cc = CacheControl::parse(headers.get_all(CACHE_CONTROL).iter().filter_map(|v| v.to_str().ok()));
        if !headers.contains_key(CACHE_CONTROL)
            && headers
                .get_all(PRAGMA)
                .iter()
                .any(|v| v.to_str().is_ok_and(|v| v.to_ascii_lowercase().contains("no-cache")))
        {
            request_cc.no_cache = true;
        }
        let mut mode = hop.cache_mode;
        if mode == CacheMode::Default && (has_conditional_headers(&headers) || request_cc.no_store) {
            mode = CacheMode::NoStore;
        }
        if headers.contains_key(RANGE) {
            mode = CacheMode::NoStore;
        }
        match mode {
            CacheMode::NoCache if !headers.contains_key(CACHE_CONTROL) => {
                headers.insert(CACHE_CONTROL, HeaderValue::from_static("max-age=0"));
            }
            CacheMode::NoStore | CacheMode::Reload => {
                if !headers.contains_key(PRAGMA) {
                    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
                }
                if !headers.contains_key(CACHE_CONTROL) {
                    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                }
            }
            _ => {}
        }
        let cacheable = hop.method == Method::GET && mode != CacheMode::NoStore;

        let mut revalidating: Option<Arc<StoredResponse>> = None;
        if cacheable
            && mode != CacheMode::Reload
            && let Some(stored) = self.cache.lookup(&hop.url, hop.credentials, &headers).await
        {
            let use_stored = match mode {
                CacheMode::ForceCache | CacheMode::OnlyIfCached => true,
                CacheMode::NoCache => false,
                _ => match policy::evaluate(
                    stored.status,
                    &stored.headers,
                    stored.request_time,
                    stored.response_time,
                    &request_cc,
                    SystemTime::now(),
                ) {
                    Freshness::Fresh => true,
                    Freshness::StaleWhileRevalidate => {
                        self.revalidate_in_background(hop, &headers, &stored);
                        true
                    }
                    Freshness::Stale => false,
                },
            };
            if use_stored {
                log::debug!("cache hit {}", hop.url);
                return Ok(cached_response(&stored, &hop.url));
            }
            if !policy::validators(&stored.headers).is_empty() {
                revalidating = Some(stored);
            }
        }
        if mode == CacheMode::OnlyIfCached {
            return Err(NetError::new("ERR_CACHE_MISS", format!("{} is not cached (only-if-cached)", hop.url)));
        }

        let mut network_headers = headers.clone();
        if let Some(stored) = &revalidating {
            for (name, value) in policy::validators(&stored.headers) {
                if let Ok(v) = HeaderValue::from_str(&value) {
                    network_headers.insert(name, v);
                }
            }
        }
        let request_time = SystemTime::now();
        let net = self.network(hop, network_headers).await?;
        let response_time = SystemTime::now();

        if let Some(stored) = revalidating
            && net.status == 304
        {
            log::debug!("revalidated {}", hop.url);
            let updated = self.store_revalidated(hop, &headers, &stored, &net.headers, request_time, response_time);
            return Ok(cached_response(&updated, &hop.url));
        }

        let response_headers = headers_to_vec(&net.headers);
        if !is_safe(&hop.method) && (200..400).contains(&net.status) {
            self.invalidate_after_unsafe(&hop.url, &response_headers);
        }
        if cacheable && net.status != 304 {
            self.maybe_store(hop, &headers, &request_cc, &net, &response_headers, request_time, response_time);
        }
        Ok(Response {
            status: net.status,
            url: hop.url.to_string(),
            headers: response_headers,
            body: net.body,
            from_cache: false,
            http_version: version_str(net.version),
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn maybe_store(
        &self,
        hop: &Hop,
        request_headers: &HeaderMap,
        request_cc: &CacheControl,
        net: &NetResult,
        response_headers: &[(String, String)],
        request_time: SystemTime,
        response_time: SystemTime,
    ) {
        let response_cc = CacheControl::from_headers(response_headers);
        if !policy::is_storable(net.status, request_cc, &response_cc, response_headers) {
            return;
        }
        let Vary::Headers(vary) = Vary::from_headers(response_headers) else { return };
        self.cache.store(
            &hop.url,
            hop.credentials,
            request_headers,
            vary,
            StoredResponse {
                url: String::new(),
                status: net.status,
                http_version: version_str(net.version),
                headers: policy::storable_headers(response_headers.to_vec()),
                vary: Vec::new(),
                request_time,
                response_time,
                body: net.body.clone(),
            },
        );
    }

    /// Merges a 304 into the stored response and stores the result.
    fn store_revalidated(
        &self,
        hop: &Hop,
        request_headers: &HeaderMap,
        stored: &StoredResponse,
        not_modified: &HeaderMap,
        request_time: SystemTime,
        response_time: SystemTime,
    ) -> StoredResponse {
        let mut merged = stored.headers.clone();
        policy::merge_not_modified(&mut merged, &headers_to_vec(not_modified));
        let updated = StoredResponse {
            url: stored.url.clone(),
            status: stored.status,
            http_version: stored.http_version,
            headers: merged,
            vary: Vec::new(),
            request_time,
            response_time,
            body: stored.body.clone(),
        };
        let response_cc = CacheControl::from_headers(&updated.headers);
        match Vary::from_headers(&updated.headers) {
            Vary::Headers(vary) if !response_cc.no_store => {
                self.cache.store(&hop.url, hop.credentials, request_headers, vary, updated.clone());
            }
            _ => self.cache.invalidate(&hop.url),
        }
        updated
    }

    /// RFC 9111 4.4: a successful unsafe request invalidates the target URI and the
    /// same-origin `Location` / `Content-Location` URIs.
    fn invalidate_after_unsafe(&self, url: &Url, response_headers: &[(String, String)]) {
        self.cache.invalidate(url);
        for name in [LOCATION, CONTENT_LOCATION] {
            if let Some(value) = find_header(response_headers, name.as_str())
                && let Ok(target) = url.join(value.trim())
                && target.origin() == url.origin()
            {
                self.cache.invalidate(&target);
            }
        }
    }

    /// Serves a stale response now and revalidates it in the background
    /// (`stale-while-revalidate`). At most one revalidation per resource at a time.
    fn revalidate_in_background(self: &Arc<Self>, hop: &Hop, headers: &HeaderMap, stored: &Arc<StoredResponse>) {
        let key = primary_key(&hop.url, hop.credentials);
        if !self.revalidating.lock().insert(key) {
            return;
        }
        let core = Arc::clone(self);
        let hop = hop.clone();
        let headers = headers.clone();
        let stored = Arc::clone(stored);
        tokio::spawn(async move {
            let mut network_headers = headers.clone();
            for (name, value) in policy::validators(&stored.headers) {
                if let Ok(v) = HeaderValue::from_str(&value) {
                    network_headers.insert(name, v);
                }
            }
            let request_time = SystemTime::now();
            match core.network(&hop, network_headers).await {
                Ok(net) if net.status == 304 => {
                    let response_time = SystemTime::now();
                    core.store_revalidated(&hop, &headers, &stored, &net.headers, request_time, response_time);
                }
                Ok(net) => {
                    let response_time = SystemTime::now();
                    let response_headers = headers_to_vec(&net.headers);
                    let request_cc = CacheControl::default();
                    core.maybe_store(&hop, &headers, &request_cc, &net, &response_headers, request_time, response_time);
                }
                Err(e) => log::debug!("background revalidation of {} failed: {e}", hop.url),
            }
            core.revalidating.lock().remove(&key);
        });
    }

    /// Whether HTTP/3 may be used for `url` (feature, config, no proxy in the way: QUIC
    /// cannot be tunneled through an HTTP proxy, Chrome disables it there as well).
    #[cfg(feature = "http3")]
    fn h3_allowed(&self, url: &Url, host: &str, port: u16) -> bool {
        if !self.config.http3 || url.scheme() != "https" || host.is_empty() {
            return false;
        }
        let authority = if host.contains(':') {
            format!("https://[{host}]:{port}/")
        } else {
            format!("https://{host}:{port}/")
        };
        match authority.parse::<http::Uri>() {
            Ok(uri) => self.proxies.intercept(&uri).is_none(),
            Err(_) => false,
        }
    }

    fn build_request(&self, hop: &Hop, headers: HeaderMap, version: Option<Version>) -> reqwest::RequestBuilder {
        let mut url = hop.url.clone();
        url.set_fragment(None);
        let mut builder = self.client.request(hop.method.clone(), url).headers(headers);
        if let Some(version) = version {
            builder = builder.version(version);
        }
        if let Some(body) = &hop.body {
            builder = builder.body(body.clone());
        }
        builder
    }

    async fn send_tcp(
        &self,
        hop: &Hop,
        headers: HeaderMap,
        origin: &str,
    ) -> Result<(reqwest::Response, Option<OwnedSemaphorePermit>), NetError> {
        let permit = self.limiter.acquire(origin).await;
        let response = self
            .build_request(hop, headers, None)
            .send()
            .await
            .map_err(|e| NetError::from_reqwest(&e))?;
        Ok((response, permit))
    }

    /// Sends the request over TCP or QUIC (see `alt_svc` for the policy) and reads the
    /// response body.
    async fn network(self: &Arc<Self>, hop: &Hop, headers: HeaderMap) -> Result<NetResult, NetError> {
        let (host, port, origin) = origin_parts(&hop.url);
        #[cfg(feature = "http3")]
        let (response, permit) = {
            let plan = if self.h3_allowed(&hop.url, &host, port) {
                self.alt_svc.plan(&host, port, is_safe(&hop.method))
            } else {
                H3Plan::Tcp
            };
            match plan {
                H3Plan::Tcp => self.send_tcp(hop, headers, &origin).await?,
                H3Plan::Direct => self.send_h3_direct(hop, headers, &host, port, &origin).await?,
                H3Plan::Race => self.send_race(hop, headers, &host, port, &origin).await?,
            }
        };
        #[cfg(not(feature = "http3"))]
        let (response, permit) = self.send_tcp(hop, headers, &origin).await?;

        let status = response.status().as_u16();
        let version = response.version();
        let response_headers = response.headers().clone();
        match version {
            Version::HTTP_2 | Version::HTTP_3 => self.limiter.mark_multiplexed(&origin),
            _ => self.limiter.mark_http1(&origin),
        }
        if hop.credentials && self.cookies.store_response(&hop.url, &response_headers) {
            self.cookie_saver.trigger();
        }
        if hop.url.scheme() == "https" {
            let values: Vec<&str> = response_headers
                .get_all(ALT_SVC)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect();
            if !values.is_empty() && self.alt_svc.on_header(&host, port, &values.join(", ")) {
                self.alt_svc_saver.trigger();
            }
        }
        let no_body = hop.method == Method::HEAD || status == 204 || status == 304 || (100..200).contains(&status);
        let body = if no_body {
            Bytes::new()
        } else {
            read_body(response, self.config.read_idle_timeout).await?
        };
        drop(permit);
        log::debug!("{} {} -> {status} ({}, {} bytes)", hop.method, hop.url, version_str(version), body.len());
        Ok(NetResult {
            status,
            version,
            headers: response_headers,
            body,
        })
    }

    #[cfg(feature = "http3")]
    async fn send_h3(&self, hop: &Hop, headers: HeaderMap) -> Result<reqwest::Response, reqwest::Error> {
        self.build_request(hop, headers, Some(Version::HTTP_3)).send().await
    }

    /// HTTP/3 to an origin where QUIC is confirmed; falls back to TCP on failure.
    #[cfg(feature = "http3")]
    async fn send_h3_direct(
        &self,
        hop: &Hop,
        headers: HeaderMap,
        host: &str,
        port: u16,
        origin: &str,
    ) -> Result<(reqwest::Response, Option<OwnedSemaphorePermit>), NetError> {
        match self.send_h3(hop, headers.clone()).await {
            Ok(response) => Ok((response, None)),
            Err(e) => {
                log::debug!("HTTP/3 to {origin} failed ({e}); falling back to TCP");
                self.alt_svc.mark_broken(host, port);
                if is_safe(&hop.method) || e.is_connect() {
                    self.send_tcp(hop, headers, origin).await
                } else {
                    Err(NetError::from_reqwest(&e))
                }
            }
        }
    }

    /// First HTTP/3 attempt for an origin: QUIC gets a head start, then TCP races it.
    /// If TCP wins, the QUIC attempt continues in the background (bounded) to find out
    /// whether HTTP/3 works for the next requests.
    #[cfg(feature = "http3")]
    async fn send_race(
        self: &Arc<Self>,
        hop: &Hop,
        headers: HeaderMap,
        host: &str,
        port: u16,
        origin: &str,
    ) -> Result<(reqwest::Response, Option<OwnedSemaphorePermit>), NetError> {
        let mut h3 = Box::pin(self.build_request(hop, headers.clone(), Some(Version::HTTP_3)).send());
        tokio::select! {
            biased;
            result = &mut h3 => {
                return match result {
                    Ok(response) => {
                        self.alt_svc.mark_confirmed(host, port);
                        Ok((response, None))
                    }
                    Err(e) => {
                        log::debug!("HTTP/3 to {origin} failed ({e}); using TCP");
                        self.alt_svc.mark_broken(host, port);
                        self.send_tcp(hop, headers, origin).await
                    }
                };
            }
            _ = tokio::time::sleep(self.config.h3_head_start) => {}
        }
        let tcp = self.send_tcp(hop, headers, origin);
        tokio::pin!(tcp);
        tokio::select! {
            biased;
            result = &mut h3 => match result {
                Ok(response) => {
                    self.alt_svc.mark_confirmed(host, port);
                    Ok((response, None))
                }
                Err(e) => {
                    log::debug!("HTTP/3 to {origin} failed ({e}); using TCP");
                    self.alt_svc.mark_broken(host, port);
                    tcp.await
                }
            },
            result = &mut tcp => match result {
                Ok(response) => {
                    let core = Arc::clone(self);
                    let host = host.to_owned();
                    let probe_timeout = self.config.h3_probe_timeout;
                    tokio::spawn(async move {
                        match tokio::time::timeout(probe_timeout, h3).await {
                            Ok(Ok(_)) => core.alt_svc.mark_confirmed(&host, port),
                            _ => core.alt_svc.mark_broken(&host, port),
                        }
                    });
                    Ok(response)
                }
                Err(e) => match tokio::time::timeout(self.config.connect_timeout, h3).await {
                    Ok(Ok(response)) => {
                        self.alt_svc.mark_confirmed(host, port);
                        Ok((response, None))
                    }
                    _ => {
                        self.alt_svc.mark_broken(host, port);
                        Err(e)
                    }
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(method: Method, url: &str) -> Hop {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer x"));
        headers.insert("content-type", HeaderValue::from_static("text/plain"));
        Hop {
            url: Url::parse(url).unwrap(),
            method,
            headers,
            body: Some(Bytes::from_static(b"payload")),
            destination: Destination::Document,
            referrer: None,
            credentials: true,
            cache_mode: CacheMode::Default,
        }
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn redirect_method_rewriting() {
        // 302 POST -> GET without body and body headers.
        let h = hop(Method::POST, "https://a.com/form").redirect(302, url("https://a.com/done"));
        assert_eq!(h.method, Method::GET);
        assert!(h.body.is_none());
        assert!(!h.headers.contains_key("content-type"));
        assert!(h.headers.contains_key(AUTHORIZATION), "same origin keeps Authorization");
        // 307/308 keep method and body.
        let h = hop(Method::POST, "https://a.com/form").redirect(307, url("https://a.com/x"));
        assert_eq!(h.method, Method::POST);
        assert_eq!(h.body.as_deref(), Some(&b"payload"[..]));
        // 303 turns PUT into GET, keeps HEAD.
        assert_eq!(hop(Method::PUT, "https://a.com/").redirect(303, url("https://a.com/x")).method, Method::GET);
        assert_eq!(hop(Method::HEAD, "https://a.com/").redirect(303, url("https://a.com/x")).method, Method::HEAD);
        // 301 keeps DELETE (only POST is rewritten).
        assert_eq!(hop(Method::DELETE, "https://a.com/").redirect(301, url("https://a.com/x")).method, Method::DELETE);
        // Cross-origin drops Authorization; fragment inherited unless the target has one.
        let h = hop(Method::GET, "https://a.com/p#top").redirect(301, url("https://b.com/q"));
        assert!(!h.headers.contains_key(AUTHORIZATION));
        assert_eq!(h.url.as_str(), "https://b.com/q#top");
        let h = hop(Method::GET, "https://a.com/p#top").redirect(301, url("https://b.com/q#other"));
        assert_eq!(h.url.fragment(), Some("other"));
    }

    #[test]
    fn method_parsing() {
        assert_eq!(parse_method("get").unwrap(), Method::GET);
        assert_eq!(parse_method("").unwrap(), Method::GET);
        assert_eq!(parse_method("patch").unwrap().as_str(), "patch");
        assert_eq!(parse_method("PROPFIND").unwrap().as_str(), "PROPFIND");
        assert!(parse_method("CONNECT").is_err());
        assert!(parse_method("bad method").is_err());
    }
}
