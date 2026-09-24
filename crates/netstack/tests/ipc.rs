//! The network service over real IPC: `run_service` in a thread, `NetClient::connect`.

mod support;

use common::ipc::IpcListener;
use netstack::{Destination, NetClient, NetConfig, NetRequest, NetworkService};
use std::sync::mpsc;
use std::time::Duration;
use support::*;

/// Starts `run_service` (which never returns) on a background thread.
fn spawn_run_service() -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let listener = IpcListener::new("netstack-test").unwrap();
    let endpoint = listener.endpoint();
    let profile = dir.path().to_path_buf();
    std::thread::spawn(move || netstack::run_service(listener, profile));
    (endpoint, dir)
}

#[test]
fn run_service_end_to_end() {
    let server = TestServer::start();
    let (endpoint, _dir) = spawn_run_service();
    let client = NetClient::connect(&endpoint).expect("connect to network service");

    let r = get(&client, &server.url("/hello"));
    assert_eq!((r.status, body_str(&r).as_str()), (200, "hello world"), "{:?}", r.error);
    assert_eq!(r.http_version, "HTTP/1.1");
    assert!(r.id > 0);

    let r = get(&client, "data:text/plain,over%20ipc");
    assert_eq!(body_str(&r), "over ipc");

    // Cache hits over IPC.
    assert!(!get(&client, &server.url("/max-age")).from_cache);
    assert!(get(&client, &server.url("/max-age")).from_cache);

    // Cookies: GetCookies/SetCookie round trips.
    get(&client, &server.url("/set-cookie"));
    let page = server.url("/");
    assert_eq!(client.get_cookies_blocking(&page), "visible=1");
    client.set_cookie(&page, "ipc=1");
    assert_eq!(client.get_cookies_blocking(&page), "visible=1; ipc=1");

    // 10 MiB body through the IPC frame.
    let r = get(&client, &server.url("/big"));
    assert_eq!(r.body.len(), 10 * 1024 * 1024);
    assert!(r.body == big_body());

    // Abort: no response is delivered.
    let (tx, rx) = mpsc::channel();
    let id = client.fetch(
        NetRequest::get(0, server.url("/slow"), Destination::Other),
        Box::new(move |r| {
            let _ = tx.send(r);
        }),
    );
    std::thread::sleep(Duration::from_millis(200));
    client.abort(id);
    assert!(rx.recv_timeout(Duration::from_secs(4)).is_err());

    // 50 concurrent requests from two clients with overlapping ids.
    let second = NetClient::connect(&endpoint).expect("second client");
    let (tx, rx) = mpsc::channel();
    for i in 0..50 {
        let c = if i % 2 == 0 { &client } else { &second };
        let tx = tx.clone();
        c.fetch(
            NetRequest::get(0, server.url(&format!("/hello?n={i}")), Destination::Fetch),
            Box::new(move |r| {
                let _ = tx.send(r.status);
            }),
        );
    }
    for _ in 0..50 {
        assert_eq!(rx.recv_timeout(TIMEOUT).unwrap(), 200);
    }
}

#[test]
fn shutdown_persists_state() {
    let server = TestServer::start();
    let dir = tempfile::tempdir().unwrap();
    let listener = IpcListener::new("netstack-shutdown").unwrap();
    let endpoint = listener.endpoint();
    let service = NetworkService::start(listener, NetConfig::new(dir.path())).unwrap();
    let client = NetClient::connect(&endpoint).unwrap();
    let mut req = NetRequest::get(0, server.url("/max-age"), Destination::Other);
    req.credentials = true;
    assert_eq!(fetch(&client, req).status, 200);
    client.set_cookie(&server.url("/"), "persist=1; Max-Age=3600");
    client.shutdown_service();
    service.wait_for_shutdown();
    service.persist();
    let cookies = std::fs::read_to_string(dir.path().join("cookies.json")).unwrap();
    assert!(cookies.contains("persist=1"), "{cookies}");
    assert!(dir.path().join("cache").join("index.bin").exists());
    assert_eq!(service.client_count(), 1);
}

#[test]
fn connect_to_missing_service_fails() {
    assert!(NetClient::connect("does-not-exist#00").is_err());
    assert!(NetClient::connect("no-token").is_err());
}
