//! Small helpers shared by the modules.

use bytes::Bytes;
use http::{HeaderMap, Version};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Maximum body size delivered to clients.
///
/// The IPC transport rejects frames above 256 MiB, and bodies travel in a single frame,
/// so larger responses fail early with `net::ERR_FILE_TOO_BIG` instead.
pub(crate) const MAX_BODY_BYTES: usize = 240 * 1024 * 1024;

/// Internal, scheme-independent response representation.
///
/// Bodies are reference-counted [`Bytes`] so cache hits and IPC serialization don't copy.
#[derive(Clone, Debug)]
pub(crate) struct Response {
    pub status: u16,
    /// Final URL (after redirects), including the fragment of the request URL.
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Bytes,
    pub from_cache: bool,
    /// `"HTTP/1.1"`, `"HTTP/2"`, `"HTTP/3"`, ... or `""` for non-HTTP schemes.
    pub http_version: &'static str,
}

impl Response {
    /// A `200 OK` response for non-HTTP schemes.
    pub fn local(url: String, headers: Vec<(String, String)>, body: Bytes) -> Self {
        Self {
            status: 200,
            url,
            headers,
            body,
            from_cache: false,
            http_version: "",
        }
    }
}

/// Canonical reason phrase of a status code (`""` for unknown codes).
pub(crate) fn status_text(status: u16) -> &'static str {
    http::StatusCode::from_u16(status)
        .ok()
        .and_then(|s| s.canonical_reason())
        .unwrap_or("")
}

/// Protocol string as exposed in [`NetResponse::http_version`](common::protocol::NetResponse).
pub(crate) fn version_str(v: Version) -> &'static str {
    match v {
        Version::HTTP_09 => "HTTP/0.9",
        Version::HTTP_10 => "HTTP/1.0",
        Version::HTTP_11 => "HTTP/1.1",
        Version::HTTP_2 => "HTTP/2",
        Version::HTTP_3 => "HTTP/3",
        _ => "",
    }
}

/// Maps a stored protocol string back to its `'static` form.
pub(crate) fn intern_version(s: &str) -> &'static str {
    match s {
        "HTTP/0.9" => "HTTP/0.9",
        "HTTP/1.0" => "HTTP/1.0",
        "HTTP/1.1" => "HTTP/1.1",
        "HTTP/2" => "HTTP/2",
        "HTTP/3" => "HTTP/3",
        _ => "",
    }
}

/// Response header names that are never exposed to clients.
pub(crate) fn is_hidden_response_header(name: &str) -> bool {
    name.eq_ignore_ascii_case("set-cookie") || name.eq_ignore_ascii_case("set-cookie2")
}

/// Converts a header map into the ordered `(name, value)` list of the protocol, dropping
/// `Set-Cookie`. Non-UTF-8 values are converted lossily.
pub(crate) fn headers_to_vec(map: &HeaderMap) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(map.len());
    for (name, value) in map {
        let name = name.as_str();
        if is_hidden_response_header(name) {
            continue;
        }
        let value = match value.to_str() {
            Ok(v) => v.to_owned(),
            Err(_) => String::from_utf8_lossy(value.as_bytes()).into_owned(),
        };
        out.push((name.to_owned(), value));
    }
    out
}

/// First value of header `name` (case-insensitive) in a header list.
pub(crate) fn find_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// All values of header `name` (case-insensitive) in a header list.
pub(crate) fn find_headers<'a>(
    headers: &'a [(String, String)],
    name: &'a str,
) -> impl Iterator<Item = &'a str> + 'a {
    headers
        .iter()
        .filter(move |(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

pub(crate) fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

pub(crate) fn from_unix_ms(ms: u64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms)
}

/// Writes `data` to `path` atomically (temp file + rename), creating parent directories.
/// With `durable`, the data is fsync'ed before the rename.
pub(crate) fn write_atomic(path: &Path, data: &[u8], durable: bool) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    std::fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let tmp = dir.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        if durable {
            f.sync_all()?;
        }
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Single chunks at least this large are kept zero-copy.
const ZERO_COPY_MIN: usize = 64 * 1024;

/// Concatenates body chunks with at most one copy.
///
/// A small single chunk is copied too: it is usually a slice of the connection's read
/// buffer, and keeping it (e.g. in the memory cache) would pin that whole buffer.
pub(crate) fn concat_chunks(mut chunks: Vec<Bytes>, total: usize) -> Bytes {
    match chunks.len() {
        0 => Bytes::new(),
        1 if total >= ZERO_COPY_MIN => chunks.pop().unwrap_or_default(),
        _ => {
            let mut buf = Vec::with_capacity(total);
            for c in &chunks {
                buf.extend_from_slice(c);
            }
            Bytes::from(buf)
        }
    }
}

/// Escapes text for inclusion in HTML.
pub(crate) fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_texts() {
        assert_eq!(status_text(200), "OK");
        assert_eq!(status_text(404), "Not Found");
        assert_eq!(status_text(799), "");
    }

    #[test]
    fn concat() {
        let one = concat_chunks(vec![Bytes::from_static(b"abc")], 3);
        assert_eq!(&one[..], b"abc");
        let many = concat_chunks(
            vec![Bytes::from_static(b"ab"), Bytes::from_static(b"cd")],
            4,
        );
        assert_eq!(&many[..], b"abcd");
        assert!(concat_chunks(Vec::new(), 0).is_empty());
    }

    #[test]
    fn atomic_write_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub").join("f.json");
        write_atomic(&p, b"one", true).unwrap();
        write_atomic(&p, b"two", false).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        // No temp files left behind.
        assert_eq!(std::fs::read_dir(p.parent().unwrap()).unwrap().count(), 1);
    }
}
