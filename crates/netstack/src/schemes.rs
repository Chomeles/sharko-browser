//! Non-HTTP schemes: `data:` (RFC 2397 as refined by the Fetch spec), `file:` and
//! `about:blank`.

use crate::error::NetError;
use crate::util::{MAX_BODY_BYTES, Response, html_escape};
use bytes::Bytes;
use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use std::path::Path;
use std::time::SystemTime;
use url::Url;

/// Characters escaped in the `href` of directory listing entries (a path segment).
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

fn header(name: &str, value: impl Into<String>) -> (String, String) {
    (name.to_owned(), value.into())
}

/// `about:blank` is an empty HTML document; other `about:` URLs are unsupported.
pub(crate) fn about(url: &Url) -> Result<Response, NetError> {
    if url.path() == "blank" {
        Ok(Response::local(
            url.to_string(),
            vec![header("content-type", "text/html;charset=utf-8")],
            Bytes::new(),
        ))
    } else {
        Err(NetError::invalid_url(format!("unsupported about: URL `{url}`")))
    }
}

/// Decodes a `data:` URL (base64 and percent-encoding, MIME type and charset).
///
/// Uses Servo's `data-url` crate, which implements the Fetch spec's data: URL processor
/// (forgiving base64, `text/plain;charset=US-ASCII` default, fragment stripping).
pub(crate) fn data(url: &Url) -> Result<Response, NetError> {
    let parsed = data_url::DataUrl::process(url.as_str())
        .map_err(|e| NetError::invalid_url(format!("malformed data: URL ({e})")))?;
    let (body, _fragment) = parsed
        .decode_to_vec()
        .map_err(|e| NetError::invalid_url(format!("invalid base64 in data: URL ({e:?})")))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(NetError::too_big());
    }
    let headers = vec![
        header("content-type", parsed.mime_type().to_string()),
        header("content-length", body.len().to_string()),
    ];
    Ok(Response::local(url.to_string(), headers, Bytes::from(body)))
}

/// Reads a `file:` URL on the blocking thread pool. Directories produce an HTML listing.
pub(crate) async fn file(url: Url, head_only: bool) -> Result<Response, NetError> {
    tokio::task::spawn_blocking(move || file_blocking(&url, head_only))
        .await
        .map_err(|e| NetError::new("ERR_FAILED", format!("file task failed: {e}")))?
}

fn file_blocking(url: &Url, head_only: bool) -> Result<Response, NetError> {
    let path = url
        .to_file_path()
        .map_err(|_| NetError::invalid_url(format!("`{url}` is not a local file URL")))?;
    let meta = std::fs::metadata(&path)
        .map_err(|e| NetError::from_io(&e, &path.display().to_string()))?;
    if meta.is_dir() {
        return directory_listing(url, &path);
    }
    let len = meta.len();
    if len > MAX_BODY_BYTES as u64 {
        return Err(NetError::too_big());
    }
    let mime = mime_guess::from_path(&path)
        .first_raw()
        .unwrap_or("application/octet-stream");
    let mut headers = vec![header("content-type", mime), header("content-length", len.to_string())];
    if let Ok(modified) = meta.modified() {
        headers.push(header("last-modified", httpdate::fmt_http_date(modified)));
    }
    let body = if head_only {
        Bytes::new()
    } else {
        Bytes::from(
            std::fs::read(&path).map_err(|e| NetError::from_io(&e, &path.display().to_string()))?,
        )
    };
    Ok(Response::local(url.to_string(), headers, body))
}

struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
    modified: Option<SystemTime>,
}

