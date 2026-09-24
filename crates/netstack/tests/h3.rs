//! HTTPS with a locally generated CA, and the Alt-Svc upgrade to HTTP/3 (QUIC over UDP
//! on the same port number as the TCP listener).
#![cfg(feature = "http3")]

mod support;

use netstack::{NetClient, NetConfig};
use std::time::{Duration, Instant};
use support::*;

fn tls_client(ca_pem: &str, tweak: impl FnOnce(&mut NetConfig)) -> (NetClient, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = NetConfig::new(dir.path());
    config.extra_root_certificates_pem = vec![ca_pem.as_bytes().to_vec()];
    tweak(&mut config);
    (NetClient::in_process_with_config(config), dir)
}

#[test]
fn alt_svc_upgrades_to_http3() {
    let server = TlsTestServer::start(true, true);
    let (client, _dir) = tls_client(&server.ca_pem, |_| {});
    let first = get(&client, &server.url("/hello"));
    assert_eq!(first.status, 200, "{:?}", first.error);
    assert_eq!(first.http_version, "HTTP/2", "first contact is TCP");
    assert!(first.header("alt-svc").is_some());

    // The advertisement is remembered: the next request races QUIC (which wins locally).
    let second = get(&client, &server.url("/hello"));
    assert_eq!(second.status, 200, "{:?}", second.error);
    assert_eq!(second.http_version, "HTTP/3");
    assert!(body_str(&second).starts_with("hello over h3"));

    // Confirmed: straight to HTTP/3.
    let third = get(&client, &server.url("/hello"));
    assert_eq!(third.http_version, "HTTP/3");
    assert!(server.state.hits("h3:/hello") >= 2);
    assert_eq!(server.state.hits("/hello"), 1, "only the first request used TCP");
}

#[test]
fn unreachable_quic_falls_back_quickly_and_is_marked_broken() {
    // Alt-Svc advertises h3, but nothing listens on UDP.
    let server = TlsTestServer::start(false, true);
    let (client, _dir) = tls_client(&server.ca_pem, |c| {
        c.h3_head_start = Duration::from_millis(300);
        c.h3_probe_timeout = Duration::from_millis(700);
    });
    assert_eq!(get(&client, &server.url("/hello")).http_version, "HTTP/2");

    // QUIC gets a 300 ms head start, then TCP wins the race.
    let started = Instant::now();
    let raced = get(&client, &server.url("/hello"));
    let raced_time = started.elapsed();
    assert_eq!(raced.status, 200, "{:?}", raced.error);
    assert_eq!(raced.http_version, "HTTP/2");
    assert!(raced_time >= Duration::from_millis(250), "{raced_time:?}");
    assert!(raced_time < Duration::from_secs(3), "{raced_time:?}");

    // While the background probe runs, and after it failed, TCP is used without delay.
    for _ in 0..2 {
        let started = Instant::now();
        let r = get(&client, &server.url("/hello"));
        assert_eq!(r.http_version, "HTTP/2");
        assert!(started.elapsed() < Duration::from_millis(250), "{:?}", started.elapsed());
        std::thread::sleep(Duration::from_millis(800));
    }
    println!("fallback request took {raced_time:?}");
}
