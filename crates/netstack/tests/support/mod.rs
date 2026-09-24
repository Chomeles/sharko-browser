//! Shared test infrastructure: local HTTP/1.1+h2c, HTTPS (h2/http1.1) and HTTP/3 test
//! servers, plus blocking helpers around `NetClient`.
#![allow(dead_code)]

use bytes::Bytes;
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use netstack::{Destination, NetClient, NetRequest, NetResponse};
use std::collections::HashMap;
use std::convert::Infallible;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

pub const TIMEOUT: Duration = Duration::from_secs(30);

/// Blocking fetch with a timeout.
pub fn fetch(client: &NetClient, req: NetRequest) -> NetResponse {
    let (tx, rx) = std::sync::mpsc::channel();
    client.fetch(
        req,
        Box::new(move |r| {
            let _ = tx.send(r);
        }),
    );
    rx.recv_timeout(TIMEOUT).expect("no response within timeout")
}

pub fn get(client: &NetClient, url: &str) -> NetResponse {
    fetch(client, NetRequest::get(0, url, Destination::Other))
}

pub fn body_str(r: &NetResponse) -> String {
    String::from_utf8_lossy(&r.body).into_owned()
}

/// A client with an isolated profile directory (kept alive by the returned guard).
pub fn client() -> (NetClient, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    (NetClient::in_process(dir.path().to_path_buf()), dir)
}

// ---------------------------------------------------------------------------
// Server state and routes
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ServerState {
    hits: Mutex<HashMap<String, usize>>,
    /// Added to every response when set (e.g. `h3=":1234"`).
    pub alt_svc: Mutex<Option<String>>,
}

impl ServerState {
    pub fn hit(&self, key: &str) -> usize {
        let mut hits = self.hits.lock().unwrap();
        let n = hits.entry(key.to_owned()).or_default();
        *n += 1;
        *n
    }

    pub fn hits(&self, key: &str) -> usize {
        self.hits.lock().unwrap().get(key).copied().unwrap_or(0)
    }
}

pub fn payload() -> Vec<u8> {
    "The quick brown fox jumps over the lazy dog. ".repeat(200).into_bytes()
}

pub fn big_body() -> Vec<u8> {
    (0..10 * 1024 * 1024).map(|i: usize| (i % 251) as u8).collect()
}

fn compress(encoding: &str, data: &[u8]) -> Vec<u8> {
    match encoding {
        "gzip" => {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(data).unwrap();
            e.finish().unwrap()
        }
        "deflate" => {
            let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(data).unwrap();
            e.finish().unwrap()
        }
        "br" => {
            let mut out = Vec::new();
            {
                let mut w = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
                w.write_all(data).unwrap();
            }
            out
        }
        "zstd" => zstd::encode_all(data, 3).unwrap(),
        other => panic!("unknown encoding {other}"),
    }
}

type Resp = Response<Full<Bytes>>;

fn respond(status: u16, headers: &[(&str, String)], body: impl Into<Bytes>) -> Resp {
    let mut b = Response::builder().status(StatusCode::from_u16(status).unwrap());
    for (k, v) in headers {
        b = b.header(*k, v.as_str());
    }
    b.body(Full::new(body.into())).unwrap()
}

fn text(status: u16, body: impl Into<String>) -> Resp {
    respond(status, &[("content-type", "text/plain".into())], body.into())
}

fn redirect(status: u16, location: &str) -> Resp {
    respond(status, &[("location", location.to_owned())], Bytes::new())
}

fn header<'a>(req: &'a http::HeaderMap, name: &str) -> &'a str {
    req.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

