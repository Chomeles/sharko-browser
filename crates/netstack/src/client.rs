//! [`NetClient`]: how other processes (and the browser in single-process mode) use the
//! network stack.
//!
//! Two backends with identical behaviour:
//!
//! * **IPC** ([`NetClient::connect`]): requests are sent to the network service; one
//!   reader thread routes replies back to their callbacks.
//! * **In-process** ([`NetClient::in_process`]): the same service logic runs on a tokio
//!   runtime owned by the client.
//!
//! Callbacks run on a small pool of `net-callback-*` threads, never on the IPC reader
//! thread or a tokio worker: resource handlers (image decoding, CSS parsing, ...) may be
//! CPU-heavy and must not stall networking.

use common::ipc::{self, IpcSender};
use common::protocol::{NetRequest, NetResponse};
use crossbeam_channel::Sender;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;
use tokio::task::AbortHandle;

use crate::config::NetConfig;
use crate::core::{NetworkCore, error_response, net_response};
use crate::error::NetError;
use crate::wire::{WireFromNetworkIn, WireRequest, WireToNetwork};

/// Completion callback of [`NetClient::fetch`].
pub(crate) type FetchCallback = Box<dyn FnOnce(NetResponse) + Send>;

const COOKIE_TIMEOUT: Duration = Duration::from_secs(2);

type Job = Box<dyn FnOnce() + Send>;

/// Threads that run user callbacks.
#[derive(Clone)]
struct CallbackPool {
    tx: Option<Sender<Job>>,
}

impl CallbackPool {
    fn new() -> Self {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2)
            .clamp(2, 4);
        let (tx, rx) = crossbeam_channel::unbounded::<Job>();
        let mut started = 0;
        for i in 0..threads {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("net-callback-{i}"))
                .spawn(move || {
                    for job in rx {
                        if catch_unwind(AssertUnwindSafe(job)).is_err() {
                            log::error!("a network callback panicked");
                        }
                    }
                });
            match spawned {
                Ok(_) => started += 1,
                Err(e) => log::error!("cannot spawn network callback thread: {e}"),
            }
        }
        Self {
            tx: (started > 0).then_some(tx),
        }
    }

    fn run(&self, job: impl FnOnce() + Send + 'static) {
        match &self.tx {
            Some(tx) => {
                if let Err(crossbeam_channel::SendError(job)) = tx.send(Box::new(job)) {
                    job();
                }
            }
            // No threads could be started: run inline rather than never.
            None => job(),
        }
    }
}

/// A cheap-to-clone, thread-safe handle to a network stack.
#[derive(Clone)]
pub struct NetClient {
    inner: Arc<Inner>,
}

struct Inner {
    next_id: AtomicU64,
    callbacks: CallbackPool,
    backend: Backend,
}

enum Backend {
    Ipc(IpcBackend),
    InProcess(InProcessBackend),
    /// The in-process stack could not be created; every request fails with this error.
    Failed(String),
}

struct IpcBackend {
    sender: IpcSender<WireToNetwork>,
    shared: Arc<IpcShared>,
}

struct IpcShared {
    pending: Mutex<HashMap<u64, FetchCallback>>,
    cookie_waiters: Mutex<HashMap<u64, Sender<String>>>,
    connected: AtomicBool,
    callbacks: CallbackPool,
}

impl IpcShared {
    fn on_message(&self, msg: Option<WireFromNetworkIn>) {
        match msg {
            Some(WireFromNetworkIn::Response(response)) => {
                let response = NetResponse::from(response);
                if let Some(callback) = self.pending.lock().remove(&response.id) {
                    self.callbacks.run(move || callback(response));
                }
            }
            Some(WireFromNetworkIn::Cookies { id, cookies }) => {
                if let Some(waiter) = self.cookie_waiters.lock().remove(&id) {
                    let _ = waiter.send(cookies);
                }
            }
            None => {
                self.connected.store(false, Ordering::Release);
                self.cookie_waiters.lock().clear();
                let pending: Vec<_> = self.pending.lock().drain().collect();
                if !pending.is_empty() {
                    log::warn!("network service disconnected with {} requests in flight", pending.len());
                }
                for (id, callback) in pending {
                    let response = disconnected_response(id);
                    self.callbacks.run(move || callback(response));
                }
            }
        }
    }
}

fn disconnected_response(id: u64) -> NetResponse {
    error_response(
        id,
        "",
        &NetError::new("ERR_FAILED", "network service disconnected"),
        0.0,
    )
}

struct InProcessBackend {
    runtime: Option<Runtime>,
    core: Arc<NetworkCore>,
    inflight: Arc<Mutex<HashMap<u64, AbortHandle>>>,
}

