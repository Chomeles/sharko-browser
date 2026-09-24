//! Locating the application's data files.
//!
//! Release layout (see `crates/launcher`):
//!
//! ```text
//! <install>/browser(.exe)                 launcher
//! <install>/<version>/browser_core.dll    all code
//! <install>/<version>/resources/          data files (this module)
//! ```
//!
//! Lookup order for the resources directory:
//! 1. `BROWSER_RESOURCES_DIR` environment variable,
//! 2. `resources/` next to the core library (`BROWSER_CORE_PATH`, set by the launcher),
//! 3. `resources/` next to the executable (portable single-folder layout),
//! 4. the source tree's `resources/` (development builds).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Override the resources directory (call before first use).
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn detect() -> PathBuf {
    let valid = |p: &Path| p.join("pages").is_dir() || p.join("icudtl.dat").is_file();
    if let Some(d) = std::env::var_os("BROWSER_RESOURCES_DIR").map(PathBuf::from) {
        return d;
    }
    if let Some(core) = std::env::var_os("BROWSER_CORE_PATH").map(PathBuf::from) {
        if let Some(d) = core.parent().map(|p| p.join("resources")) {
            if valid(&d) {
                return d;
            }
        }
    }
    if let Some(d) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.join("resources")))
    {
        if valid(&d) {
            return d;
        }
    }
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../resources"))
}

/// The resources directory.
pub fn dir() -> &'static Path {
    DIR.get_or_init(detect)
}

/// Absolute path of a resource (`rel` uses `/` separators).
pub fn path(rel: &str) -> PathBuf {
    rel.split('/').fold(dir().to_path_buf(), |p, c| p.join(c))
}

pub fn read(rel: &str) -> Option<Vec<u8>> {
    std::fs::read(path(rel)).ok()
}

/// Read a UTF-8 text resource. Missing files are logged once and yield an empty string,
/// so a damaged installation degrades instead of crashing.
pub fn text(rel: &str) -> String {
    match std::fs::read_to_string(path(rel)) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[resources] missing {} ({e})", path(rel).display());
            String::new()
        }
    }
}

/// Fill `{{key}}` placeholders in a template.
pub fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

/// HTML-escape a string for use in templates.
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}