pub async fn route(state: Arc<ServerState>, req: Request<Incoming>) -> Resp {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_owned();
    let n = state.hit(&path);
    let body = body.collect().await.map(|c| c.to_bytes()).unwrap_or_default();
    let h = &parts.headers;
    let mut resp = match path.as_str() {
        "/hello" => text(200, "hello world"),
        "/gzip" | "/br" | "/zstd" | "/deflate" => {
            let enc = &path[1..];
            if !header(h, "accept-encoding").split(',').any(|e| e.trim() == enc) {
                text(406, "encoding not accepted")
            } else {
                respond(
                    200,
                    &[("content-encoding", enc.to_owned()), ("content-type", "text/plain".into())],
                    compress(enc, &payload()),
                )
            }
        }
        p if p.starts_with("/redirect/") => {
            let left: u32 = p["/redirect/".len()..].parse().unwrap_or(0);
            if left == 0 {
                text(200, "done")
            } else {
                redirect(302, &format!("/redirect/{}", left - 1))
            }
        }
        "/redirect-loop" => redirect(302, "/redirect-loop"),
        p if p.starts_with("/post-redirect/") => {
            let code: u16 = p["/post-redirect/".len()..].parse().unwrap_or(302);
            redirect(code, "/echo-method")
        }
        "/echo-method" => text(200, format!("{} {}", parts.method, String::from_utf8_lossy(&body))),
        "/set-cookie" => respond(
            200,
            &[
                ("set-cookie", "visible=1; Path=/".into()),
                ("set-cookie", "secret=2; Path=/; HttpOnly".into()),
            ],
            "ok",
        ),
        "/set-cookie-other" => respond(200, &[("set-cookie", "other=1; Path=/".into())], "ok"),
        "/set-cookie-redirect" => respond(
            302,
            &[
                ("set-cookie", "redir=1; Path=/".into()),
                ("location", "/echo-headers".into()),
            ],
            Bytes::new(),
        ),
        "/echo-headers" => {
            let mut out = String::new();
            for (k, v) in h {
                out.push_str(&format!("{}: {}\n", k, v.to_str().unwrap_or("?")));
            }
            text(200, out)
        }
        "/max-age" => {
            if parts.method == http::Method::POST {
                text(200, "posted")
            } else {
                respond(200, &[("cache-control", "max-age=60".into())], format!("hit {n}"))
            }
        }
        "/no-store" => respond(200, &[("cache-control", "no-store".into())], format!("hit {n}")),
        "/etag" => {
            if header(h, "if-none-match") == "\"v1\"" {
                state.hit("/etag:304");
                respond(304, &[("etag", "\"v1\"".into()), ("cache-control", "no-cache".into()), ("x-revalidated", "yes".into())], Bytes::new())
            } else {
                respond(200, &[("etag", "\"v1\"".into()), ("cache-control", "no-cache".into())], "etag body")
            }
        }
        "/last-modified" => {
            let now = SystemTime::now();
            respond(
                200,
                &[
                    ("date", httpdate::fmt_http_date(now)),
                    ("last-modified", httpdate::fmt_http_date(now - Duration::from_secs(10 * 24 * 3600))),
                ],
                format!("hit {n}"),
            )
        }
        "/vary" => respond(
            200,
            &[("vary", "X-Variant".into()), ("cache-control", "max-age=60".into())],
            format!("variant={} hit={n}", header(h, "x-variant")),
        ),
        "/swr" => respond(
            200,
            &[("cache-control", "max-age=1, stale-while-revalidate=60".into())],
            format!("hit {n}"),
        ),
        "/slow" => {
            tokio::time::sleep(Duration::from_secs(3)).await;
            text(200, "slow")
        }
        "/big" => respond(200, &[("content-type", "application/octet-stream".into())], big_body()),
        p if p.starts_with("/status/") => {
            let code: u16 = p["/status/".len()..].parse().unwrap_or(500);
            text(code, format!("status {code}"))
        }
        _ => text(404, "not found"),
    };
    if let Some(alt) = state.alt_svc.lock().unwrap().clone() {
        resp.headers_mut().insert("alt-svc", alt.parse().unwrap());
    }
    resp
}

fn serve_connection<S>(state: Arc<ServerState>, io: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let svc = hyper::service::service_fn(move |req| {
            let state = Arc::clone(&state);
            async move { Ok::<_, Infallible>(route(state, req).await) }
        });
        let _ = auto::Builder::new(TokioExecutor::new())
            .serve_connection(TokioIo::new(io), svc)
            .await;
    });
}

fn server_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

// ---------------------------------------------------------------------------
// Plain HTTP server
// ---------------------------------------------------------------------------

pub struct TestServer {
    pub port: u16,
    pub state: Arc<ServerState>,
}

impl TestServer {
    pub fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(ServerState::default());
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            server_runtime().block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        let _ = stream.set_nodelay(true);
                        serve_connection(Arc::clone(&st), stream);
                    }
                }
            });
        });
        TestServer { port, state }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    pub fn hits(&self, path: &str) -> usize {
        self.state.hits(path)
    }
}

// ---------------------------------------------------------------------------
// HTTPS (+ HTTP/3) server with a generated CA
// ---------------------------------------------------------------------------

pub struct TestCa {
    pub ca_pem: String,
    pub leaf_der: rustls::pki_types::CertificateDer<'static>,
    pub leaf_key_der: Vec<u8>,
}

