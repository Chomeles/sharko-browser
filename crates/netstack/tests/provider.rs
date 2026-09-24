//! `BlitzNetProvider` against a local server.

mod support;

use blitz_traits::net::{AbortController, Bytes, NetHandler, NetProvider, Request};
use netstack::BlitzNetProvider;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use support::*;
use url::Url;

struct Handler(mpsc::Sender<(String, Bytes)>);

impl NetHandler for Handler {
    fn bytes(self: Box<Self>, resolved_url: String, bytes: Bytes) {
        let _ = self.0.send((resolved_url, bytes));
    }
}

fn provider() -> (BlitzNetProvider, Arc<AtomicUsize>, tempfile::TempDir) {
    let (client, dir) = client();
    let wakes = Arc::new(AtomicUsize::new(0));
    let w = Arc::clone(&wakes);
    let provider = BlitzNetProvider::new(client, Arc::new(move || {
        w.fetch_add(1, Ordering::SeqCst);
    }));
    (provider, wakes, dir)
}

#[test]
fn delivers_bytes_with_final_url_and_wakes() {
    let server = TestServer::start();
    let (provider, wakes, _dir) = provider();
    let (tx, rx) = mpsc::channel();
    provider.fetch(1, Request::get(Url::parse(&server.url("/redirect/2")).unwrap()), Box::new(Handler(tx)));
    let (url, bytes) = rx.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(url, server.url("/redirect/0"));
    assert_eq!(&bytes[..], b"done");
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(wakes.load(Ordering::SeqCst), 1);

    let (tx, rx) = mpsc::channel();
    provider.fetch(1, Request::get(Url::parse("data:text/css,a{color:red}").unwrap()), Box::new(Handler(tx)));
    assert_eq!(&rx.recv_timeout(TIMEOUT).unwrap().1[..], b"a{color:red}");
}

#[test]
fn failures_deliver_empty_body_or_drop() {
    let server = TestServer::start();
    let (provider, wakes, _dir) = provider();
    let (tx, rx) = mpsc::channel();
    provider.fetch(1, Request::get(Url::parse(&server.url("/status/404")).unwrap()), Box::new(Handler(tx)));
    let (url, bytes) = rx.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(url, server.url("/status/404"));
    assert!(bytes.is_empty(), "error bodies are never delivered as resources");
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(wakes.load(Ordering::SeqCst), 1);

    let (client, _dir2) = client();
    let dropping = BlitzNetProvider::new(client, Arc::new(|| {})).drop_handler_on_error();
    let (tx, rx) = mpsc::channel();
    dropping.fetch(1, Request::get(Url::parse(&server.url("/status/500")).unwrap()), Box::new(Handler(tx)));
    // The handler (and with it the sender) is dropped without a call.
    assert!(matches!(rx.recv_timeout(TIMEOUT), Err(mpsc::RecvTimeoutError::Disconnected)));
}

#[test]
fn abort_signal_cancels_request() {
    let server = TestServer::start();
    let (provider, _wakes, _dir) = provider();
    let controller = AbortController::default();
    let (tx, rx) = mpsc::channel();
    let request = Request::get(Url::parse(&server.url("/slow")).unwrap()).signal(controller.signal.clone());
    provider.fetch(1, request, Box::new(Handler(tx)));
    std::thread::sleep(Duration::from_millis(150));
    controller.abort();
    // The watcher aborts the request; the handler is dropped without being called.
    assert!(matches!(rx.recv_timeout(Duration::from_secs(5)), Err(mpsc::RecvTimeoutError::Disconnected)));
    assert_eq!(server.hits("/slow"), 1);
}
