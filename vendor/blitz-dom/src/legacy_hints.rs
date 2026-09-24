//! PATCH: presentational hints of legacy HTML attributes (HTML "Rendering" section):
//! `<table cellspacing cellpadding border align=center>`, `valign`/`nowrap` on cells and
//! rows, and `<font color face size>`. Old-school table layouts (Hacker News, forums,
//! mailing list archives) depend on them: without `cellpadding="0" cellspacing="0"`
//! every cell got the default 1px padding and 2px spacing.
//!
//! The hints are produced as CSS text (parsed like a `style` attribute); attribute values
//! are sanitized so they cannot add other declarations.

use crate::node::Node;
use markup5ever::{local_name, ns};

fn attr<'a>(node: &'a Node, name: &str) -> Option<&'a str> {
    let el = node.element_data()?;
    el.attrs()
        .iter()
        .find(|a| &*a.name.local == name)
        .map(|a| a.value.as_str())
}

/// HTML "rules for parsing non-negative integers" (leading digits, `None` on failure).
fn non_negative_integer(value: &str) -> Option<u32> {
    let digits: String = value
        .trim_start_matches(|c: char| c.is_ascii_whitespace())
        .trim_start_matches('+')
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// The nearest `<table>` of a cell (through its row and row group).
fn cell_table(node: &Node) -> Option<&Node> {
    let mut cur = node.parent.map(|p| node.with(p));
    for _ in 0..3 {
        let n = cur?;
        let el = n.element_data()?;
        if el.name.ns == ns!(html) && el.name.local == local_name!("table") {
            return Some(n);
        }
        if el.name.local == local_name!("td") || el.name.local == local_name!("th") {
            return None;
        }
        cur = n.parent.map(|p| n.with(p));
    }
    None
}

fn table_border(table: &Node) -> Option<u32> {
    attr(table, "border").map(|v| non_negative_integer(v).unwrap_or(1))
}

fn valign(node: &Node, css: &mut String) {
    if let Some(v) = attr(node, "valign") {
        let v = v.trim().to_ascii_lowercase();
        if matches!(v.as_str(), "top" | "middle" | "bottom" | "baseline") {
            css.push_str(&format!("vertical-align:{v};"));
        }
    }
}

/// A legacy color value as CSS: `#rgb`/`#rrggbb`, bare hex digits or a color keyword.
fn legacy_color(value: &str) -> Option<String> {
    let v = value.trim();
    let hex = v.strip_prefix('#').unwrap_or(v);
    if matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(format!("#{hex}"));
    }
    (!v.is_empty() && v.bytes().all(|b| b.is_ascii_alphabetic())).then(|| v.to_string())
}

pub(crate) fn legacy_hints_css(node: &Node) -> String {
    let mut css = String::new();
    let Some(el) = node.element_data() else {
        return css;
    };
    if el.name.ns != ns!(html) {
        return css;
    }
    match &*el.name.local {
        "table" => {
            if let Some(px) = attr(node, "cellspacing").and_then(non_negative_integer) {
                css.push_str(&format!("border-spacing:{px}px;"));
            }
            if let Some(px) = table_border(node).filter(|px| *px > 0) {
                css.push_str(&format!("border:{px}px outset gray;"));
            }
            if attr(node, "align").is_some_and(|v| v.trim().eq_ignore_ascii_case("center")) {
                css.push_str("margin-left:auto;margin-right:auto;");
            }
        }
        "td" | "th" => {
            if let Some(table) = cell_table(node) {
                if let Some(px) = attr(table, "cellpadding").and_then(non_negative_integer) {
                    css.push_str(&format!("padding:{px}px;"));
                }
                if table_border(table).is_some_and(|px| px > 0) {
                    css.push_str("border:1px inset gray;");
                }
            }
            valign(node, &mut css);
            if attr(node, "nowrap").is_some() {
                css.push_str("white-space:nowrap;");
            }
        }
        "tr" | "tbody" | "thead" | "tfoot" => valign(node, &mut css),
        "font" => {
            if let Some(color) = attr(node, "color").and_then(legacy_color) {
                css.push_str(&format!("color:{color};"));
            }
            if let Some(face) = attr(node, "face") {
                let face: String = face
                    .chars()
                    .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | ',' | '-' | '_'))
                    .collect();
                let families: Vec<String> = face
                    .split(',')
                    .map(str::trim)
                    .filter(|f| !f.is_empty())
                    .map(|f| format!("\"{f}\""))
                    .collect();
                if !families.is_empty() {
                    css.push_str(&format!("font-family:{};", families.join(",")));
                }
            }
            if let Some(size) = attr(node, "size") {
                let size = size.trim();
                let (sign, digits) = match size.as_bytes().first() {
                    Some(b'+') => (1, &size[1..]),
                    Some(b'-') => (-1, &size[1..]),
                    _ => (0, size),
                };
                if let Some(n) = non_negative_integer(digits) {
                    let n = n as i64;
                    let level = match sign {
                        0 => n,
                        s => 3 + s * n,
                    }
                    .clamp(1, 7);
                    let keyword = [
                        "x-small", "small", "medium", "large", "x-large", "xx-large", "xxx-large",
                    ][(level - 1) as usize];
                    css.push_str(&format!("font-size:{keyword};"));
                }
            }
        }
        _ => {}
    }
    css
}
