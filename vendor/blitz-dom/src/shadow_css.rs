//! PATCH: style scoping for shadow trees (ShadyCSS-style emulation).
//!
//! Blitz has no real shadow DOM: shadow content is rendered as the host's children (see
//! `crates/script/js/README.md`). Without scoping, a `<style>` inside a shadow root would
//! apply to the whole document and break the page (e.g. `a { display: grid }` from a
//! web component). So stylesheets inside a shadow host are rewritten before parsing:
//!
//! * every selector is prefixed with the host: `.x a` → `[HOST] .x a`
//! * `:host` → `[HOST]`, `:host(X)` → `[HOST]:is(X)`, `:host-context(X)` → `:is(X) [HOST]`
//! * `::slotted(X)` → `slot > :is(X)` (slotted nodes are moved into their `<slot>`)
//!
//! `[HOST]` is `[sharko-shadow-host="<node id>"]`, a virtual attribute matched by the
//! Stylo element implementation for nodes flagged `IS_SHADOW_HOST` (it is not stored in
//! the attribute list, so scripts and serialization never see it).

/// Name of the virtual attribute carried by shadow hosts.
pub const SHADOW_HOST_ATTR: &str = "sharko-shadow-host";

/// Rewrite a stylesheet from the shadow tree of the host with the given key.
pub fn scope_shadow_css(css: &str, host_key: &str) -> String {
    let host = format!("[{SHADOW_HOST_ATTR}=\"{host_key}\"]");
    let mut out = String::with_capacity(css.len() + css.len() / 4);
    rewrite_rule_list(css, &host, &mut out);
    out
}

/// At-rules whose block is a list of rules (rewritten recursively).
const GROUP_RULES: &[&str] = &["media", "supports", "layer", "container", "document", "-moz-document", "scope", "starting-style"];

fn rewrite_rule_list(input: &str, host: &str, out: &mut String) {
    let b = input.as_bytes();
    let mut i = 0;
    while i < b.len() {
        // Whitespace and comments are copied.
        let c = b[i];
        if c.is_ascii_whitespace() {
            out.push(c as char);
            i += 1;
            continue;
        }
        if b[i..].starts_with(b"/*") {
            let end = find_comment_end(b, i);
            out.push_str(&input[i..end]);
            i = end;
            continue;
        }
        if c == b'}' || c == b';' {
            // Stray token (invalid CSS): copy.
            out.push(c as char);
            i += 1;
            continue;
        }
        // Prelude up to `{` or `;` at nesting depth 0.
        let (stop, stop_char) = scan_prelude(b, i);
        let prelude = &input[i..stop];
        if stop_char != Some(b'{') {
            // Statement at-rule (`@import …;`) or garbage at EOF. An imported sheet is
            // fetched and parsed separately, so its rules could not be scoped and would
            // apply to the whole document: `@import` is dropped instead.
            if prelude.trim_start().get(..7).is_some_and(|p| p.eq_ignore_ascii_case("@import")) {
                i = if stop_char == Some(b';') { stop + 1 } else { stop };
                continue;
            }
            out.push_str(&input[i..stop.min(b.len())]);
            if stop_char == Some(b';') {
                out.push(';');
                i = stop + 1;
            } else {
                i = stop;
            }
            continue;
        }
        let body_start = stop + 1;
        let body_end = find_block_end(b, body_start);
        let body = &input[body_start..body_end.min(b.len())];
        if let Some(at) = prelude.strip_prefix('@') {
            let name: String = at
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect::<String>()
                .to_ascii_lowercase();
            out.push_str(prelude);
            out.push('{');
            if GROUP_RULES.contains(&name.as_str()) {
                rewrite_rule_list(body, host, out);
            } else {
                out.push_str(body);
            }
        } else {
            out.push_str(&rewrite_selector_list(prelude, host));
            out.push('{');
            out.push_str(body);
        }
        if body_end < b.len() {
            out.push('}');
        }
        i = body_end + 1;
    }
}

fn find_comment_end(b: &[u8], start: usize) -> usize {
    let mut j = start + 2;
    while j + 1 < b.len() {
        if b[j] == b'*' && b[j + 1] == b'/' {
            return j + 2;
        }
        j += 1;
    }
    b.len()
}

/// End of a quoted string starting at `start` (the quote), exclusive.
fn skip_string(b: &[u8], start: usize) -> usize {
    let q = b[start];
    let mut j = start + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            c if c == q => return j + 1,
            b'\n' => return j,
            _ => j += 1,
        }
    }
    b.len()
}

