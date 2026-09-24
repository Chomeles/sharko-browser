//! End-to-end tests of the in-process network stack against a local HTTP server.

mod support;

use netstack::{CacheMode, Destination, NetClient, NetConfig, NetRequest};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use support::*;

#[test]
fn decompression_gzip_deflate_br_zstd() {
    let server = TestServer::start();
    let (client, _dir) = client();
    for encoding in ["gzip", "deflate", "br", "zstd"] {
        let r = get(&client, &server.url(&format!("/{encoding}")));
        assert_eq!(r.status, 200, "{encoding}: {:?}", r.error);
        assert_eq!(r.body, payload(), "{encoding} body not decoded");
        assert!(r.header("content-encoding").is_none(), "{encoding}: content-encoding must be removed");
        assert_eq!(r.http_version, "HTTP/1.1");
        assert_eq!(r.status_text, "OK");
    }
}

#[test]
fn redirects_follow_manual_and_loop() {
    let server = TestServer::start();
    let (client, _dir) = client();

    let r = get(&client, &server.url("/redirect/3#section"));
    assert_eq!(r.status, 200);
    assert_eq!(body_str(&r), "done");
    // Final URL after redirects, with the fragment inherited.
    assert_eq!(r.url, server.url("/redirect/0#section"));

    let mut manual = NetRequest::get(0, server.url("/redirect/3"), Destination::Fetch);
    manual.follow_redirects = false;
    let r = fetch(&client, manual);
    assert_eq!(r.status, 302);
    assert_eq!(r.header("location"), Some("/redirect/2"));
    assert!(r.error.is_none());

    let r = get(&client, &server.url("/redirect-loop"));
    assert_eq!(r.status, 0);
    assert!(r.error.as_deref().unwrap().contains("ERR_TOO_MANY_REDIRECTS"), "{:?}", r.error);
    assert_eq!(server.hits("/redirect-loop"), 21);
}

#[test]
fn redirect_method_rewriting() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let post = |code: u16| {
        let mut req = NetRequest::get(0, server.url(&format!("/post-redirect/{code}")), Destination::Document);
        req.method = "POST".into();
        req.body = Some(b"a=1".to_vec());
        req.headers.push(("Content-Type".into(), "application/x-www-form-urlencoded".into()));
        body_str(&fetch(&client, req))
    };
    assert_eq!(post(301), "GET ");
    assert_eq!(post(302), "GET ");
    assert_eq!(post(303), "GET ");
    assert_eq!(post(307), "POST a=1");
    assert_eq!(post(308), "POST a=1");
}

#[test]
fn cookies_set_sent_and_credentials_false() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let page = server.url("/");

    assert_eq!(get(&client, &server.url("/set-cookie")).status, 200);
    let echo = body_str(&get(&client, &server.url("/echo-headers")));
    assert!(echo.contains("cookie: visible=1; secret=2"), "{echo}");
    // Set-Cookie is never exposed to clients.
    assert!(get(&client, &server.url("/set-cookie")).header("set-cookie").is_none());

    // document.cookie hides HttpOnly cookies; script cookies are sent.
    assert_eq!(client.get_cookies_blocking(&page), "visible=1");
    client.set_cookie(&page, "js=3; Path=/");
    client.set_cookie(&page, "evil=4; HttpOnly");
    assert_eq!(client.get_cookies_blocking(&page), "visible=1; js=3");
    let echo = body_str(&get(&client, &server.url("/echo-headers")));
    assert!(echo.contains("cookie: visible=1; secret=2; js=3"), "{echo}");

    // credentials: false neither sends nor stores cookies.
    let mut anon = NetRequest::get(0, server.url("/echo-headers"), Destination::Fetch);
    anon.credentials = false;
    let echo = body_str(&fetch(&client, anon));
    assert!(!echo.contains("cookie:"), "{echo}");
    let mut anon = NetRequest::get(0, server.url("/set-cookie-other"), Destination::Fetch);
    anon.credentials = false;
    fetch(&client, anon);
    assert!(!client.get_cookies_blocking(&page).contains("other"));

    // Cookies set by a redirect response are stored and sent to the next hop.
    let echo = body_str(&get(&client, &server.url("/set-cookie-redirect")));
    assert!(echo.contains("redir=1"), "{echo}");
}

