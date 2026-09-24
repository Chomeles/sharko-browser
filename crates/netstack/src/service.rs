//! The network service: `main` of the `--type=network` process.
//!
//! ```text
//! net-accept thread ──accept()──> per client: reader thread (Connection::split)
//!                                              │ ToNetwork::Fetch → task on the shared runtime
//!                                              │ Abort / GetCookies / SetCookie handled inline
//!                                 per client: writer thread ◄── responses (channel)
//! ```
//!
//! All requests of all clients share one multi-threaded tokio runtime (workers = cores,
//! at least 2) and one [`NetworkCore`] (connection pools, cookies, cache). Replies go
//! through a per-client writer thread so that a slow client can never block a runtime
//! worker.
//!
//! Aborted requests (`ToNetwork::Abort`) are cancelled and produce **no** response
//! (unless the response was already being sent when the abort arrived).
//!
//! Messages are the `common::protocol` types on the wire; this side uses the
//! byte-identical mirrors from `wire.rs` so bodies are (de)serialized with one memcpy.
//!
//! Exit: `Shutdown` from any client persists cookies, Alt-Svc data and the cache index,
//! then exits with code 0. [`run_service`] also exits (after persisting) when the last
//! client has disconnected for 2 seconds, so the process cannot outlive the browser.

use bytes::Bytes;
use common::ipc::{Connection, IpcListener};
use common::protocol::NetRequest;
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::runtime::{Handle, Runtime};
use tokio::task::AbortHandle;

use crate::config::NetConfig;
use crate::core::{NetworkCore, error_response};
use crate::error::NetError;
use crate::util::{Response, status_text};
use crate::websocket::{WsCommand, WsOpen};
use crate::wire::{WireFromNetworkOut, WireResponseOut, WireToNetwork};

const IDLE_GRACE: Duration = Duration::from_secs(2);
const MAX_ACCEPT_FAILURES: u32 = 50;

fn wire_response(id: u64, request_url: &str, result: Result<Response, NetError>, started: Instant) -> WireResponseOut {
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    match result {
        Ok(r) => WireResponseOut {
            id,
            status: r.status,
            status_text: status_text(r.status).to_owned(),
            url: r.url,
            headers: r.headers,
            body: r.body,
            error: None,
            from_cache: r.from_cache,
            http_version: r.http_version.to_owned(),
            duration_ms,
        },
        Err(e) => {
            let r = error_response(id, request_url, &e, duration_ms);
            WireResponseOut {
                id,
                status: r.status,
                status_text: r.status_text,
                url: r.url,
                headers: Vec::new(),
                body: Bytes::new(),
                error: r.error,
                from_cache: false,
                http_version: String::new(),
                duration_ms,
            }
        }
    }
}

enum Event {
    Shutdown,
    ClientGone,
    ListenerFailed,
}

struct Shared {
    core: Arc<NetworkCore>,
    runtime: Handle,
    clients: AtomicUsize,
    events: Sender<Event>,
}

/// Per-connection state.
struct Client {
    /// Request id → (registration generation, task).
    inflight: Mutex<HashMap<u64, (u64, AbortHandle)>>,
    generation: AtomicU64,
    /// WebSocket id → command channel of its task.
    sockets: Mutex<HashMap<u64, tokio::sync::mpsc::UnboundedSender<WsCommand>>>,
    out: Sender<WireFromNetworkOut>,
}

impl Client {
    fn abort_all(&self) {
        for (_, (_, task)) in self.inflight.lock().drain() {
            task.abort();
        }
        // Dropping the command channels makes each socket send a Close frame and end.
        self.sockets.lock().clear();
    }
}

/// A running network service. Created by [`NetworkService::start`]; [`run_service`] is
/// the process-level wrapper.
pub struct NetworkService {
    shared: Arc<Shared>,
    events: Receiver<Event>,
    runtime: Option<Runtime>,
}