/// Scan a prelude from `start` to the first `{` or `;` outside of parentheses,
/// brackets, strings and comments. Returns the stop index and the stop byte.
fn scan_prelude(b: &[u8], start: usize) -> (usize, Option<u8>) {
    let mut depth = 0i32;
    let mut j = start;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' | b'\'' => j = skip_string(b, j),
            b'/' if b.get(j + 1) == Some(&b'*') => j = find_comment_end(b, j),
            b'(' | b'[' => {
                depth += 1;
                j += 1
            }
            b')' | b']' => {
                depth -= 1;
                j += 1
            }
            c @ (b'{' | b';') if depth <= 0 => return (j, Some(c)),
            _ => j += 1,
        }
    }
    (b.len(), None)
}

/// Index of the `}` closing the block whose content starts at `start`.
fn find_block_end(b: &[u8], start: usize) -> usize {
    let mut depth = 1i32;
    let mut j = start;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' | b'\'' => j = skip_string(b, j),
            b'/' if b.get(j + 1) == Some(&b'*') => j = find_comment_end(b, j),
            b'{' => {
                depth += 1;
                j += 1
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return j;
                }
                j += 1
            }
            _ => j += 1,
        }
    }
    b.len()
}

/// Split at top-level commas.
fn split_selectors(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut last = 0;
    let mut j = 0;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' | b'\'' => j = skip_string(b, j),
            b'(' | b'[' => {
                depth += 1;
                j += 1
            }
            b')' | b']' => {
                depth -= 1;
                j += 1
            }
            b',' if depth == 0 => {
                parts.push(&s[last..j]);
                j += 1;
                last = j;
            }
            _ => j += 1,
        }
    }
    parts.push(&s[last.min(s.len())..]);
    parts
}

/// The argument of a functional pseudo starting at `open` (index of `(`): returns the
/// argument and the index after the closing parenthesis.
fn functional_arg(s: &str, open: usize) -> (&str, usize) {
    let b = s.as_bytes();
    let mut depth = 0i32;
    let mut j = open;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 2,
            b'"' | b'\'' => j = skip_string(b, j),
            b'(' => {
                depth += 1;
                j += 1
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return (&s[open + 1..j], j + 1);
                }
                j += 1
            }
            _ => j += 1,
        }
    }
    (&s[(open + 1).min(s.len())..], s.len())
}

fn is_ident_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c >= 0x80
}

fn rewrite_selector_list(prelude: &str, host: &str) -> String {
    let mut out = String::with_capacity(prelude.len() + 32);
    for (n, sel) in split_selectors(prelude).into_iter().enumerate() {
        if n > 0 {
            out.push(',');
        }
        let trimmed = sel.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (rewritten, mentions_host) = rewrite_complex(trimmed, host);
        if !mentions_host {
            out.push_str(host);
            out.push(' ');
        }
        out.push_str(&rewritten);
    }
    out
}

/// Rewrite `:host…` and `::slotted()` in one complex selector.
fn rewrite_complex(sel: &str, host: &str) -> (String, bool) {
    let b = sel.as_bytes();
    let mut out = String::with_capacity(sel.len() + 16);
    let mut mentions_host = false;
    let mut j = 0;
    // Whether the current compound selector is empty so far.
    let mut compound_empty = true;
    while j < b.len() {
        match b[j] {
            b'\\' => {
                let end = (j + 2).min(b.len());
                out.push_str(&sel[j..end]);
                j = end;
                compound_empty = false;
            }
            b'"' | b'\'' => {
                let end = skip_string(b, j);
                out.push_str(&sel[j..end]);
                j = end;
            }
            b'[' => {
                // Copy attribute selectors verbatim.
                let mut k = j;
                while k < b.len() && b[k] != b']' {
                    k = if b[k] == b'"' || b[k] == b'\'' { skip_string(b, k) } else { k + 1 };
                }
                let end = (k + 1).min(b.len());
                out.push_str(&sel[j..end]);
                j = end;
                compound_empty = false;
            }
            c if c.is_ascii_whitespace() || c == b'>' || c == b'+' || c == b'~' => {
                out.push(c as char);
                j += 1;
                compound_empty = true;
            }
            b':' => {
                let rest = &sel[j..];
                let lower: String = rest
                    .chars()
                    .take(16)
                    .collect::<String>()
                    .to_ascii_lowercase();
                if lower.starts_with("::slotted(") {
                    let (arg, end) = functional_arg(sel, j + "::slotted".len());
                    if compound_empty {
                        out.push_str("slot");
                    }
                    out.push_str(" > :is(");
                    out.push_str(arg.trim());
                    out.push(')');
                    j = end;
                    compound_empty = false;
                } else if lower.starts_with(":host-context(") {
                    let (arg, end) = functional_arg(sel, j + ":host-context".len());
                    out.push_str(":is(");
                    out.push_str(arg.trim());
                    out.push_str(") ");
                    out.push_str(host);
                    mentions_host = true;
                    j = end;
                    compound_empty = false;
                } else if lower.starts_with(":host(") {
                    let (arg, end) = functional_arg(sel, j + ":host".len());
                    out.push_str(host);
                    out.push_str(":is(");
                    out.push_str(arg.trim());
                    out.push(')');
                    mentions_host = true;
                    j = end;
                    compound_empty = false;
                } else if lower.starts_with(":host")
                    && !b.get(j + 5).is_some_and(|&c| is_ident_char(c))
                {
                    out.push_str(host);
                    mentions_host = true;
                    j += 5;
                    compound_empty = false;
                } else {
                    // Other pseudo-classes/elements: copy the name (and a functional
                    // argument) verbatim.
                    let mut k = j;
                    while k < b.len() && b[k] == b':' {
                        k += 1;
                    }
                    while k < b.len() && is_ident_char(b[k]) {
                        k += 1;
                    }
                    let end = if b.get(k) == Some(&b'(') { functional_arg(sel, k).1 } else { k };
                    out.push_str(&sel[j..end]);
                    j = end;
                    compound_empty = false;
                }
            }
            _ => {
                // Copy one UTF-8 character.
                let ch_len = sel[j..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&sel[j..j + ch_len]);
                j += ch_len;
                compound_empty = false;
            }
        }
    }
    (out, mentions_host)
}

