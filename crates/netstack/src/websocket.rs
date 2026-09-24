//! WebSocket connections (RFC 6455) for the page's `WebSocket` API.
//!
//! The opening handshake is an HTTP/1.1 `Upgrade` request sent through a dedicated
//! HTTP/1-only client that shares the fetch client's TLS roots and proxy rules (so
//! `wss:` works behind the same proxies), with the page's cookies. The upgraded stream is
//! then driven by tungstenite. Each socket is one task; commands (send / close) arrive on
//! a channel and events are reported in order through a callback.

use std::sync::Arc;
use std::time::Duration;

use common::protocol::{WsData, WsEvent};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use url::Url;

use crate::config::NetConfig;
use crate::core::NetworkCore;

/// Commands from the page for an open (or opening) socket.
#[derive(Debug)]
pub(crate) enum WsCommand {
    Send(WsData),
    Close { code: Option<u16>, reason: String },
}

/// Parameters of `new WebSocket(url, protocols)`.
#[derive(Debug, Clone)]
pub(crate) struct WsOpen {
    pub url: String,
    pub protocols: Vec<String>,
    pub origin: String,
}

/// How long the opening handshake (connect + TLS + HTTP exchange) may take.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for the server's Close frame after sending ours.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// Chrome's limit for a single message.
const MAX_MESSAGE: usize = 64 << 20;

type Socket = WebSocketStream<reqwest::Upgraded>;

pub(crate) fn build_ws_client(config: &NetConfig) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(config.user_agent.clone())
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .connect_timeout(config.connect_timeout)
        .tcp_nodelay(true)
        // The upgraded connection belongs to the socket; never pool it.
        .pool_max_idle_per_host(0)
        .http1_only();
    if !config.extra_root_certificates_pem.is_empty() {
        let mut certs = Vec::new();
        for pem in &config.extra_root_certificates_pem {
            certs.extend(
                reqwest::Certificate::from_pem_bundle(pem)
                    .map_err(|e| format!("invalid extra root certificate: {e}"))?,
            );
        }
        builder = builder.tls_certs_merge(certs);
    }
    builder
        .build()
        .map_err(|e| format!("cannot initialize WebSocket client: {e}"))
}

fn close_code(frame: &Option<CloseFrame>) -> (u16, String) {
    match frame {
        Some(f) => (u16::from(f.code), f.reason.to_string()),
        // "No status received".
        None => (1005, String::new()),
    }
}

impl NetworkCore {
    /// Runs one WebSocket until it is closed. `emit` is called in order and ends with
    /// exactly one [`WsEvent::Closed`].
    pub(crate) async fn websocket(
        self: Arc<Self>,
        open: WsOpen,
        mut commands: mpsc::UnboundedReceiver<WsCommand>,
        emit: impl Fn(WsEvent) + Send,
    ) {
        let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, self.ws_handshake(&open));
        // A close() before the connection is established aborts it.
        let result = tokio::select! {
            r = handshake => r.unwrap_or_else(|_| Err("WebSocket opening handshake timed out".into())),
            _ = wait_for_close(&mut commands) => {
                emit(WsEvent::Closed { code: 1006, reason: String::new(), clean: false });
                return;
            }
        };
        let (socket, protocol, extensions) = match result {
            Ok(r) => r,
            Err(e) => {
                emit(WsEvent::Error(e));
                emit(WsEvent::Closed { code: 1006, reason: String::new(), clean: false });
                return;
            }
        };
        emit(WsEvent::Open { protocol, extensions });
        run_socket(socket, commands, &emit).await;
    }

    async fn ws_handshake(&self, open: &WsOpen) -> Result<(Socket, String, String), String> {
        let mut url = Url::parse(open.url.trim()).map_err(|e| format!("invalid URL: {e}"))?;
        let http_scheme = match url.scheme() {
            "ws" | "http" => "http",
            "wss" | "https" => "https",
            other => return Err(format!("unsupported scheme `{other}`")),
        };
        url.set_scheme(http_scheme).map_err(|_| "invalid URL".to_string())?;
        url.set_fragment(None);

        let client = self.ws_client()?;
        let key = generate_key();
        let mut request = client
            .get(url.as_str())
            .version(http::Version::HTTP_11)
            .header(http::header::CONNECTION, "Upgrade")
            .header(http::header::UPGRADE, "websocket")
            .header(http::header::SEC_WEBSOCKET_VERSION, "13")
            .header(http::header::SEC_WEBSOCKET_KEY, &key)
            .header(http::header::PRAGMA, "no-cache")
            .header(http::header::CACHE_CONTROL, "no-cache")
            .header(http::header::ACCEPT_LANGUAGE, &self.config.accept_language);
        if !open.origin.is_empty() && open.origin != "null" {
            request = request.header(http::header::ORIGIN, &open.origin);
        }
        if !open.protocols.is_empty() {
            request = request.header(http::header::SEC_WEBSOCKET_PROTOCOL, open.protocols.join(", "));
        }
        if let Some(cookie) = self.cookies.request_header(&url) {
            request = request.header(http::header::COOKIE, cookie);
        }
        let response = request
            .send()
            .await
            .map_err(|e| format!("Error in connection establishment: {}", crate::error::NetError::from_reqwest(&e)))?;
        if self.cookies.store_response(&url, response.headers()) {
            self.cookie_saver.trigger();
        }
        if response.status() != http::StatusCode::SWITCHING_PROTOCOLS {
            return Err(format!(
                "Error during WebSocket handshake: Unexpected response code: {}",
                response.status().as_u16()
            ));
        }
        let header = |name: http::header::HeaderName| {
            response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        if !header(http::header::UPGRADE).eq_ignore_ascii_case("websocket") {
            return Err("Error during WebSocket handshake: 'Upgrade' header is missing".into());
        }
        if header(http::header::SEC_WEBSOCKET_ACCEPT) != derive_accept_key(key.as_bytes()) {
            return Err("Error during WebSocket handshake: Incorrect 'Sec-WebSocket-Accept' header value".into());
        }
        let protocol = header(http::header::SEC_WEBSOCKET_PROTOCOL);
        if !protocol.is_empty() && !open.protocols.iter().any(|p| *p == protocol) {
            return Err("Error during WebSocket handshake: 'Sec-WebSocket-Protocol' header value is not one of the requested values".into());
        }
        if protocol.is_empty() && !open.protocols.is_empty() {
            return Err("Error during WebSocket handshake: Sent non-empty 'Sec-WebSocket-Protocol' header but no response was received".into());
        }
        // No extensions are offered, so none may be accepted.
        let extensions = header(http::header::SEC_WEBSOCKET_EXTENSIONS);
        if !extensions.is_empty() {
            return Err(format!(
                "Error during WebSocket handshake: Unexpected extension '{extensions}'"
            ));
        }
        let upgraded = response
            .upgrade()
            .await
            .map_err(|e| format!("WebSocket upgrade failed: {e}"))?;
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(MAX_MESSAGE);
        config.max_frame_size = Some(MAX_MESSAGE);
        let socket = WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await;
        Ok((socket, protocol, extensions))
    }

    fn ws_client(&self) -> Result<reqwest::Client, String> {
        let mut slot = self.ws_client.lock();
        if let Some(client) = slot.as_ref() {
            return Ok(client.clone());
        }
        let client = build_ws_client(&self.config)?;
        *slot = Some(client.clone());
        Ok(client)
    }
}