impl Drop for InProcessBackend {
    fn drop(&mut self) {
        self.core.persist();
        if let Some(runtime) = self.runtime.take() {
            // Never blocks, so dropping a client inside async code is fine.
            runtime.shutdown_background();
        }
    }
}

impl NetClient {
    /// Connects to a network service at `endpoint` (see
    /// [`IpcListener::endpoint`](common::ipc::IpcListener::endpoint)).
    ///
    /// The connection stays open until the process exits.
    pub fn connect(endpoint: &str) -> io::Result<NetClient> {
        let connection = ipc::connect(endpoint)?;
        let callbacks = CallbackPool::new();
        let shared = Arc::new(IpcShared {
            pending: Mutex::new(HashMap::new()),
            cookie_waiters: Mutex::new(HashMap::new()),
            connected: AtomicBool::new(true),
            callbacks: callbacks.clone(),
        });
        let reader_shared = Arc::clone(&shared);
        let sender = connection.split::<WireToNetwork, WireFromNetworkIn, _>("net-client-reader", move |msg| {
            reader_shared.on_message(msg)
        });
        Ok(Self::new(callbacks, Backend::Ipc(IpcBackend { sender, shared })))
    }

    /// Like [`connect`](Self::connect), but returns immediately: the connection is made
    /// on a background thread (retrying while the service starts, up to `timeout`) and
    /// requests issued meanwhile are queued. Used at startup so that launching the network
    /// process never blocks the UI.
    pub fn connect_in_background(endpoint: &str, timeout: Duration) -> NetClient {
        let callbacks = CallbackPool::new();
        let shared = Arc::new(IpcShared {
            pending: Mutex::new(HashMap::new()),
            cookie_waiters: Mutex::new(HashMap::new()),
            connected: AtomicBool::new(true),
            callbacks: callbacks.clone(),
        });
        let reader_shared = Arc::clone(&shared);
        let sender = ipc::connect_in_background::<WireToNetwork, WireFromNetworkIn, _>(
            endpoint,
            timeout,
            "net-client-reader",
            move |msg| reader_shared.on_message(msg),
        );
        Self::new(callbacks, Backend::Ipc(IpcBackend { sender, shared }))
    }

    /// Runs the network stack inside this process with state under `profile_dir`
    /// (single-process mode, tests). Same API and behaviour as [`connect`](Self::connect).
    pub fn in_process(profile_dir: PathBuf) -> NetClient {
        Self::in_process_with_config(NetConfig::new(profile_dir))
    }

    /// Like [`in_process`](Self::in_process) with a custom configuration.
    pub fn in_process_with_config(config: NetConfig) -> NetClient {
        let callbacks = CallbackPool::new();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(config.worker_threads())
            .thread_name("net-worker")
            .enable_all()
            .build();
        let backend = match runtime {
            Err(e) => Backend::Failed(format!("cannot start network runtime: {e}")),
            Ok(runtime) => {
                let core = {
                    let _guard = runtime.enter();
                    NetworkCore::new(config)
                };
                match core {
                    Ok(core) => Backend::InProcess(InProcessBackend {
                        runtime: Some(runtime),
                        core,
                        inflight: Arc::new(Mutex::new(HashMap::new())),
                    }),
                    Err(e) => {
                        runtime.shutdown_background();
                        Backend::Failed(e)
                    }
                }
            }
        };
        if let Backend::Failed(e) = &backend {
            log::error!("in-process network stack unavailable: {e}");
        }
        Self::new(callbacks, backend)
    }

