//! Network stack of the browser and the `--type=network` service process.
//!
//! # Architecture
//!
//! ```text
//!  browser / renderer process                       network process (or in-process)
//! +---------------------------+   ToNetwork   +---------------------------------------------+
//! | NetClient ----------------+-------------->| service: reader thread per client            |
//! |  (callback thread pool)   |<--------------+   writer thread per client                   |
//! | BlitzNetProvider          |  FromNetwork  | NetworkCore (one multi-threaded tokio rt)    |
//! +---------------------------+               |  schemes   data: file: about:                |
//!                                             |  fetch     redirects, headers, referrer      |
//!                                             |  cache     RFC 9111, memory LRU + disk LRU   |
//!                                             |  cookies   cookie_store + PSL, persisted     |
//!                                             |  alt_svc   HTTP/3 upgrade + fallback         |
//!                                             |  reqwest   hyper h1/h2 + quinn h3, rustls    |
//!                                             +---------------------------------------------+
//! ```
//!
//! * [`NetClient`] is the handle other processes use: [`NetClient::connect`] talks to a
//!   network service over IPC, [`NetClient::in_process`] runs the very same service logic
//!   inside the current process (single-process mode, tests).
//! * [`run_service`] is the `main` of the network process.
//! * [`BlitzNetProvider`] adapts a [`NetClient`] to Blitz' `NetProvider` trait.
//!
//! # Usage
//!
//! ```no_run
//! use netstack::{BlitzNetProvider, Destination, NetClient, NetRequest};
//! use std::sync::Arc;
//!
//! // Network process (`--type=network`): serve an IPC listener until `Shutdown`.
//! # fn network_main(listener: common::ipc::IpcListener, profile: std::path::PathBuf) {
//! netstack::run_service(listener, profile); // never returns
//! # }
//!
//! // Browser / renderer: connect with the endpoint string of that listener.
//! let client = NetClient::connect("net-1234-abcd#0123456789abcdef")?;
//! let id = client.fetch(
//!     NetRequest::get(0, "https://example.com/", Destination::Document),
//!     Box::new(|resp| println!("{} {} ({} bytes)", resp.status, resp.http_version, resp.body.len())),
//! );
//! client.abort(id); // no callback after this
//! let cookies = client.get_cookies_blocking("https://example.com/");
//!
//! // Blitz: resources of a document.
//! let provider = BlitzNetProvider::new(client.clone(), Arc::new(|| { /* wake event loop */ }));
//! # let _ = (cookies, provider);
//! # Ok::<(), std::io::Error>(())
//! ```
//!
//! # Guarantees
//!
//! * Every [`NetClient::fetch`] callback is invoked exactly once, on an internal thread,
//!   unless the request was aborted with [`NetClient::abort`] first, in which case the
//!   callback is dropped without being called.
//! * Response bodies are delivered decoded (gzip, deflate, br, zstd). `Set-Cookie`
//!   headers are never exposed to clients (cookies are handled here, HttpOnly cookies must
//!   not reach renderers).

#[cfg(not(any(feature = "aws-lc", feature = "ring")))]
compile_error!("netstack needs a TLS crypto provider: enable the `aws-lc` (default) or `ring` feature");

mod alt_svc;
mod cache;
mod client;
mod config;
mod cookies;
mod core;
mod error;
mod fetch;
mod headers;
mod provider;
mod schemes;
mod service;
mod util;
mod websocket;
mod wire;

pub use client::{NetClient, ProgressCallback, WsCallback};
pub use config::NetConfig;
pub use provider::{BlitzNetProvider, encode_form_body};
pub use service::{NetworkService, run_service, run_service_with_config};

/// Re-exported protocol types so users of this crate don't need to depend on `common`
/// just to build requests.
pub use common::protocol::{CacheMode, Destination, FromNetwork, NetRequest, NetResponse, ToNetwork, WsData, WsEvent};