fn directory_listing(url: &Url, path: &Path) -> Result<Response, NetError> {
    let read = std::fs::read_dir(path).map_err(|e| NetError::from_io(&e, &path.display().to_string()))?;
    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Follow symlinks so that linked directories are listed as directories.
            let meta = std::fs::metadata(entry.path()).or_else(|_| entry.metadata()).ok();
            DirEntry {
                name,
                is_dir: meta.as_ref().is_some_and(|m| m.is_dir()),
                size: meta.as_ref().map_or(0, |m| m.len()),
                modified: meta.and_then(|m| m.modified().ok()),
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    // Directory URLs end with '/', so that relative links resolve inside the directory.
    let mut final_url = url.clone();
    if !final_url.path().ends_with('/') {
        let p = format!("{}/", url.path());
        final_url.set_path(&p);
    }
    let display_path = percent_decode_str(final_url.path()).decode_utf8_lossy().into_owned();
    let title = html_escape(&display_path);
    let mut html = String::with_capacity(512 + entries.len() * 160);
    html.push_str("<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>Index of ");
    html.push_str(&title);
    html.push_str(
        "</title><style>body{font-family:sans-serif;margin:2em}td{padding:0 1.5em 0 0}\
         td.s,td.m{color:#666;white-space:nowrap}</style></head><body>\n<h1>Index of ",
    );
    html.push_str(&title);
    html.push_str("</h1>\n<table>\n");
    let is_root = path.parent().is_none();
    if !is_root {
        html.push_str("<tr><td><a href=\"../\">../</a></td><td class=\"s\"></td><td class=\"m\"></td></tr>\n");
    }
    for e in &entries {
        let href = utf8_percent_encode(&e.name, SEGMENT).to_string();
        let slash = if e.is_dir { "/" } else { "" };
        let size = if e.is_dir { String::new() } else { format_size(e.size) };
        let modified = e.modified.map(httpdate::fmt_http_date).unwrap_or_default();
        html.push_str(&format!(
            "<tr><td><a href=\"{href}{slash}\">{}{slash}</a></td><td class=\"s\">{size}</td><td class=\"m\">{}</td></tr>\n",
            html_escape(&e.name),
            html_escape(&modified),
        ));
    }
    html.push_str("</table>\n</body></html>\n");
    let headers = vec![
        header("content-type", "text/html;charset=utf-8"),
        header("content-length", html.len().to_string()),
    ];
    Ok(Response::local(final_url.to_string(), headers, Bytes::from(html)))
}

fn format_size(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut v = n as f64;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::find_header;

    fn data_of(s: &str) -> Response {
        data(&Url::parse(s).unwrap()).unwrap()
    }

    #[test]
    fn data_plain_default_mime() {
        let r = data_of("data:,Hello%2C%20World%21");
        assert_eq!(&r.body[..], b"Hello, World!");
        assert_eq!(find_header(&r.headers, "content-type"), Some("text/plain;charset=US-ASCII"));
        assert_eq!(r.status, 200);
    }

    #[test]
    fn data_base64_with_charset() {
        let r = data_of("data:text/html;charset=utf-8;base64,PGI+aMOkPC9iPg==");
        assert_eq!(std::str::from_utf8(&r.body).unwrap(), "<b>hä</b>");
        assert_eq!(find_header(&r.headers, "content-type"), Some("text/html;charset=utf-8"));
    }

    #[test]
    fn data_forgiving_base64_and_fragment() {
        // Whitespace inside base64 is ignored, missing padding is fine, fragment stripped.
        let r = data_of("data:application/octet-stream;base64,AQID%20BA#frag");
        assert_eq!(&r.body[..], &[1, 2, 3, 4]);
        assert_eq!(find_header(&r.headers, "content-type"), Some("application/octet-stream"));
    }

    #[test]
    fn data_percent_decoding_binary() {
        let r = data_of("data:image/svg+xml,%3Csvg%20xmlns%3D%22a%22%2F%3E");
        assert_eq!(&r.body[..], br#"<svg xmlns="a"/>"#);
        assert_eq!(find_header(&r.headers, "content-type"), Some("image/svg+xml"));
    }

    #[test]
    fn data_invalid_base64_is_error() {
        let e = data(&Url::parse("data:;base64,@@@").unwrap()).unwrap_err();
        assert_eq!(e.code(), "ERR_INVALID_URL");
    }

    #[test]
    fn about_blank() {
        let r = about(&Url::parse("about:blank").unwrap()).unwrap();
        assert!(r.body.is_empty());
        assert_eq!(find_header(&r.headers, "content-type"), Some("text/html;charset=utf-8"));
        assert!(about(&Url::parse("about:config").unwrap()).is_err());
    }

    #[test]
    fn file_and_directory_listing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a b.html"), "<p>x</p>").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let file_url = Url::from_file_path(dir.path().join("a b.html")).unwrap();
        let r = file_blocking(&file_url, false).unwrap();
        assert_eq!(&r.body[..], b"<p>x</p>");
        assert_eq!(find_header(&r.headers, "content-type"), Some("text/html"));

        let dir_url = Url::from_directory_path(dir.path()).unwrap();
        let mut no_slash = dir_url.clone();
        no_slash.set_path(dir_url.path().trim_end_matches('/'));
        let listing = file_blocking(&no_slash, false).unwrap();
        assert!(listing.url.ends_with('/'));
        let html = std::str::from_utf8(&listing.body).unwrap();
        assert!(html.contains("href=\"a%20b.html\""), "{html}");
        assert!(html.contains("href=\"sub/\""), "{html}");
        // Directories are listed first.
        assert!(html.find("sub/").unwrap() < html.find("a b.html").unwrap());

        let missing = Url::from_file_path(dir.path().join("nope.txt")).unwrap();
        assert_eq!(file_blocking(&missing, false).unwrap_err().code(), "ERR_FILE_NOT_FOUND");
    }
}