    fn new(callbacks: CallbackPool, backend: Backend) -> Self {
        Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                callbacks,
                backend,
            }),
        }
    }

    fn next_id(&self) -> u64 {
        self.inner.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Starts a request. `req.id` is overwritten with a fresh id, which is returned.
    ///
    /// `on_done` is called exactly once on an internal thread — with an error response
    /// (status 0, `error` set) on failure — unless the request is aborted first.
    pub fn fetch(&self, mut req: NetRequest, on_done: Box<dyn FnOnce(NetResponse) + Send>) -> u64 {
        let id = self.next_id();
        req.id = id;
        match &self.inner.backend {
            Backend::Ipc(ipc) => {
                if !ipc.shared.connected.load(Ordering::Acquire) {
                    let response = disconnected_response(id);
                    self.inner.callbacks.run(move || on_done(response));
                    return id;
                }
                ipc.shared.pending.lock().insert(id, on_done);
                let sent = ipc.sender.send(&WireToNetwork::Fetch(WireRequest::from(req)));
                if let Err(e) = &sent {
                    log::warn!("cannot send request to the network service: {e}");
                }
                // Also covers a disconnect that raced with the registration above (the
                // reader thread fails pending callbacks only once).
                if (sent.is_err() || !ipc.shared.connected.load(Ordering::Acquire))
                    && let Some(callback) = ipc.shared.pending.lock().remove(&id)
                {
                    let response = disconnected_response(id);
                    self.inner.callbacks.run(move || callback(response));
                }
            }
            Backend::InProcess(local) => {
                let core = Arc::clone(&local.core);
                let inflight = Arc::clone(&local.inflight);
                let callbacks = self.inner.callbacks.clone();
                let Some(runtime) = &local.runtime else { return id };
                // Hold the lock while spawning so that the task cannot finish (and try to
                // unregister itself) before it is registered.
                let mut guard = local.inflight.lock();
                let task = runtime.spawn(async move {
                    let started = Instant::now();
                    let url = req.url.clone();
                    let result = core.fetch_guarded(req).await;
                    let response = net_response(id, &url, result, started);
                    // Not registered anymore = aborted: drop the callback silently.
                    if inflight.lock().remove(&id).is_some() {
                        callbacks.run(move || on_done(response));
                    }
                });
                guard.insert(id, task.abort_handle());
            }
            Backend::Failed(error) => {
                let response = error_response(id, &req.url, &NetError::new("ERR_FAILED", error.clone()), 0.0);
                self.inner.callbacks.run(move || on_done(response));
            }
        }
        id
    }

    /// Cancels an in-flight request. Its callback is dropped without being called (unless
    /// it is already running) and the service sends no response for it.
    pub fn abort(&self, id: u64) {
        match &self.inner.backend {
            Backend::Ipc(ipc) => {
                if ipc.shared.pending.lock().remove(&id).is_some() {
                    let _ = ipc.sender.send(&WireToNetwork::Abort(id));
                }
            }
            Backend::InProcess(local) => {
                if let Some(task) = local.inflight.lock().remove(&id) {
                    task.abort();
                }
            }
            Backend::Failed(_) => {}
        }
    }

    /// The `document.cookie` string for `url` (no HttpOnly cookies). Waits at most 2 s
    /// for the network service; returns `""` on timeout or error.
    pub fn get_cookies_blocking(&self, url: &str) -> String {
        match &self.inner.backend {
            Backend::Ipc(ipc) => {
                if !ipc.shared.connected.load(Ordering::Acquire) {
                    return String::new();
                }
                let id = self.next_id();
                let (tx, rx) = crossbeam_channel::bounded(1);
                ipc.shared.cookie_waiters.lock().insert(id, tx);
                let message = WireToNetwork::GetCookies { id, url: url.to_owned() };
                if ipc.sender.send(&message).is_err() {
                    ipc.shared.cookie_waiters.lock().remove(&id);
                    return String::new();
                }
                match rx.recv_timeout(COOKIE_TIMEOUT) {
                    Ok(cookies) => cookies,
                    Err(_) => {
                        ipc.shared.cookie_waiters.lock().remove(&id);
                        String::new()
                    }
                }
            }
            Backend::InProcess(local) => local.core.document_cookie(url),
            Backend::Failed(_) => String::new(),
        }
    }

    /// `document.cookie = cookie` for a page at `url`. HttpOnly cookies are rejected.
    pub fn set_cookie(&self, url: &str, cookie: &str) {
        match &self.inner.backend {
            Backend::Ipc(ipc) => {
                let message = WireToNetwork::SetCookie {
                    url: url.to_owned(),
                    cookie: cookie.to_owned(),
                };
                if let Err(e) = ipc.sender.send(&message) {
                    log::warn!("cannot send cookie to the network service: {e}");
                }
            }
            Backend::InProcess(local) => local.core.set_script_cookie(url, cookie),
            Backend::Failed(_) => {}
        }
    }

    /// Asks the network service to persist its state and exit.
    ///
    /// In-process mode persists cookies, Alt-Svc data and the cache index but keeps
    /// running (it must not exit the embedding process).
    pub fn shutdown_service(&self) {
        match &self.inner.backend {
            Backend::Ipc(ipc) => {
                if let Err(e) = ipc.sender.send(&WireToNetwork::Shutdown) {
                    log::warn!("cannot send shutdown to the network service: {e}");
                }
            }
            Backend::InProcess(local) => local.core.persist(),
            Backend::Failed(_) => {}
        }
    }
}

impl std::fmt::Debug for NetClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match &self.inner.backend {
            Backend::Ipc(_) => "ipc",
            Backend::InProcess(_) => "in-process",
            Backend::Failed(_) => "failed",
        };
        f.debug_struct("NetClient").field("backend", &kind).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send_sync<T: Send + Sync>() {}

    #[test]
    fn client_is_send_sync() {
        assert_send_sync::<NetClient>();
    }

    #[test]
    fn callback_pool_survives_panics() {
        let pool = CallbackPool::new();
        pool.run(|| panic!("boom"));
        let (tx, rx) = crossbeam_channel::bounded(1);
        pool.run(move || tx.send(42).unwrap());
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), 42);
    }
}