#[test]
fn default_request_headers() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let mut req = NetRequest::get(0, server.url("/echo-headers"), Destination::Style);
    req.referrer = Some(server.url("/page.html#frag"));
    req.headers.push(("X-Custom".into(), "yes".into()));
    let echo = body_str(&fetch(&client, req));
    assert!(echo.contains(&format!("user-agent: {}", common::USER_AGENT)), "{echo}");
    assert!(echo.contains("accept: text/css,*/*;q=0.1"), "{echo}");
    assert!(echo.contains("accept-language: de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"), "{echo}");
    assert!(echo.contains("accept-encoding: gzip, deflate, br, zstd"), "{echo}");
    // Same-origin referrer: full URL without fragment.
    assert!(echo.contains(&format!("referer: {}", server.url("/page.html"))), "{echo}");
    assert!(echo.contains("x-custom: yes"), "{echo}");
    // Loopback http is potentially trustworthy: Fetch metadata is sent.
    assert!(echo.contains("sec-fetch-dest: style"), "{echo}");
    assert!(echo.contains("sec-fetch-site: same-origin"), "{echo}");

    let mut req = NetRequest::get(0, server.url("/echo-headers"), Destination::Fetch);
    req.headers.push(("User-Agent".into(), "custom-agent".into()));
    let echo = body_str(&fetch(&client, req));
    assert!(echo.contains("user-agent: custom-agent"), "{echo}");
}

#[test]
fn max_age_is_served_from_cache_and_cache_modes() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let url = server.url("/max-age");

    let first = get(&client, &url);
    assert_eq!(body_str(&first), "hit 1");
    assert!(!first.from_cache);
    let second = get(&client, &url);
    assert_eq!(body_str(&second), "hit 1");
    assert!(second.from_cache);
    assert_eq!(second.http_version, "HTTP/1.1");
    assert_eq!(server.hits("/max-age"), 1);

    let with_mode = |mode: CacheMode| {
        let mut req = NetRequest::get(0, url.clone(), Destination::Other);
        req.cache_mode = mode;
        fetch(&client, req)
    };
    // force-cache / only-if-cached / default use the entry.
    assert!(with_mode(CacheMode::ForceCache).from_cache);
    assert!(with_mode(CacheMode::OnlyIfCached).from_cache);
    // no-store bypasses the cache completely (and doesn't update it).
    let r = with_mode(CacheMode::NoStore);
    assert_eq!((body_str(&r).as_str(), r.from_cache), ("hit 2", false));
    // reload goes to the network and updates the cache.
    let r = with_mode(CacheMode::Reload);
    assert_eq!((body_str(&r).as_str(), r.from_cache), ("hit 3", false));
    let r = get(&client, &url);
    assert_eq!((body_str(&r).as_str(), r.from_cache), ("hit 3", true));
    // no-cache must revalidate; without validators that's a full fetch.
    let r = with_mode(CacheMode::NoCache);
    assert_eq!((body_str(&r).as_str(), r.from_cache), ("hit 4", false));

    // only-if-cached miss: 504-style error.
    let mut req = NetRequest::get(0, server.url("/hello"), Destination::Other);
    req.cache_mode = CacheMode::OnlyIfCached;
    let r = fetch(&client, req);
    assert_eq!(r.status, 504);
    assert!(r.error.is_some());
    assert_eq!(server.hits("/hello"), 0);
}

#[test]
fn no_store_is_never_cached() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let url = server.url("/no-store");
    assert_eq!(body_str(&get(&client, &url)), "hit 1");
    let r = get(&client, &url);
    assert_eq!(body_str(&r), "hit 2");
    assert!(!r.from_cache);
}

#[test]
fn etag_revalidation_304() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let url = server.url("/etag");
    let first = get(&client, &url);
    assert_eq!((first.status, body_str(&first).as_str(), first.from_cache), (200, "etag body", false));
    let second = get(&client, &url);
    assert_eq!((second.status, body_str(&second).as_str(), second.from_cache), (200, "etag body", true));
    // Headers of the 304 are merged into the stored response.
    assert_eq!(second.header("x-revalidated"), Some("yes"));
    assert_eq!(server.hits("/etag"), 2);
    assert_eq!(server.hits("/etag:304"), 1);
}

#[test]
fn heuristic_freshness_from_last_modified() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let url = server.url("/last-modified");
    assert_eq!(body_str(&get(&client, &url)), "hit 1");
    let r = get(&client, &url);
    assert_eq!(body_str(&r), "hit 1");
    assert!(r.from_cache);
}

