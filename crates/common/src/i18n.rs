//! UI translations. Strings live in `resources/locales/<lang>.json` (flat `key: text`
//! maps). The language follows the operating system (override: `BROWSER_LANG`), with
//! English as fallback for missing keys.

use std::collections::HashMap;
use std::sync::OnceLock;

struct Catalog {
    lang: String,
    strings: HashMap<String, String>,
    fallback: HashMap<String, String>,
}

fn load(lang: &str) -> HashMap<String, String> {
    let text = crate::resources::read(&format!("locales/{lang}.json")).unwrap_or_default();
    serde_json::from_slice(&text).unwrap_or_default()
}

fn catalog() -> &'static Catalog {
    static CAT: OnceLock<Catalog> = OnceLock::new();
    CAT.get_or_init(|| {
        let requested = std::env::var("BROWSER_LANG")
            .ok()
            .or_else(sys_locale::get_locale)
            .unwrap_or_else(|| "en".into());
        let short = requested
            .split(['-', '_', '.'])
            .next()
            .unwrap_or("en")
            .to_ascii_lowercase();
        let mut strings = load(&short);
        let lang = if strings.is_empty() {
            strings = load("en");
            "en".to_string()
        } else {
            short
        };
        Catalog {
            lang,
            strings,
            fallback: load("en"),
        }
    })
}

/// Current UI language code ("de", "en", ...).
pub fn lang() -> &'static str {
    &catalog().lang
}

/// Translate `key` (returns the key itself if unknown).
pub fn t(key: &str) -> &'static str {
    let c = catalog();
    c.strings
        .get(key)
        .or_else(|| c.fallback.get(key))
        .map(|s| s.as_str())
        .unwrap_or_else(|| Box::leak(key.to_string().into_boxed_str()))
}

/// Replace `{{t.key}}` placeholders in an HTML/text template with translations
/// (HTML-escaped).
pub fn localize(template: &str) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{t.") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 4..];
        match after.find("}}") {
            Some(end) => {
                out.push_str(&crate::resources::escape_html(t(&after[..end])));
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}
