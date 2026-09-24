//! [`NetworkCore`]: the state shared by all requests of one network stack instance
//! (HTTP client with its connection pools, cookie jar, HTTP cache, Alt-Svc cache) and the
//! scheme dispatch. The HTTP(S) pipeline itself lives in `fetch.rs`.

use common::protocol::{NetRequest, NetResponse};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::runtime::Handle;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

use crate::alt_svc::AltSvcCache;
use crate::cache::HttpCache;
use crate::config::NetConfig;
use crate::cookies::CookieJar;
use crate::error::NetError;
use crate::schemes;
use crate::util::{Response, status_text};

/// How often the cache index is persisted when it changed.
const CACHE_INDEX_SAVE_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) struct NetworkCore {
    pub(crate) config: NetConfig,
    pub(crate) client: reqwest::Client,
    pub(crate) cookies: Arc<CookieJar>,
    pub(crate) cache: Arc<HttpCache>,
    pub(crate) alt_svc: Arc<AltSvcCache>,
    pub(crate) limiter: HostLimiter,
    /// System/env proxy rules: QUIC can't be tunneled, so proxied origins never use h3.
    #[cfg_attr(not(feature = "http3"), allow(dead_code))]
    pub(crate) proxies: hyper_util::client::proxy::matcher::Matcher,
    pub(crate) cookie_saver: Debouncer,
    pub(crate) alt_svc_saver: Debouncer,
    /// Primary cache keys with a background (stale-while-revalidate) revalidation.
    pub(crate) revalidating: Mutex<HashSet<u128>>,
}

impl NetworkCore {
    /// Creates the core. Must be called inside the tokio runtime that will drive it
    /// (the QUIC endpoint binds to the current runtime).
    pub(crate) fn new(config: NetConfig) -> Result<Arc<Self>, String> {
        let rt = Handle::try_current().map_err(|e| format!("no tokio runtime: {e}"))?;
        if let Some(dir) = &config.profile_dir
            && let Err(e) = std::fs::create_dir_all(dir)
        {
            log::warn!("cannot create profile directory {}: {e}", dir.display());
        }
        let client = build_client(&config)?;
        let cookies = Arc::new(CookieJar::open(config.cookies_path()));
        let alt_svc = Arc::new(AltSvcCache::open(config.alt_svc_path(), config.http3));
        let cache = Arc::new(HttpCache::open(
            config.cache_dir(),
            config.memory_cache_bytes,
            config.disk_cache_bytes,
        ));
        let cookie_saver = {
            let jar = Arc::clone(&cookies);
            Debouncer::new(rt.clone(), config.persist_delay, move || {
                if let Err(e) = jar.save() {
                    log::warn!("saving cookies failed: {e}");
                }
            })
        };
        let alt_svc_saver = {
            let alt = Arc::clone(&alt_svc);
            Debouncer::new(rt.clone(), config.persist_delay, move || {
                if let Err(e) = alt.save() {
                    log::warn!("saving alt-svc data failed: {e}");
                }
            })
        };
        {
            // Periodic cache index persistence (crash resilience).
            let cache = Arc::downgrade(&cache);
            rt.spawn(async move {
                loop {
                    tokio::time::sleep(CACHE_INDEX_SAVE_INTERVAL).await;
                    let Some(cache) = cache.upgrade() else { break };
                    if cache.is_dirty() {
                        // Snapshot + serialization of a large index is CPU work: keep it
                        // off the async workers.
                        let _ = tokio::task::spawn_blocking(move || cache.save_index()).await;
                    }
                }
            });
        }
        Ok(Arc::new(Self {
            limiter: HostLimiter::new(config.max_requests_per_host),
            proxies: hyper_util::client::proxy::matcher::Matcher::from_system(),
            config,
            client,
            cookies,
            cache,
            alt_svc,
            cookie_saver,
            alt_svc_saver,
            revalidating: Mutex::new(HashSet::new()),
        }))
    }

    /// Fetches any supported URL.
    pub(crate) async fn fetch(self: &Arc<Self>, req: NetRequest) -> Result<Response, NetError> {
        let url = Url::parse(req.url.trim())
            .map_err(|e| NetError::invalid_url(format!("`{}`: {e}", req.url)))?;
        match url.scheme() {
            "http" | "https" => self.http_fetch(req, url).await,
            "data" => schemes::data(&url),
            "file" => schemes::file(url, req.method.eq_ignore_ascii_case("HEAD")).await,
            "about" => schemes::about(&url),
            other => Err(NetError::unknown_scheme(other)),
        }
    }