#[test]
fn vary_keys_variants() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let get_variant = |v: &str| {
        let mut req = NetRequest::get(0, server.url("/vary"), Destination::Fetch);
        req.headers.push(("X-Variant".into(), v.into()));
        fetch(&client, req)
    };
    assert_eq!(body_str(&get_variant("a")), "variant=a hit=1");
    assert_eq!(body_str(&get_variant("b")), "variant=b hit=2");
    let a = get_variant("a");
    assert_eq!((body_str(&a).as_str(), a.from_cache), ("variant=a hit=1", true));
    let b = get_variant("b");
    assert_eq!((body_str(&b).as_str(), b.from_cache), ("variant=b hit=2", true));
    assert_eq!(server.hits("/vary"), 2);
}

#[test]
fn stale_while_revalidate_serves_stale_and_refreshes() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let url = server.url("/swr");
    assert_eq!(body_str(&get(&client, &url)), "hit 1");
    std::thread::sleep(Duration::from_millis(2100));
    let stale = get(&client, &url);
    assert_eq!((body_str(&stale).as_str(), stale.from_cache), ("hit 1", true));
    // The background revalidation refreshes the entry.
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.hits("/swr") < 2 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(100));
    let fresh = get(&client, &url);
    assert_eq!((body_str(&fresh).as_str(), fresh.from_cache), ("hit 2", true));
}

#[test]
fn unsafe_methods_invalidate() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let url = server.url("/max-age");
    assert_eq!(body_str(&get(&client, &url)), "hit 1");
    assert!(get(&client, &url).from_cache);
    let mut post = NetRequest::get(0, url.clone(), Destination::Fetch);
    post.method = "POST".into();
    post.body = Some(b"x".to_vec());
    assert_eq!(body_str(&fetch(&client, post)), "posted");
    let r = get(&client, &url);
    assert_eq!((body_str(&r).as_str(), r.from_cache), ("hit 3", false));
}

#[test]
fn abort_cancels_without_callback() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let (tx, rx) = mpsc::channel();
    let id = client.fetch(
        NetRequest::get(0, server.url("/slow"), Destination::Other),
        Box::new(move |r| {
            let _ = tx.send(r);
        }),
    );
    std::thread::sleep(Duration::from_millis(200));
    client.abort(id);
    assert!(rx.recv_timeout(Duration::from_secs(4)).is_err(), "aborted request must not call back");
    // The stack is still healthy.
    assert_eq!(get(&client, &server.url("/hello")).status, 200);
}

#[test]
fn ten_megabyte_body() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let started = Instant::now();
    let r = get(&client, &server.url("/big"));
    let elapsed = started.elapsed();
    assert_eq!(r.status, 200);
    assert_eq!(r.body.len(), 10 * 1024 * 1024);
    assert!(r.body == big_body(), "body corrupted");
    println!("10 MiB over loopback in {elapsed:?} (reported {:.1} ms)", r.duration_ms);
}

#[test]
fn fifty_concurrent_requests() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let (tx, rx) = mpsc::channel();
    let started = Instant::now();
    for i in 0..50 {
        let tx = tx.clone();
        client.fetch(
            NetRequest::get(0, server.url(&format!("/hello?i={i}")), Destination::Other),
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
    }
    let mut ids = std::collections::HashSet::new();
    for _ in 0..50 {
        let r = rx.recv_timeout(TIMEOUT).expect("response");
        assert_eq!(r.status, 200, "{:?}", r.error);
        assert_eq!(body_str(&r), "hello world");
        ids.insert(r.id);
    }
    assert_eq!(ids.len(), 50, "every request gets its own id and callback");
    println!("50 concurrent requests completed in {:?}", started.elapsed());
}

#[test]
fn file_data_and_about_urls() {
    let (client, dir) = client();
    let file = dir.path().join("page.html");
    std::fs::write(&file, "<h1>file</h1>").unwrap();
    let file_url = url::Url::from_file_path(&file).unwrap().to_string();
    let r = get(&client, &file_url);
    assert_eq!((r.status, body_str(&r).as_str()), (200, "<h1>file</h1>"));
    assert_eq!(r.header("content-type"), Some("text/html"));

    let listing = get(&client, url::Url::from_directory_path(dir.path()).unwrap().as_str());
    assert!(body_str(&listing).contains("page.html"));

    let r = get(&client, "data:text/plain;base64,SGVsbG8=");
    assert_eq!((r.status, body_str(&r).as_str()), (200, "Hello"));
    assert_eq!(r.header("content-type"), Some("text/plain"));

    let r = get(&client, "about:blank");
    assert_eq!((r.status, r.body.len()), (200, 0));

    let r = get(&client, &format!("{file_url}.missing"));
    assert_eq!(r.status, 0);
    assert!(r.error.as_deref().unwrap().contains("ERR_FILE_NOT_FOUND"));
}

