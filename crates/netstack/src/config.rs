//! Tunables of the network stack.

use std::path::PathBuf;
use std::time::Duration;

/// Configuration of a network stack instance.
///
/// [`NetConfig::new`] returns the production defaults; the fields are public so that
/// embedders and tests can adjust individual knobs.
#[derive(Clone, Debug)]
pub struct NetConfig {
    /// Per-profile directory holding `cookies.json`, `alt-svc.json` and `cache/`.
    /// `None` runs ephemerally (incognito-like): nothing is read from or written to disk.
    pub profile_dir: Option<PathBuf>,
    /// Budget of the in-memory HTTP cache (bytes).
    pub memory_cache_bytes: u64,
    /// Budget of the on-disk HTTP cache (bytes). `0` disables the disk cache.
    pub disk_cache_bytes: u64,
    /// TCP connect + TLS handshake timeout.
    pub connect_timeout: Duration,
    /// Maximum time without receiving any data while waiting for a response or body.
    pub read_idle_timeout: Duration,
    /// `User-Agent` sent when a request does not carry its own.
    pub user_agent: String,
    /// `Accept-Language` sent when a request does not carry its own.
    pub accept_language: String,
    /// `Accept` for [`Destination::Document`](common::protocol::Destination::Document).
    pub document_accept: String,
    /// `Accept` for [`Destination::Image`](common::protocol::Destination::Image).
    /// AVIF is not advertised by default because the image decoder of the engine may not
    /// support it (content-negotiating CDNs would then serve undecodable images).
    pub image_accept: String,
    /// Use HTTP/3 for origins that advertise it via `Alt-Svc` (needs the `http3` feature).
    pub http3: bool,
    /// How long an unconfirmed HTTP/3 attempt runs alone before a TCP (h2/h1.1) request
    /// is raced against it.
    pub h3_head_start: Duration,
    /// How long a losing HTTP/3 attempt may continue in the background to find out
    /// whether QUIC works for the origin (after that it is marked broken).
    pub h3_probe_timeout: Duration,
    /// Concurrent requests per origin until the origin is known to multiplex (h2/h3),
    /// like Chrome's 6-connections-per-host limit for HTTP/1.1.
    pub max_requests_per_host: usize,
    /// Additional trusted root certificates (PEM), merged with the OS trust store.
    pub extra_root_certificates_pem: Vec<Vec<u8>>,
    /// Debounce delay for persisting cookies / alt-svc data / the cache index.
    pub persist_delay: Duration,
    /// Worker threads of the tokio runtime (`None` = number of cores, at least 2).
    pub worker_threads: Option<usize>,
}

impl NetConfig {
    /// Production defaults with state stored under `profile_dir`.
    pub fn new(profile_dir: impl Into<PathBuf>) -> Self {
        Self {
            profile_dir: Some(profile_dir.into()),
            ..Self::ephemeral()
        }
    }

    /// Production defaults without any persistence (memory cache only, session cookies).
    pub fn ephemeral() -> Self {
        Self {
            profile_dir: None,
            memory_cache_bytes: 64 * 1024 * 1024,
            disk_cache_bytes: 512 * 1024 * 1024,
            connect_timeout: Duration::from_secs(15),
            read_idle_timeout: Duration::from_secs(60),
            user_agent: common::USER_AGENT.to_string(),
            accept_language: "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7".to_string(),
            document_accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8".to_string(),
            image_accept: "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8".to_string(),
            http3: cfg!(feature = "http3"),
            h3_head_start: Duration::from_millis(300),
            h3_probe_timeout: Duration::from_secs(10),
            max_requests_per_host: 6,
            extra_root_certificates_pem: Vec::new(),
            persist_delay: Duration::from_secs(2),
            worker_threads: None,
        }
    }

    pub(crate) fn worker_threads(&self) -> usize {
        self.worker_threads.unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(2)
                .max(2)
        })
    }

    pub(crate) fn cookies_path(&self) -> Option<PathBuf> {
        self.profile_dir.as_ref().map(|d| d.join("cookies.json"))
    }

    pub(crate) fn alt_svc_path(&self) -> Option<PathBuf> {
        self.profile_dir.as_ref().map(|d| d.join("alt-svc.json"))
    }

    pub(crate) fn cache_dir(&self) -> Option<PathBuf> {
        if self.disk_cache_bytes == 0 {
            return None;
        }
        self.profile_dir.as_ref().map(|d| d.join("cache"))
    }
}

impl Default for NetConfig {
    fn default() -> Self {
        Self::ephemeral()
    }
}
