//! Cross-platform inter-process communication.
//!
//! Transport: `interprocess` local sockets — named pipes on Windows, Unix-domain
//! sockets on Linux/macOS (the same primitives Chromium's Mojo uses underneath).
//!
//! Wire format: every message is serialized with `postcard` (compact serde format)
//! and framed as `[u32 little-endian length][payload]`.
//!
//! Security: every endpoint carries a random 128-bit token. A client must send the
//! token as the very first frame; the listener drops connections with a wrong token.
//!
//! An *endpoint string* has the form `"<socket-name>#<hex-token>"` and is passed to
//! child processes on the command line (`--ipc=<endpoint>`).

use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, ListenerOptions, Name, RecvHalf, SendHalf, Stream,
    prelude::*,
};
use serde::{Serialize, de::DeserializeOwned};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};

/// Maximum accepted frame size (256 MiB) — protects against corrupt length prefixes.
const MAX_FRAME: usize = 256 * 1024 * 1024;

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS RNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn socket_name(raw: &str) -> io::Result<Name<'static>> {
    if GenericNamespaced::is_supported() {
        raw.to_string().to_ns_name::<GenericNamespaced>()
    } else {
        std::env::temp_dir()
            .join(format!("{raw}.sock"))
            .to_fs_name::<GenericFilePath>()
    }
}

/// A listening endpoint that accepts authenticated connections.
pub struct IpcListener {
    listener: interprocess::local_socket::Listener,
    name: String,
    token: String,
}

impl IpcListener {
    /// Create a listener with a unique random name (the `prefix` is only cosmetic).
    pub fn new(prefix: &str) -> io::Result<Self> {
        let name = format!("{prefix}-{}-{}", std::process::id(), random_hex(8));
        let token = random_hex(16);
        let listener = ListenerOptions::new()
            .name(socket_name(&name)?)
            .try_overwrite(true)
            .create_sync()?;
        Ok(Self {
            listener,
            name,
            token,
        })
    }

    /// Create a listener for a pre-generated endpoint (see [`random_endpoint`]). Used when
    /// the parent must know a child's server endpoint before the child starts (e.g. the
    /// browser hands the network process endpoint to renderers).
    pub fn bind(endpoint: &str) -> io::Result<Self> {
        let (name, token) = endpoint
            .split_once('#')
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad ipc endpoint"))?;
        let listener = ListenerOptions::new()
            .name(socket_name(name)?)
            .try_overwrite(true)
            .create_sync()?;
        Ok(Self {
            listener,
            name: name.to_string(),
            token: token.to_string(),
        })
    }

    /// The endpoint string to hand to a client (`name#token`).
    pub fn endpoint(&self) -> String {
        format!("{}#{}", self.name, self.token)
    }

    /// Block until a client with the correct token connects.
    pub fn accept(&self) -> io::Result<Connection> {
        loop {
            let stream = self.listener.accept()?;
            let (recv, send) = stream.split();
            let mut reader = BufReader::with_capacity(64 * 1024, recv);
            match read_frame(&mut reader) {
                Ok(tok) if tok == self.token.as_bytes() => {
                    return Ok(Connection {
                        reader,
                        writer: BufWriter::with_capacity(64 * 1024, send),
                    });
                }
                _ => {
                    // Wrong token or broken handshake: drop and keep listening.
                    continue;
                }
            }
        }
    }
}

/// Generate a fresh random endpoint string (`name#token`) for [`IpcListener::bind`].
pub fn random_endpoint(prefix: &str) -> String {
    format!("{prefix}-{}-{}#{}", std::process::id(), random_hex(8), random_hex(16))
}