#[cfg(test)]
mod tests {
    #[test]
    fn imports_are_dropped() {
        let out = super::scope_shadow_css("@import url(a.css); p { color: red }", "7");
        assert!(!out.contains("@import"), "{out}");
        assert!(out.contains("color: red"), "{out}");
    }

    use super::*;

    const H: &str = "[sharko-shadow-host=\"7\"]";

    fn s(css: &str) -> String {
        scope_shadow_css(css, "7")
    }

    #[test]
    fn prefixes_plain_selectors() {
        assert_eq!(s("a{color:red}"), format!("{H} a{{color:red}}"));
        assert_eq!(s(".a .b, p > i {x:y}"), format!("{H} .a .b,{H} p > i{{x:y}}"));
        assert_eq!(s("*,:after,:before{box-sizing:border-box}"), format!("{H} *,{H} :after,{H} :before{{box-sizing:border-box}}"));
    }

    #[test]
    fn host_forms() {
        assert_eq!(s(":host{display:block}"), format!("{H}{{display:block}}"));
        assert_eq!(s(":host([open]) .x{a:b}"), format!("{H}:is([open]) .x{{a:b}}"));
        assert_eq!(s(":host-context(.dark) p{a:b}"), format!(":is(.dark) {H} p{{a:b}}"));
        assert_eq!(s(":hostile{a:b}"), format!("{H} :hostile{{a:b}}"));
    }

    #[test]
    fn slotted() {
        assert_eq!(s("::slotted(p){a:b}"), format!("{H} slot > :is(p){{a:b}}"));
        assert_eq!(s("slot[name=x]::slotted(*){a:b}"), format!("{H} slot[name=x] > :is(*){{a:b}}"));
    }

    #[test]
    fn group_rules_and_statements() {
        assert_eq!(
            s("@import url(x.css);@media (min-width: 10px){a{b:c}}@keyframes k{from{a:b}}"),
            // `@import` is dropped: imported rules could not be scoped.
            format!("@media (min-width: 10px){{{H} a{{b:c}}}}@keyframes k{{from{{a:b}}}}")
        );
        assert_eq!(s("@font-face{font-family:x}"), "@font-face{font-family:x}");
        assert_eq!(s("@supports (x:y){:host{a:b}}"), format!("@supports (x:y){{{H}{{a:b}}}}"));
    }

    #[test]
    fn strings_comments_and_nesting() {
        assert_eq!(s("/* a{b} */a[title=\"x,{y}\"]{content:\"}\"}"), format!("/* a{{b}} */{H} a[title=\"x,{{y}}\"]{{content:\"}}\"}}"));
        assert_eq!(s(".a{color:red;.b{color:blue}}"), format!("{H} .a{{color:red;.b{{color:blue}}}}"));
        assert_eq!(s(":is(.a, .b) c{x:y}"), format!("{H} :is(.a, .b) c{{x:y}}"));
    }
}
