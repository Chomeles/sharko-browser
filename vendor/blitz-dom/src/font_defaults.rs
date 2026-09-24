//! PATCH: browser-compatible default fonts.
//!
//! Browsers render `sans-serif` with Arial and `serif` (also the default font of an
//! unstyled page) with Times New Roman, and on Linux fontconfig substitutes the
//! metric-compatible Liberation/Croscore fonts for Arial, Helvetica, Times and Courier
//! when those aren't installed. Pages are designed against these metrics; falling back
//! to e.g. DejaVu Sans (about 10% wider) changes line breaks and breaks layouts.

use parley::FontContext;
use parley::fontique::GenericFamily;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Preferred families for the generic families, in order (first installed wins; the
/// platform's own defaults follow).
const GENERIC_PREFERENCES: &[(GenericFamily, &[&str])] = &[
    (
        GenericFamily::SansSerif,
        &["Arial", "Liberation Sans", "Arimo", "Helvetica", "Nimbus Sans"],
    ),
    (
        GenericFamily::Serif,
        &["Times New Roman", "Liberation Serif", "Tinos", "Times", "Nimbus Roman"],
    ),
];

/// Metric-compatible substitutes for common named families that may not be installed.
const ALIASES: &[(&str, &[&str])] = &[
    ("Arial", &["Liberation Sans", "Arimo"]),
    ("Helvetica", &["Arial", "Liberation Sans", "Arimo"]),
    ("Helvetica Neue", &["Arial", "Liberation Sans", "Arimo"]),
    ("Times New Roman", &["Liberation Serif", "Tinos"]),
    ("Times", &["Times New Roman", "Liberation Serif", "Tinos"]),
    ("Courier New", &["Liberation Mono", "Cousine"]),
    ("Courier", &["Courier New", "Liberation Mono", "Cousine"]),
];

static FAMILY_ALIASES: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Configure `ctx` (and the process-wide family aliases) like a web browser.
pub fn apply_web_font_defaults(ctx: &mut FontContext) {
    for (generic, names) in GENERIC_PREFERENCES {
        let ids: Vec<_> = names
            .iter()
            .filter_map(|name| ctx.collection.family_id(name))
            .collect();
        if !ids.is_empty() {
            ctx.collection.set_generic_families(*generic, ids.into_iter());
        }
    }
    let mut aliases = HashMap::new();
    for (name, targets) in ALIASES {
        if ctx.collection.family_id(name).is_some() {
            continue;
        }
        if let Some(target) = targets
            .iter()
            .find(|t| ctx.collection.family_id(t).is_some())
        {
            aliases.insert(name.to_ascii_lowercase(), (*target).to_string());
        }
    }
    let _ = FAMILY_ALIASES.set(aliases);
}

/// The installed substitute for a named family, if the family itself is missing.
pub(crate) fn family_alias(name: &str) -> Option<&'static str> {
    let aliases = FAMILY_ALIASES.get()?;
    if aliases.is_empty() {
        return None;
    }
    aliases.get(&name.to_ascii_lowercase()).map(String::as_str)
}
