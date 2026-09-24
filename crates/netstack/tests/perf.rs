//! Latency measurements (printed; run with `--nocapture`). Assertions are deliberately
//! loose so the test is not flaky on slow CI machines.

mod support;

use common::ipc::IpcListener;
use netstack::{Destination, NetClient, NetConfig, NetRequest, NetworkService};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use support::*;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn sequential_cached_hits(label: &str, client: &NetClient, url: &str) -> Duration {
    let first = get(client, url);
    assert_eq!(first.status, 200, "{:?}", first.error);
    let started = Instant::now();
    for _ in 0..100 {
        let r = get(client, url);
        assert!(r.from_cache, "{label}: expected cache hit");
    }
    let avg = started.elapsed() / 100;
    println!("[{label}] 100 sequential cached hits: avg {avg:?} per request (round trip incl. callback)");
    avg
}

fn parallel(label: &str, client: &NetClient, server: &TestServer, round: &str) -> Duration {
    let (tx, rx) = mpsc::channel();
    let started = Instant::now();
    for i in 0..50 {
        let tx = tx.clone();
        let sent = Instant::now();
        client.fetch(
            NetRequest::get(0, server.url(&format!("/hello?{round}={i}")), Destination::Other),
            Box::new(move |r| {
                let _ = tx.send((r.status, sent.elapsed()));
            }),
        );
    }
    let mut latencies: Vec<f64> = (0..50)
        .map(|_| {
            let (status, latency) = rx.recv_timeout(TIMEOUT).unwrap();
            assert_eq!(status, 200);
            latency.as_secs_f64() * 1000.0
        })
        .collect();
    let total = started.elapsed();
    latencies.sort_by(f64::total_cmp);
    println!(
        "[{label}] 50 parallel requests ({round} connections): total {total:?}, p50 {:.2} ms, p90 {:.2} ms, max {:.2} ms",
        percentile(&latencies, 0.5),
        percentile(&latencies, 0.9),
        latencies[latencies.len() - 1],
    );
    total
}

fn sequential_uncached(label: &str, client: &NetClient, server: &TestServer) {
    let started = Instant::now();
    for i in 0..100 {
        assert_eq!(get(client, &server.url(&format!("/hello?seq={i}"))).status, 200);
    }
    println!("[{label}] 100 sequential network requests (keep-alive): avg {:?}", started.elapsed() / 100);
}

#[test]
fn latency_figures() {
    let server = TestServer::start();

    let (local, _dir) = client();
    let avg = sequential_cached_hits("in-process", &local, &server.url("/max-age"));
    assert!(avg < Duration::from_millis(20));
    parallel("in-process", &local, &server, "cold");
    parallel("in-process", &local, &server, "warm");
    sequential_uncached("in-process", &local, &server);

    let dir = tempfile::tempdir().unwrap();
    let mut config = NetConfig::new(dir.path());
    config.memory_cache_bytes = 1; // every hit is read from disk
    let disk_only = NetClient::in_process_with_config(config);
    sequential_cached_hits("in-process, disk tier", &disk_only, &server.url("/max-age"));

    let ipc_dir = tempfile::tempdir().unwrap();
    let listener = IpcListener::new("netstack-perf").unwrap();
    let endpoint = listener.endpoint();
    let _service = NetworkService::start(listener, NetConfig::new(ipc_dir.path())).unwrap();
    let remote = NetClient::connect(&endpoint).unwrap();
    let avg = sequential_cached_hits("ipc", &remote, &server.url("/max-age"));
    assert!(avg < Duration::from_millis(20));
    parallel("ipc", &remote, &server, "cold");
    parallel("ipc", &remote, &server, "warm");
    sequential_uncached("ipc", &remote, &server);

    let started = Instant::now();
    let big = get(&remote, &server.url("/big"));
    assert_eq!(big.body.len(), 10 * 1024 * 1024);
    println!("[ipc] 10 MiB response end-to-end: {:?}", started.elapsed());
    let started = Instant::now();
    let big = get(&remote, &server.url("/big"));
    assert_eq!(big.body.len(), 10 * 1024 * 1024);
    println!("[ipc] 10 MiB response again (not cacheable, network): {:?}", started.elapsed());
}