/// Waits until the page asks to close (or goes away). Sends are dropped: the socket is
/// not open yet, and the page's `send()` throws in that state anyway.
async fn wait_for_close(commands: &mut mpsc::UnboundedReceiver<WsCommand>) {
    loop {
        match commands.recv().await {
            Some(WsCommand::Close { .. }) | None => return,
            Some(WsCommand::Send(_)) => {}
        }
    }
}

async fn run_socket(
    socket: Socket,
    mut commands: mpsc::UnboundedReceiver<WsCommand>,
    emit: &(impl Fn(WsEvent) + Send),
) {
    let (mut sink, mut stream) = socket.split();
    // Set once our Close frame is sent: then only the server's Close (or a timeout) ends it.
    let mut closing: Option<(u16, String)> = None;
    // Armed when our Close frame goes out.
    let close_deadline = tokio::time::sleep(Duration::from_secs(365 * 24 * 3600));
    tokio::pin!(close_deadline);
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => emit(WsEvent::Message(WsData::Text(text.to_string()))),
                Some(Ok(Message::Binary(bytes))) => emit(WsEvent::Message(WsData::Binary(bytes.to_vec()))),
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    // tungstenite echoes the Close frame; flush it before reporting.
                    let _ = sink.flush().await;
                    let (code, reason) = match (&frame, &closing) {
                        (None, Some((code, reason))) => (*code, reason.clone()),
                        _ => close_code(&frame),
                    };
                    emit(WsEvent::Closed { code, reason, clean: true });
                    return;
                }
                Some(Err(WsError::ConnectionClosed | WsError::AlreadyClosed)) | None => {
                    let clean = closing.is_some();
                    let (code, reason) = closing.clone().unwrap_or((1006, String::new()));
                    emit(WsEvent::Closed { code, reason, clean });
                    return;
                }
                Some(Err(e)) => {
                    emit(WsEvent::Error(e.to_string()));
                    emit(WsEvent::Closed { code: 1006, reason: String::new(), clean: false });
                    return;
                }
            },
            command = commands.recv(), if closing.is_none() => match command {
                Some(WsCommand::Send(data)) => {
                    let (message, len) = match data {
                        WsData::Text(text) => {
                            let len = text.len() as u64;
                            (Message::Text(text.into()), len)
                        }
                        WsData::Binary(bytes) => {
                            let len = bytes.len() as u64;
                            (Message::Binary(bytes.into()), len)
                        }
                    };
                    if let Err(e) = sink.send(message).await {
                        emit(WsEvent::Error(e.to_string()));
                        emit(WsEvent::Closed { code: 1006, reason: String::new(), clean: false });
                        return;
                    }
                    emit(WsEvent::Sent(len));
                }
                Some(WsCommand::Close { code, reason }) => {
                    let frame = code.map(|code| CloseFrame {
                        code: CloseCode::from(code),
                        reason: reason.clone().into(),
                    });
                    closing = Some((code.unwrap_or(1005), reason));
                    let _ = sink.send(Message::Close(frame)).await;
                    close_deadline
                        .as_mut()
                        .reset(tokio::time::Instant::now() + CLOSE_TIMEOUT);
                }
                // The page is gone: close politely without waiting.
                None => {
                    let _ = sink.send(Message::Close(Some(CloseFrame {
                        code: CloseCode::Away,
                        reason: "".into(),
                    })))
                    .await;
                    return;
                }
            },
            _ = &mut close_deadline, if closing.is_some() => {
                let (code, reason) = closing.clone().unwrap_or((1006, String::new()));
                emit(WsEvent::Closed { code, reason, clean: false });
                return;
            }
        }
    }
}