#[test]
fn network_errors_are_reported() {
    let (client, _dir) = client();
    // A port without a listener.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let r = get(&client, &format!("http://127.0.0.1:{port}/"));
    assert_eq!(r.status, 0);
    assert!(r.error.as_deref().unwrap().contains("ERR_CONNECTION_REFUSED"), "{:?}", r.error);
    assert!(r.duration_ms >= 0.0);

    let r = get(&client, "gopher://example.com/");
    assert!(r.error.as_deref().unwrap().contains("ERR_UNKNOWN_URL_SCHEME"));
    let r = get(&client, "not a url");
    assert!(r.error.as_deref().unwrap().contains("ERR_INVALID_URL"));
}

#[test]
fn persistence_across_restarts() {
    let server = TestServer::start();
    let dir = tempfile::tempdir().unwrap();
    {
        let client = NetClient::in_process(dir.path().to_path_buf());
        assert_eq!(body_str(&get(&client, &server.url("/max-age"))), "hit 1");
        get(&client, &server.url("/set-cookie"));
        // Dropping the last handle persists cookies and the cache index.
    }
    assert!(dir.path().join("cookies.json").exists());
    assert!(dir.path().join("cache").join("index.bin").exists());
    let client = NetClient::in_process(dir.path().to_path_buf());
    let r = get(&client, &server.url("/max-age"));
    assert_eq!((body_str(&r).as_str(), r.from_cache), ("hit 1", true), "served from the disk cache");
    let echo = body_str(&get(&client, &server.url("/echo-headers")));
    // Only persistent cookies survive; the test cookies are session cookies.
    assert!(!echo.contains("visible=1"), "session cookies must not survive a restart: {echo}");
}

#[test]
fn ephemeral_config_touches_no_disk() {
    let server = TestServer::start();
    let client = NetClient::in_process_with_config(NetConfig::ephemeral());
    assert_eq!(body_str(&get(&client, &server.url("/max-age"))), "hit 1");
    assert!(get(&client, &server.url("/max-age")).from_cache);
}

#[test]
fn progress_reports_upload_and_download() {
    let server = TestServer::start();
    let (client, _dir) = client();
    let reports = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));

    let seen = std::sync::Arc::clone(&reports);
    let (tx, rx) = mpsc::channel();
    client.fetch_with_progress(
        NetRequest::get(0, server.url("/big"), Destination::Fetch),
        std::sync::Arc::new(move |loaded, total, upload| seen.lock().unwrap().push((loaded, total, upload))),
        Box::new(move |r| {
            let _ = tx.send(r);
        }),
    );
    let r = rx.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(r.body.len(), 10 * 1024 * 1024);
    let down = reports.lock().unwrap().clone();
    assert!(!down.is_empty() && down.iter().all(|&(_, _, upload)| !upload), "{down:?}");
    assert!(down.windows(2).all(|w| w[0].0 <= w[1].0), "monotonic: {down:?}");
    assert!(down.iter().all(|&(loaded, _, _)| loaded <= 10 * 1024 * 1024));

    reports.lock().unwrap().clear();
    let seen = std::sync::Arc::clone(&reports);
    let (tx, rx) = mpsc::channel();
    let mut post = NetRequest::get(0, server.url("/echo-method"), Destination::Fetch);
    post.method = "POST".into();
    post.body = Some(vec![b'x'; 3 * 1024 * 1024]);
    client.fetch_with_progress(
        post,
        std::sync::Arc::new(move |loaded, total, upload| seen.lock().unwrap().push((loaded, total, upload))),
        Box::new(move |r| {
            let _ = tx.send(r);
        }),
    );
    let r = rx.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(r.status, 200, "{:?}", r.error);
    assert_eq!(r.body.len(), "POST ".len() + 3 * 1024 * 1024, "the streamed body arrives intact");
    let up: Vec<_> = reports.lock().unwrap().iter().filter(|r| r.2).cloned().collect();
    assert_eq!(up.last(), Some(&(3 * 1024 * 1024, 3 * 1024 * 1024, true)), "{up:?}");
}
