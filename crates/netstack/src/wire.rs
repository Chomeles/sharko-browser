//! Wire-compatible mirrors of the `common::protocol` network messages.
//!
//! `NetRequest::body` / `NetResponse::body` are plain `Vec<u8>` fields, which serde
//! (de)serializes element by element: ~2 ns per byte, i.e. ~20 ms for a 10 MiB response.
//! The mirrors below declare the bodies as byte strings instead (`serde_bytes` /
//! [`Bytes`]), which postcard encodes **identically** (varint length + raw bytes) but
//! handles with a single memcpy. Both sides of the netstack IPC use the mirrors; peers
//! that use the `common::protocol` types directly stay fully compatible. The tests at the
//! bottom pin the byte-for-byte equivalence, so a change in `protocol.rs` that is not
//! mirrored here fails loudly.

use bytes::Bytes;
use common::protocol::{CacheMode, Destination, NetRequest, NetResponse, WsData, WsEvent};
use serde::{Deserialize, Serialize};

/// Mirror of `ToNetwork` (client → service).
#[derive(Serialize, Deserialize, Debug)]
pub(crate) enum WireToNetwork {
    Fetch(WireRequest),
    Abort(u64),
    GetCookies { id: u64, url: String },
    SetCookie { url: String, cookie: String },
    Shutdown,
    WsOpen { id: u64, url: String, protocols: Vec<String>, origin: String },
    WsSend { id: u64, data: WsData },
    WsClose { id: u64, code: Option<u16>, reason: String },
}

/// Mirror of `NetRequest`.
#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct WireRequest {
    id: u64,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    body: Option<Vec<u8>>,
    destination: Destination,
    referrer: Option<String>,
    credentials: bool,
    follow_redirects: bool,
    cache_mode: CacheMode,
}

impl From<NetRequest> for WireRequest {
    fn from(r: NetRequest) -> Self {
        Self {
            id: r.id,
            url: r.url,
            method: r.method,
            headers: r.headers,
            body: r.body,
            destination: r.destination,
            referrer: r.referrer,
            credentials: r.credentials,
            follow_redirects: r.follow_redirects,
            cache_mode: r.cache_mode,
        }
    }
}

impl From<WireRequest> for NetRequest {
    fn from(r: WireRequest) -> Self {
        Self {
            id: r.id,
            url: r.url,
            method: r.method,
            headers: r.headers,
            body: r.body,
            destination: r.destination,
            referrer: r.referrer,
            credentials: r.credentials,
            follow_redirects: r.follow_redirects,
            cache_mode: r.cache_mode,
        }
    }
}

/// Mirror of `FromNetwork` for sending (service → client); bodies are shared [`Bytes`]
/// so cached bodies are serialized straight from the cache.
#[derive(Serialize, Debug)]
pub(crate) enum WireFromNetworkOut {
    Response(WireResponseOut),
    Cookies { id: u64, cookies: String },
    Ws { id: u64, event: WsEvent },
}

/// Mirror of `NetResponse` for sending.
#[derive(Serialize, Debug)]
pub(crate) struct WireResponseOut {
    pub id: u64,
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    pub error: Option<String>,
    pub from_cache: bool,
    pub http_version: String,
    pub duration_ms: f64,
}

/// Mirror of `FromNetwork` for receiving (client side).
#[derive(Deserialize, Debug)]
pub(crate) enum WireFromNetworkIn {
    Response(WireResponseIn),
    Cookies { id: u64, cookies: String },
    Ws { id: u64, event: WsEvent },
}

/// Mirror of `NetResponse` for receiving.
#[derive(Deserialize, Debug)]
pub(crate) struct WireResponseIn {
    id: u64,
    status: u16,
    status_text: String,
    url: String,
    headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    body: Vec<u8>,
    error: Option<String>,
    from_cache: bool,
    http_version: String,
    duration_ms: f64,
}