    /// [`fetch`](Self::fetch) that turns a panic (a bug) into an error response, so that
    /// every request is answered exactly once no matter what.
    pub(crate) async fn fetch_guarded(self: &Arc<Self>, req: NetRequest) -> Result<Response, NetError> {
        use futures_util::FutureExt;
        let url = req.url.clone();
        match std::panic::AssertUnwindSafe(self.fetch(req)).catch_unwind().await {
            Ok(result) => result,
            Err(_) => {
                log::error!("internal error (panic) while fetching {url}");
                Err(NetError::new("ERR_FAILED", "internal error in the network stack"))
            }
        }
    }

    /// `document.cookie` for a page URL.
    pub(crate) fn document_cookie(&self, url: &str) -> String {
        Url::parse(url)
            .map(|u| self.cookies.document_cookie(&u))
            .unwrap_or_default()
    }

    /// `document.cookie = cookie`.
    pub(crate) fn set_script_cookie(&self, url: &str, cookie: &str) {
        if let Ok(u) = Url::parse(url)
            && self.cookies.set_from_script(&u, cookie)
        {
            self.cookie_saver.trigger();
        }
    }

    /// Persists cookies, Alt-Svc data and the cache index (blocking; shutdown path).
    pub(crate) fn persist(&self) {
        if let Err(e) = self.cookies.save() {
            log::warn!("saving cookies failed: {e}");
        }
        if let Err(e) = self.alt_svc.save() {
            log::warn!("saving alt-svc data failed: {e}");
        }
        self.cache.persist_blocking(Duration::from_secs(3));
    }
}

fn build_client(config: &NetConfig) -> Result<reqwest::Client, String> {
    #[cfg(all(feature = "ring", not(feature = "aws-lc")))]
    {
        // reqwest's `rustls-no-provider` uses the process-wide default provider.
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut builder = reqwest::Client::builder()
        .user_agent(config.user_agent.clone())
        // Redirects, cookies and Referer are handled by the fetch layer (per hop).
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(config.connect_timeout)
        .read_timeout(config.read_idle_timeout)
        .tcp_nodelay(true)
        .pool_idle_timeout(Duration::from_secs(90))
        // Chrome's HTTP/2 flow-control windows: full speed from the first byte on
        // high bandwidth-delay links, no slow window ramp-up.
        .http2_initial_stream_window_size(6 * 1024 * 1024)
        .http2_initial_connection_window_size(15 * 1024 * 1024)
        .gzip(true)
        .deflate(true)
        .brotli(true)
        .zstd(true);
    #[cfg(feature = "http3")]
    {
        builder = builder.http3_max_idle_timeout(Duration::from_secs(30));
        // reqwest binds its QUIC socket to `[::]:0` (dual-stack). On hosts without IPv6
        // support that fails and HTTP/3 would silently be unavailable; bind to the IPv4
        // wildcard instead. (For TCP this only binds IPv4 sockets to 0.0.0.0 before
        // connecting, which is a no-op, and IPv6 is unusable on such hosts anyway.)
        if config.http3 && std::net::UdpSocket::bind((std::net::Ipv6Addr::UNSPECIFIED, 0)).is_err() {
            log::info!("IPv6 unavailable; binding the QUIC endpoint to 0.0.0.0");
            builder = builder.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        }
    }
    if !config.extra_root_certificates_pem.is_empty() {
        let mut certs = Vec::new();
        for pem in &config.extra_root_certificates_pem {
            certs.extend(
                reqwest::Certificate::from_pem_bundle(pem)
                    .map_err(|e| format!("invalid extra root certificate: {e}"))?,
            );
        }
        builder = builder.tls_certs_merge(certs);
    }
    builder
        .build()
        .map_err(|e| format!("cannot initialize HTTP client: {e}"))
}

/// Converts a fetch result into the protocol response.
pub(crate) fn net_response(
    id: u64,
    request_url: &str,
    result: Result<Response, NetError>,
    started: Instant,
) -> NetResponse {
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(r) => NetResponse {
            id,
            status: r.status,
            status_text: status_text(r.status).to_owned(),
            url: r.url,
            headers: r.headers,
            body: Vec::from(r.body),
            error: None,
            from_cache: r.from_cache,
            http_version: r.http_version.to_owned(),
            duration_ms,
        },
        Err(e) => error_response(id, request_url, &e, duration_ms),
    }
}