impl NetworkService {
    /// Starts serving `listener` on background threads and returns immediately.
    pub fn start(listener: IpcListener, config: NetConfig) -> io::Result<NetworkService> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(config.worker_threads())
            .thread_name("net-worker")
            .enable_all()
            .build()?;
        let core = {
            let _guard = runtime.enter();
            NetworkCore::new(config).map_err(io::Error::other)?
        };
        let (events_tx, events) = crossbeam_channel::unbounded();
        let shared = Arc::new(Shared {
            core,
            runtime: runtime.handle().clone(),
            clients: AtomicUsize::new(0),
            events: events_tx,
        });
        let accept_shared = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("net-accept".into())
            .spawn(move || accept_loop(&listener, &accept_shared))?;
        Ok(NetworkService {
            shared,
            events,
            runtime: Some(runtime),
        })
    }

    /// Blocks until a client sends `Shutdown` (or the listener fails).
    pub fn wait_for_shutdown(&self) {
        self.wait(false);
    }

    /// Persists cookies, Alt-Svc data and the HTTP cache index.
    pub fn persist(&self) {
        self.shared.core.persist();
    }

    /// Number of currently connected clients.
    pub fn client_count(&self) -> usize {
        self.shared.clients.load(Ordering::Acquire)
    }

    /// Returns `true` for a clean exit (shutdown or idle), `false` if the listener failed.
    fn wait(&self, exit_when_idle: bool) -> bool {
        loop {
            match self.events.recv() {
                Ok(Event::Shutdown) => return true,
                Ok(Event::ListenerFailed) | Err(_) => return false,
                Ok(Event::ClientGone) => {
                    if !exit_when_idle || self.client_count() > 0 {
                        continue;
                    }
                    let deadline = Instant::now() + IDLE_GRACE;
                    loop {
                        match self.events.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                            Ok(Event::Shutdown) => return true,
                            Ok(Event::ListenerFailed) => return false,
                            Ok(Event::ClientGone) => continue,
                            Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => return false,
                        }
                    }
                    if self.client_count() == 0 {
                        log::info!("all network clients disconnected; shutting down");
                        return true;
                    }
                }
            }
        }
    }
}