impl From<WireResponseIn> for NetResponse {
    fn from(r: WireResponseIn) -> Self {
        Self {
            id: r.id,
            status: r.status,
            status_text: r.status_text,
            url: r.url,
            headers: r.headers,
            body: r.body,
            error: r.error,
            from_cache: r.from_cache,
            http_version: r.http_version,
            duration_ms: r.duration_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use common::protocol::{FromNetwork, ToNetwork};

    fn request(body: Option<Vec<u8>>) -> NetRequest {
        NetRequest {
            id: 77,
            url: "https://example.com/p?q".into(),
            method: "POST".into(),
            headers: vec![("x-a".into(), "1".into())],
            body,
            destination: Destination::Font,
            referrer: Some("https://r/".into()),
            credentials: false,
            follow_redirects: false,
            cache_mode: CacheMode::OnlyIfCached,
        }
    }

    #[test]
    fn to_network_is_byte_identical() {
        for body in [None, Some(Vec::new()), Some(vec![0, 1, 2, 250, 255])] {
            let ours = postcard::to_allocvec(&WireToNetwork::Fetch(request(body.clone()).into())).unwrap();
            let theirs = postcard::to_allocvec(&ToNetwork::Fetch(request(body.clone()))).unwrap();
            assert_eq!(ours, theirs);
            let WireToNetwork::Fetch(back) = postcard::from_bytes::<WireToNetwork>(&theirs).unwrap() else {
                panic!("wrong variant")
            };
            let back: NetRequest = back.into();
            assert_eq!(back.body, body);
            assert_eq!(back.cache_mode, CacheMode::OnlyIfCached);
            assert_eq!(back.destination, Destination::Font);
        }
        let pairs = [
            (WireToNetwork::Abort(5), ToNetwork::Abort(5)),
            (
                WireToNetwork::GetCookies { id: 1, url: "u".into() },
                ToNetwork::GetCookies { id: 1, url: "u".into() },
            ),
            (
                WireToNetwork::SetCookie { url: "u".into(), cookie: "c".into() },
                ToNetwork::SetCookie { url: "u".into(), cookie: "c".into() },
            ),
            (WireToNetwork::Shutdown, ToNetwork::Shutdown),
            (
                WireToNetwork::WsOpen { id: 3, url: "wss://a/".into(), protocols: vec!["p".into()], origin: "https://a".into() },
                ToNetwork::WsOpen { id: 3, url: "wss://a/".into(), protocols: vec!["p".into()], origin: "https://a".into() },
            ),
            (
                WireToNetwork::WsSend { id: 3, data: WsData::Binary(vec![1, 2]) },
                ToNetwork::WsSend { id: 3, data: WsData::Binary(vec![1, 2]) },
            ),
            (
                WireToNetwork::WsClose { id: 3, code: Some(1000), reason: "bye".into() },
                ToNetwork::WsClose { id: 3, code: Some(1000), reason: "bye".into() },
            ),
        ];
        for (ours, theirs) in pairs {
            assert_eq!(postcard::to_allocvec(&ours).unwrap(), postcard::to_allocvec(&theirs).unwrap());
        }
    }

    #[test]
    fn from_network_is_byte_identical() {
        let body = vec![0u8, 1, 2, 255, 128, 7];
        let headers = vec![("content-type".to_string(), "text/plain".to_string())];
        let ours = WireFromNetworkOut::Response(WireResponseOut {
            id: 300,
            status: 200,
            status_text: "OK".into(),
            url: "https://a/".into(),
            headers: headers.clone(),
            body: Bytes::from(body.clone()),
            error: Some("e".into()),
            from_cache: true,
            http_version: "HTTP/2".into(),
            duration_ms: 1.5,
        });
        let theirs = FromNetwork::Response(NetResponse {
            id: 300,
            status: 200,
            status_text: "OK".into(),
            url: "https://a/".into(),
            headers,
            body: body.clone(),
            error: Some("e".into()),
            from_cache: true,
            http_version: "HTTP/2".into(),
            duration_ms: 1.5,
        });
        let a = postcard::to_allocvec(&ours).unwrap();
        let b = postcard::to_allocvec(&theirs).unwrap();
        assert_eq!(a, b);
        // Decodes with both the protocol type and the fast mirror.
        assert!(matches!(postcard::from_bytes::<FromNetwork>(&a).unwrap(), FromNetwork::Response(r) if r.body == body));
        let WireFromNetworkIn::Response(fast) = postcard::from_bytes::<WireFromNetworkIn>(&b).unwrap() else {
            panic!("wrong variant")
        };
        let fast: NetResponse = fast.into();
        assert_eq!((fast.id, fast.body, fast.duration_ms), (300, body, 1.5));

        let ours = postcard::to_allocvec(&WireFromNetworkOut::Cookies { id: 9, cookies: "a=b".into() }).unwrap();
        let theirs = postcard::to_allocvec(&FromNetwork::Cookies { id: 9, cookies: "a=b".into() }).unwrap();
        assert_eq!(ours, theirs);
        assert!(matches!(
            postcard::from_bytes::<WireFromNetworkIn>(&theirs).unwrap(),
            WireFromNetworkIn::Cookies { id: 9, .. }
        ));

        let event = WsEvent::Message(WsData::Text("hi".into()));
        let ours = postcard::to_allocvec(&WireFromNetworkOut::Ws { id: 4, event: event.clone() }).unwrap();
        let theirs = postcard::to_allocvec(&FromNetwork::Ws { id: 4, event: event.clone() }).unwrap();
        assert_eq!(ours, theirs);
        assert!(matches!(
            postcard::from_bytes::<WireFromNetworkIn>(&theirs).unwrap(),
            WireFromNetworkIn::Ws { id: 4, event: e } if e == event
        ));
    }
}
