//! WebSocket connections of the in-process network stack against a local server.

mod support;

use futures_util::{SinkExt, StreamExt};
use netstack::{WsData, WsEvent};
use std::sync::mpsc;
use std::time::Duration;
use support::client;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

/// Echo server on a background runtime: echoes text and binary messages, answers
/// "close-me" with a server-initiated close (4001, "bye"), picks the "chat" subprotocol
/// when offered and records each handshake's Cookie and Origin headers.
fn start_server() -> (String, mpsc::Receiver<(Option<String>, Option<String>)>) {
    let (addr_tx, addr_rx) = mpsc::channel();
    let (hs_tx, hs_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            addr_tx.send(listener.local_addr().unwrap()).unwrap();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let hs_tx = hs_tx.clone();
                tokio::spawn(async move {
                    let callback = |req: &Request, mut resp: Response| {
                        let header = |n: &str| req.headers().get(n).and_then(|v| v.to_str().ok()).map(String::from);
                        let _ = hs_tx.send((header("cookie"), header("origin")));
                        if header("sec-websocket-protocol").is_some_and(|p| p.split(',').any(|p| p.trim() == "chat")) {
                            resp.headers_mut().insert("sec-websocket-protocol", "chat".parse().unwrap());
                        }
                        Ok(resp)
                    };
                    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
                    while let Some(Ok(msg)) = ws.next().await {
                        match msg {
                            Message::Text(t) if t.as_str() == "close-me" => {
                                let _ = ws
                                    .close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                        code: 4001.into(),
                                        reason: "bye".into(),
                                    }))
                                    .await;
                            }
                            Message::Text(_) | Message::Binary(_) => {
                                let _ = ws.send(msg).await;
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
    });
    let addr = addr_rx.recv().unwrap();
    (format!("ws://{addr}/socket"), hs_rx)
}

fn next(rx: &mpsc::Receiver<WsEvent>) -> WsEvent {
    rx.recv_timeout(Duration::from_secs(10)).expect("websocket event")
}

fn next_non_sent(rx: &mpsc::Receiver<WsEvent>) -> WsEvent {
    loop {
        match next(rx) {
            WsEvent::Sent(_) => continue,
            other => return other,
        }
    }
}

#[test]
fn echo_subprotocol_cookies_and_client_close() {
    let (url, handshakes) = start_server();
    let (client, _dir) = client();
    client.set_cookie(&url.replace("ws://", "http://"), "session=abc");
    let (tx, rx) = mpsc::channel();
    let id = client.ws_open(&url, vec!["chat".into(), "other".into()], "http://example.test", Box::new(move |e| {
        let _ = tx.send(e);
    }));
    assert_eq!(next(&rx), WsEvent::Open { protocol: "chat".into(), extensions: String::new() });
    let (cookie, origin) = handshakes.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(cookie.as_deref(), Some("session=abc"));
    assert_eq!(origin.as_deref(), Some("http://example.test"));

    client.ws_send(id, WsData::Text("hello".into()));
    assert_eq!(next(&rx), WsEvent::Sent(5));
    assert_eq!(next(&rx), WsEvent::Message(WsData::Text("hello".into())));
    client.ws_send(id, WsData::Binary(vec![0, 1, 255]));
    assert_eq!(next_non_sent(&rx), WsEvent::Message(WsData::Binary(vec![0, 1, 255])));

    client.ws_close(id, Some(1000), "done");
    assert_eq!(next_non_sent(&rx), WsEvent::Closed { code: 1000, reason: "done".into(), clean: true });
}

#[test]
fn server_close_and_failed_handshakes() {
    let (url, _handshakes) = start_server();
    let (client, _dir) = client();
    let (tx, rx) = mpsc::channel();
    let id = client.ws_open(&url, Vec::new(), "", Box::new(move |e| {
        let _ = tx.send(e);
    }));
    assert!(matches!(next(&rx), WsEvent::Open { .. }));
    client.ws_send(id, WsData::Text("close-me".into()));
    assert_eq!(next_non_sent(&rx), WsEvent::Closed { code: 4001, reason: "bye".into(), clean: true });

    // Nothing listens there: error, then an unclean close.
    let (tx, rx) = mpsc::channel();
    client.ws_open("ws://127.0.0.1:9/", Vec::new(), "", Box::new(move |e| {
        let _ = tx.send(e);
    }));
    assert!(matches!(next(&rx), WsEvent::Error(_)));
    assert_eq!(next(&rx), WsEvent::Closed { code: 1006, reason: String::new(), clean: false });

    // A plain HTTP server does not switch protocols.
    let server = support::TestServer::start();
    let (tx, rx) = mpsc::channel();
    client.ws_open(&server.url("/hello").replace("http://", "ws://"), Vec::new(), "", Box::new(move |e| {
        let _ = tx.send(e);
    }));
    match next(&rx) {
        WsEvent::Error(e) => assert!(e.contains("Unexpected response code"), "{e}"),
        other => panic!("expected an error, got {other:?}"),
    }
    assert!(matches!(next(&rx), WsEvent::Closed { code: 1006, clean: false, .. }));

    // Closing while still connecting aborts the attempt.
    let (tx, rx) = mpsc::channel();
    let id = client.ws_open("ws://10.255.255.1/", Vec::new(), "", Box::new(move |e| {
        let _ = tx.send(e);
    }));
    client.ws_close(id, None, "");
    let mut last = next(&rx);
    if matches!(last, WsEvent::Error(_)) {
        // The connection attempt may fail on its own before the close arrives.
        last = next(&rx);
    }
    assert_eq!(last, WsEvent::Closed { code: 1006, reason: String::new(), clean: false });
}