/// Network errors have status 0; an `only-if-cached` miss is reported like a gateway
/// timeout (504), as RFC 9111 5.2.1.7 suggests.
pub(crate) fn error_response(id: u64, request_url: &str, e: &NetError, duration_ms: f64) -> NetResponse {
    let status = if e.code() == "ERR_CACHE_MISS" { 504 } else { 0 };
    NetResponse {
        id,
        status,
        status_text: status_text(status).to_owned(),
        url: request_url.to_owned(),
        error: Some(e.to_string()),
        duration_ms,
        ..Default::default()
    }
}

/// Runs a (blocking) job at most once per `delay`, on the blocking pool.
pub(crate) struct Debouncer {
    pending: Arc<AtomicBool>,
    delay: Duration,
    rt: Handle,
    job: Arc<dyn Fn() + Send + Sync>,
}

impl Debouncer {
    pub(crate) fn new(rt: Handle, delay: Duration, job: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            pending: Arc::new(AtomicBool::new(false)),
            delay,
            rt,
            job: Arc::new(job),
        }
    }

    /// Schedules the job unless it is already scheduled.
    pub(crate) fn trigger(&self) {
        if self.pending.swap(true, Ordering::AcqRel) {
            return;
        }
        let pending = Arc::clone(&self.pending);
        let job = Arc::clone(&self.job);
        let delay = self.delay;
        self.rt.spawn(async move {
            tokio::time::sleep(delay).await;
            // Cleared before running: changes made while saving schedule another save.
            pending.store(false, Ordering::Release);
            if let Err(e) = tokio::task::spawn_blocking(move || job()).await {
                log::warn!("persistence job failed: {e}");
            }
        });
    }
}

struct HostSlot {
    semaphore: Arc<Semaphore>,
}

/// Chrome-style limit of concurrent requests per origin (6) until the origin is known to
/// multiplex (HTTP/2 or HTTP/3). This also stops a burst of requests to a fresh h2
/// origin from opening one TLS connection per request before ALPN has been seen.
pub(crate) struct HostLimiter {
    per_host: usize,
    slots: Mutex<HashMap<String, HostSlot>>,
}

impl HostLimiter {
    fn new(per_host: usize) -> Self {
        Self {
            per_host: per_host.max(1),
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// Waits for a slot. `None` means "unlimited" (multiplexing origin).
    pub(crate) async fn acquire(&self, origin: &str) -> Option<OwnedSemaphorePermit> {
        let semaphore = {
            let mut slots = self.slots.lock();
            let slot = slots.entry(origin.to_owned()).or_insert_with(|| HostSlot {
                semaphore: Arc::new(Semaphore::new(self.per_host)),
            });
            Arc::clone(&slot.semaphore)
        };
        // A closed semaphore means the origin multiplexes: no permit needed.
        semaphore.acquire_owned().await.ok()
    }

    /// The origin answered with HTTP/2 or HTTP/3: lift the limit (releases waiters).
    pub(crate) fn mark_multiplexed(&self, origin: &str) {
        if let Some(slot) = self.slots.lock().get(origin) {
            slot.semaphore.close();
        }
    }

    /// The origin answered with HTTP/1.x: (re-)establish the limit.
    pub(crate) fn mark_http1(&self, origin: &str) {
        let mut slots = self.slots.lock();
        if let Some(slot) = slots.get_mut(origin)
            && slot.semaphore.is_closed()
        {
            slot.semaphore = Arc::new(Semaphore::new(self.per_host));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_limiter() {
        let limiter = Arc::new(HostLimiter::new(2));
        let a = limiter.acquire("https://a:443").await;
        let b = limiter.acquire("https://a:443").await;
        assert!(a.is_some() && b.is_some());
        // Third request waits...
        let l2 = Arc::clone(&limiter);
        let waiter = tokio::spawn(async move { l2.acquire("https://a:443").await.is_none() });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        // ...until the origin turns out to multiplex.
        limiter.mark_multiplexed("https://a:443");
        assert!(waiter.await.unwrap());
        assert!(limiter.acquire("https://a:443").await.is_none());
        limiter.mark_http1("https://a:443");
        assert!(limiter.acquire("https://a:443").await.is_some());
        // Other origins are independent.
        assert!(limiter.acquire("https://b:443").await.is_some());
    }

    #[test]
    fn only_if_cached_miss_is_504() {
        let e = NetError::new("ERR_CACHE_MISS", "x");
        let r = error_response(1, "https://a/", &e, 0.0);
        assert_eq!(r.status, 504);
        assert_eq!(r.status_text, "Gateway Timeout");
        assert!(r.error.is_some());
        let r = error_response(1, "https://a/", &NetError::new("ERR_FAILED", ""), 0.0);
        assert_eq!(r.status, 0);
    }
}
