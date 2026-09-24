//! Response body decoding: charset detection (BOM → Content-Type → `<meta>` prescan →
//! UTF-8) and MIME classification.

use encoding_rs::Encoding;

/// What kind of document a response is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Html,
    Xhtml,
    Svg,
    Image,
    Text,
    Other,
}

pub fn classify(content_type: Option<&str>, url: &str, body: &[u8]) -> DocKind {
    let mime = content_type
        .and_then(|c| c.split(';').next())
        .map(|m| m.trim().to_ascii_lowercase())
        .unwrap_or_default();
    match mime.as_str() {
        "text/html" => DocKind::Html,
        "application/xhtml+xml" => DocKind::Xhtml,
        "image/svg+xml" => DocKind::Svg,
        m if m.starts_with("image/") => DocKind::Image,
        "text/plain" | "text/css" | "text/javascript" | "application/javascript"
        | "application/json" | "text/xml" | "application/xml" | "text/csv"
        | "text/markdown" => DocKind::Text,
        m if m.ends_with("+json") || m.ends_with("+xml") => DocKind::Text,
        "" => {
            // No content type: sniff.
            let head = String::from_utf8_lossy(&body[..body.len().min(512)]).to_ascii_lowercase();
            let t = head.trim_start();
            if t.starts_with("<!doctype html") || t.starts_with("<html") || t.contains("<body")
                || t.contains("<head")
            {
                DocKind::Html
            } else if t.starts_with("<svg") || (t.starts_with("<?xml") && t.contains("<svg")) {
                DocKind::Svg
            } else if url.ends_with(".html") || url.ends_with(".htm") || url.ends_with('/') {
                DocKind::Html
            } else if body.starts_with(b"\x89PNG") || body.starts_with(b"\xff\xd8")
                || body.starts_with(b"GIF8") || (body.len() > 12 && &body[8..12] == b"WEBP")
            {
                DocKind::Image
            } else {
                DocKind::Text
            }
        }
        _ => DocKind::Other,
    }
}

fn charset_from_content_type(ct: &str) -> Option<&'static Encoding> {
    ct.split(';').skip(1).find_map(|p| {
        let (k, v) = p.split_once('=')?;
        if k.trim().eq_ignore_ascii_case("charset") {
            Encoding::for_label(v.trim().trim_matches('"').as_bytes())
        } else {
            None
        }
    })
}

/// Look for `<meta charset>` / `<meta http-equiv content="...charset=...">` in the first
/// 1024 bytes (simplified HTML prescan).
fn prescan_meta(body: &[u8]) -> Option<&'static Encoding> {
    let head = &body[..body.len().min(1024)];
    let s = String::from_utf8_lossy(head).to_ascii_lowercase();
    let mut rest = s.as_str();
    while let Some(pos) = rest.find("<meta") {
        rest = &rest[pos + 5..];
        let end = rest.find('>').unwrap_or(rest.len());
        let tag = &rest[..end];
        if let Some(i) = tag.find("charset") {
            let after = tag[i + 7..].trim_start();
            if let Some(after) = after.strip_prefix('=') {
                let v = after.trim_start().trim_start_matches(['"', '\'']);
                let v_end = v
                    .find(|c: char| c == '"' || c == '\'' || c == ';' || c.is_whitespace() || c == '/')
                    .unwrap_or(v.len());
                if let Some(enc) = Encoding::for_label(v[..v_end].as_bytes()) {
                    // A UTF-16 label in a meta tag means UTF-8 (spec).
                    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
                        return Some(encoding_rs::UTF_8);
                    }
                    return Some(enc);
                }
            }
        }
    }
    None
}

/// Decode an HTML (or text) body to a String.
pub fn decode_body(body: &[u8], content_type: Option<&str>) -> String {
    if let Some((enc, bom_len)) = Encoding::for_bom(body) {
        let (s, _) = enc.decode_without_bom_handling(&body[bom_len..]);
        return s.into_owned();
    }
    let enc = content_type
        .and_then(charset_from_content_type)
        .or_else(|| prescan_meta(body))
        .unwrap_or(encoding_rs::UTF_8);
    let (s, _, _) = enc.decode(body);
    s.into_owned()
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meta_charset() {
        let html = b"<html><head><meta charset=\"windows-1252\"></head><body>\xe4</body></html>";
        assert!(decode_body(html, None).contains('ä'));
        let html = b"<meta http-equiv=\"Content-Type\" content=\"text/html; charset=iso-8859-1\">\xfc";
        assert!(decode_body(html, None).contains('ü'));
        assert_eq!(decode_body("ä".as_bytes(), Some("text/html; charset=utf-8")), "ä");
    }
}