pub fn test_ca() -> TestCa {
    use rcgen::{BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(DnType::CommonName, "netstack test CA");
    ca_params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);

    let leaf_key = KeyPair::generate().unwrap();
    let mut leaf_params = CertificateParams::new(vec!["localhost".to_string(), "127.0.0.1".to_string()]).unwrap();
    leaf_params.distinguished_name.push(DnType::CommonName, "localhost");
    leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    leaf_params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    let leaf_cert = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    TestCa {
        ca_pem: ca_cert.pem(),
        leaf_der: leaf_cert.der().clone(),
        leaf_key_der: leaf_key.serialize_der(),
    }
}

fn server_tls_config(ca: &TestCa, alpn: &[&[u8]]) -> rustls::ServerConfig {
    let key = rustls::pki_types::PrivateKeyDer::try_from(ca.leaf_key_der.clone()).unwrap();
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![ca.leaf_der.clone()], key)
        .unwrap();
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    config
}

pub struct TlsTestServer {
    pub port: u16,
    pub state: Arc<ServerState>,
    pub ca_pem: String,
}

impl TlsTestServer {
    /// HTTPS on TCP `127.0.0.1:port`; with `h3`, HTTP/3 on UDP `127.0.0.1:port` as well.
    /// With `advertise_h3`, every response carries `Alt-Svc: h3=":port"`.
    pub fn start(h3: bool, advertise_h3: bool) -> Self {
        let ca = test_ca();
        // Find a port that is free for both TCP and UDP.
        let (tcp, udp) = loop {
            let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = tcp.local_addr().unwrap().port();
            match std::net::UdpSocket::bind(("127.0.0.1", port)) {
                Ok(udp) => break (tcp, udp),
                Err(_) => continue,
            }
        };
        tcp.set_nonblocking(true).unwrap();
        let port = tcp.local_addr().unwrap().port();
        let state = Arc::new(ServerState::default());
        if advertise_h3 {
            *state.alt_svc.lock().unwrap() = Some(format!("h3=\":{port}\"; ma=3600"));
        }
        let tls = Arc::new(server_tls_config(&ca, &[b"h2", b"http/1.1"]));
        let quic_tls = server_tls_config(&ca, &[b"h3"]);
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            server_runtime().block_on(async move {
                if h3 {
                    let quic = quinn::crypto::rustls::QuicServerConfig::try_from(quic_tls).unwrap();
                    let config = quinn::ServerConfig::with_crypto(Arc::new(quic));
                    udp.set_nonblocking(true).unwrap();
                    let endpoint = quinn::Endpoint::new(
                        quinn::EndpointConfig::default(),
                        Some(config),
                        udp,
                        Arc::new(quinn::TokioRuntime),
                    )
                    .unwrap();
                    tokio::spawn(serve_h3(endpoint, Arc::clone(&st)));
                } else {
                    drop(udp);
                }
                let acceptor = tokio_rustls::TlsAcceptor::from(tls);
                let listener = tokio::net::TcpListener::from_std(tcp).unwrap();
                loop {
                    if let Ok((stream, _)) = listener.accept().await {
                        let acceptor = acceptor.clone();
                        let st = Arc::clone(&st);
                        tokio::spawn(async move {
                            if let Ok(tls_stream) = acceptor.accept(stream).await {
                                serve_connection(st, tls_stream);
                            }
                        });
                    }
                }
            });
        });
        TlsTestServer { port, state, ca_pem: ca.ca_pem }
    }

    pub fn url(&self, path: &str) -> String {
        format!("https://127.0.0.1:{}{}", self.port, path)
    }
}

async fn serve_h3(endpoint: quinn::Endpoint, state: Arc<ServerState>) {
    while let Some(incoming) = endpoint.accept().await {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let Ok(conn) = incoming.await else { return };
            let Ok(mut h3_conn) = h3::server::Connection::<_, Bytes>::new(h3_quinn::Connection::new(conn)).await else {
                return;
            };
            while let Ok(Some(resolver)) = h3_conn.accept().await {
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let Ok((req, mut stream)) = resolver.resolve_request().await else { return };
                    let n = state.hit(&format!("h3:{}", req.uri().path()));
                    let mut builder = http::Response::builder().status(200).header("content-type", "text/plain");
                    if let Some(alt) = state.alt_svc.lock().unwrap().clone() {
                        builder = builder.header("alt-svc", alt);
                    }
                    let _ = stream.send_response(builder.body(()).unwrap()).await;
                    let _ = stream.send_data(Bytes::from(format!("hello over h3 #{n}"))).await;
                    let _ = stream.finish().await;
                });
            }
        });
    }
}

pub fn addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}