impl Drop for NetworkService {
    fn drop(&mut self) {
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

/// Runs the network service until a client sends `Shutdown` (or all clients are gone),
/// then persists state and exits the process with code 0. Never returns.
pub fn run_service(listener: IpcListener, profile_dir: PathBuf) -> ! {
    run_service_with_config(listener, NetConfig::new(profile_dir))
}

/// [`run_service`] with a custom configuration.
pub fn run_service_with_config(listener: IpcListener, config: NetConfig) -> ! {
    let service = match NetworkService::start(listener, config) {
        Ok(service) => service,
        Err(e) => {
            log::error!("network service failed to start: {e}");
            eprintln!("[network] failed to start: {e}");
            std::process::exit(1);
        }
    };
    let clean = service.wait(true);
    service.persist();
    std::process::exit(if clean { 0 } else { 1 });
}

fn accept_loop(listener: &IpcListener, shared: &Arc<Shared>) {
    let mut failures = 0u32;
    let mut client_no = 0u64;
    loop {
        match listener.accept() {
            Ok(connection) => {
                failures = 0;
                client_no += 1;
                serve_client(shared, connection, client_no);
            }
            Err(e) => {
                failures += 1;
                log::warn!("network service accept failed: {e}");
                if failures >= MAX_ACCEPT_FAILURES {
                    log::error!("network service listener is broken; giving up");
                    let _ = shared.events.send(Event::ListenerFailed);
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

fn serve_client(shared: &Arc<Shared>, connection: Connection, client_no: u64) {
    shared.clients.fetch_add(1, Ordering::AcqRel);
    let (out_tx, out_rx) = crossbeam_channel::unbounded::<WireFromNetworkOut>();
    let client = Arc::new(Client {
        inflight: Mutex::new(HashMap::new()),
        generation: AtomicU64::new(0),
        sockets: Mutex::new(HashMap::new()),
        out: out_tx,
    });
    let reader_shared = Arc::clone(shared);
    let reader_client = Arc::clone(&client);
    drop(client);
    let sender = connection.split::<WireFromNetworkOut, WireToNetwork, _>(&format!("net-client-{client_no}"), move |msg| {
        match msg {
            Some(msg) => handle_message(&reader_shared, &reader_client, msg),
            None => {
                reader_client.abort_all();
                reader_shared.clients.fetch_sub(1, Ordering::AcqRel);
                let _ = reader_shared.events.send(Event::ClientGone);
            }
        }
    });
    let writer = std::thread::Builder::new()
        .name(format!("net-client-{client_no}-writer"))
        .spawn(move || {
            // Ends when the client is gone (all senders dropped) or the pipe breaks.
            for msg in out_rx {
                if let Err(e) = sender.send(&msg) {
                    log::debug!("network client {client_no} write failed: {e}");
                    break;
                }
            }
        });
    if let Err(e) = writer {
        log::error!("cannot spawn writer thread for network client {client_no}: {e}");
    }
}

fn handle_message(shared: &Arc<Shared>, client: &Arc<Client>, msg: WireToNetwork) {
    match msg {
        WireToNetwork::Fetch(req) => {
            let req = NetRequest::from(req);
            let id = req.id;
            let generation = client.generation.fetch_add(1, Ordering::Relaxed);
            let core = Arc::clone(&shared.core);
            let task_client = Arc::clone(client);
            // Registered under the lock before the task can complete and unregister.
            let mut inflight = client.inflight.lock();
            let progress = req.progress.then(|| {
                let out = client.out.clone();
                crate::fetch::Progress(Arc::new(move |loaded, total, upload| {
                    let _ = out.send(WireFromNetworkOut::Progress { id, loaded, total, upload });
                }))
            });
            let task = shared.runtime.spawn(async move {
                let started = Instant::now();
                let url = req.url.clone();
                let result = core.fetch_guarded_with(req, progress).await;
                let response = wire_response(id, &url, result, started);
                let wanted = {
                    let mut inflight = task_client.inflight.lock();
                    match inflight.get(&id) {
                        Some((g, _)) if *g == generation => {
                            inflight.remove(&id);
                            true
                        }
                        _ => false,
                    }
                };
                if wanted {
                    let _ = task_client.out.send(WireFromNetworkOut::Response(response));
                }
            });
            if let Some((_, previous)) = inflight.insert(id, (generation, task.abort_handle())) {
                log::debug!("network client reused request id {id}; cancelling the older request");
                previous.abort();
            }
        }
        WireToNetwork::Abort(id) => {
            if let Some((_, task)) = client.inflight.lock().remove(&id) {
                task.abort();
            }
        }
        WireToNetwork::GetCookies { id, url } => {
            let cookies = shared.core.document_cookie(&url);
            let _ = client.out.send(WireFromNetworkOut::Cookies { id, cookies });
        }
        WireToNetwork::SetCookie { url, cookie } => shared.core.set_script_cookie(&url, &cookie),
        WireToNetwork::Shutdown => {
            let _ = shared.events.send(Event::Shutdown);
        }
        WireToNetwork::WsOpen { id, url, protocols, origin } => {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let core = Arc::clone(&shared.core);
            let task_client = Arc::clone(client);
            let out = client.out.clone();
            // Registered before the task can finish and unregister itself.
            let mut sockets = client.sockets.lock();
            shared.runtime.spawn(async move {
                let open = WsOpen { url, protocols, origin };
                core.websocket(open, rx, move |event| {
                    let _ = out.send(WireFromNetworkOut::Ws { id, event });
                })
                .await;
                task_client.sockets.lock().remove(&id);
            });
            sockets.insert(id, tx);
        }
        WireToNetwork::WsSend { id, data } => {
            if let Some(tx) = client.sockets.lock().get(&id) {
                let _ = tx.send(WsCommand::Send(data));
            }
        }
        WireToNetwork::WsClose { id, code, reason } => {
            if let Some(tx) = client.sockets.lock().get(&id) {
                let _ = tx.send(WsCommand::Close { code, reason });
            }
        }
    }
}