/// [`connect`], retrying until `timeout` while the server is not up yet.
pub fn connect_retry(endpoint: &str, timeout: std::time::Duration) -> io::Result<Connection> {
    let start = std::time::Instant::now();
    let mut delay = std::time::Duration::from_millis(2);
    loop {
        match connect(endpoint) {
            Ok(c) => return Ok(c),
            Err(e) if start.elapsed() >= timeout => return Err(e),
            Err(_) => {
                std::thread::sleep(delay);
                delay = (delay * 2).min(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// Connect to an endpoint produced by [`IpcListener::endpoint`].
pub fn connect(endpoint: &str) -> io::Result<Connection> {
    let (name, token) = endpoint
        .split_once('#')
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad ipc endpoint"))?;
    let stream = Stream::connect(socket_name(name)?)?;
    let (recv, send) = stream.split();
    let mut writer = BufWriter::with_capacity(64 * 1024, send);
    write_frame(&mut writer, token.as_bytes())?;
    writer.flush()?;
    Ok(Connection {
        reader: BufReader::with_capacity(64 * 1024, recv),
        writer,
    })
}

/// An authenticated, not-yet-typed duplex connection.
pub struct Connection {
    reader: BufReader<RecvHalf>,
    writer: BufWriter<SendHalf>,
}

impl Connection {
    /// Turn the connection into a typed sender plus a background reader thread.
    ///
    /// `on_message` is called on the reader thread for every incoming message, and
    /// once with `None` when the peer disconnects (or sends garbage).
    pub fn split<S, R, F>(self, thread_name: &str, mut on_message: F) -> IpcSender<S>
    where
        S: Serialize,
        R: DeserializeOwned + Send + 'static,
        F: FnMut(Option<R>) + Send + 'static,
    {
        let mut reader = self.reader;
        std::thread::Builder::new()
            .name(thread_name.to_string())
            .spawn(move || {
                loop {
                    let frame = match read_frame(&mut reader) {
                        Ok(f) => f,
                        Err(_) => break,
                    };
                    match postcard::from_bytes::<R>(&frame) {
                        Ok(msg) => on_message(Some(msg)),
                        Err(e) => {
                            eprintln!("[ipc] failed to decode message: {e}");
                            break;
                        }
                    }
                }
                on_message(None);
            })
            .expect("failed to spawn ipc reader thread");
        IpcSender {
            inner: Arc::new(Mutex::new(self.writer)),
            _t: PhantomData,
        }
    }

    /// Like [`split`](Self::split) but delivers messages into a crossbeam channel.
    /// The channel disconnects when the peer goes away.
    pub fn split_channel<S, R>(self, thread_name: &str) -> (IpcSender<S>, crossbeam_channel::Receiver<R>)
    where
        S: Serialize,
        R: DeserializeOwned + Send + 'static,
    {
        let (tx, rx) = crossbeam_channel::unbounded();
        let mut tx = Some(tx);
        let sender = self.split(thread_name, move |msg: Option<R>| match msg {
            Some(m) => {
                if let Some(t) = &tx {
                    let _ = t.send(m);
                }
            }
            None => {
                tx.take();
            }
        });
        (sender, rx)
    }
}

/// Typed, cloneable, thread-safe sending half of an IPC connection.
pub struct IpcSender<T> {
    inner: Arc<Mutex<BufWriter<SendHalf>>>,
    _t: PhantomData<fn(T)>,
}

impl<T> Clone for IpcSender<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            _t: PhantomData,
        }
    }
}

impl<T: Serialize> IpcSender<T> {
    pub fn send(&self, msg: &T) -> io::Result<()> {
        let bytes = postcard::to_allocvec(msg)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        let mut w = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        write_frame(&mut *w, &bytes)?;
        w.flush()
    }
}

fn write_frame(w: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(payload)
}

fn read_frame(r: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

/// Spawn a child process of the *same executable* with `--type=<process_type>` and
/// `--ipc=<endpoint>` plus extra args. stdout/stderr are inherited (logs), stdin is null.
pub fn spawn_child(
    process_type: &str,
    endpoint: &str,
    extra_args: &[String],
) -> io::Result<std::process::Child> {
    let exe = std::env::current_exe()?;
    std::process::Command::new(exe)
        .arg(format!("--type={process_type}"))
        .arg(format!("--ipc={endpoint}"))
        .args(extra_args)
        .stdin(std::process::Stdio::null())
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let listener = IpcListener::new("test").unwrap();
        let ep = listener.endpoint();
        let t = std::thread::spawn(move || {
            let conn = connect(&ep).unwrap();
            let (tx, rx) = conn.split_channel::<String, String>("client");
            tx.send(&"hello".to_string()).unwrap();
            rx.recv().unwrap()
        });
        let conn = listener.accept().unwrap();
        let (tx, rx) = conn.split_channel::<String, String>("server");
        assert_eq!(rx.recv().unwrap(), "hello");
        tx.send(&"world".to_string()).unwrap();
        assert_eq!(t.join().unwrap(), "world");
    }
}
