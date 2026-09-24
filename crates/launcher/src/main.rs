//! Launcher: the small executable users start (like `chrome.exe`). It contains no
//! browser code; it finds the active version and loads its core library.
//!
//! ```text
//! <root>/browser(.exe)            this launcher
//! <root>/version                  active version ("0.2.0"), written by installer/updater
//! <root>/0.2.0/browser_core.dll   core library of that version (+ resources/)
//! <root>/0.1.0/...                previous version, kept for one update cycle
//! ```
//!
//! * Child processes (renderers, network service) inherit `BROWSER_CORE_PATH`, so a
//!   browser session never mixes library versions, even if an update is installed while
//!   it runs.
//! * Updated launchers arrive as `browser.new(.exe)` and are swapped in on the next start
//!   (a running executable can be renamed on Windows, but not overwritten).
//! * Development builds: the library next to the executable (`target/debug/`) is used.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

#[cfg(windows)]
const LIB: &str = "browser_core.dll";
#[cfg(target_os = "macos")]
const LIB: &str = "libbrowser_core.dylib";
#[cfg(all(unix, not(target_os = "macos")))]
const LIB: &str = "libbrowser_core.so";

#[cfg(windows)]
const EXE: &str = "browser.exe";
#[cfg(not(windows))]
const EXE: &str = "browser";

/// ABI version this launcher speaks (see `browser_core_abi`).
const ABI: u32 = 1;

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(msg) => {
            fatal(&msg);
            1
        }
    };
    std::process::exit(code);
}

fn run() -> Result<i32, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = exe
        .parent()
        .ok_or("launcher has no parent directory")?
        .to_path_buf();
    let is_child = std::env::args().any(|a| a.starts_with("--type="));

    let lib = match std::env::var_os("BROWSER_CORE_PATH") {
        Some(p) if Path::new(&p).is_file() => PathBuf::from(p),
        _ => {
            if !is_child {
                swap_in_new_launcher(&root);
            }
            let lib = select_library(&root)?;
            if !is_child {
                cleanup_old_versions(&root, &lib);
            }
            lib
        }
    };
    // SAFETY: single-threaded here; inherited by every child process we spawn.
    unsafe { std::env::set_var("BROWSER_CORE_PATH", &lib) };

    // SAFETY: loading our own library and calling its documented C entry points.
    unsafe {
        let library = libloading::Library::new(&lib)
            .map_err(|e| format!("Cannot load {}:\n{e}", lib.display()))?;
        let abi: libloading::Symbol<unsafe extern "C" fn() -> u32> = library
            .get(b"browser_core_abi")
            .map_err(|e| format!("{} is not a browser core library: {e}", lib.display()))?;
        if abi() != ABI {
            return Err(format!(
                "{} has ABI {} but this launcher needs {ABI}. Please reinstall.",
                lib.display(),
                abi()
            ));
        }
        let entry: libloading::Symbol<unsafe extern "C" fn() -> i32> = library
            .get(b"browser_core_main")
            .map_err(|e| e.to_string())?;
        let code = entry();
        // Never unload: threads of the library may still be running at exit.
        std::mem::forget(library);
        Ok(code)
    }
}

fn parse_version(s: &str) -> Option<Vec<u64>> {
    let core = s.trim().trim_start_matches('v').split(['-', '+']).next()?;
    core.split('.').map(|p| p.parse().ok()).collect()
}

/// Pick the core library: the version named in `<root>/version`, else the newest
/// installed version folder, else a library next to the launcher (dev / portable).
fn select_library(root: &Path) -> Result<PathBuf, String> {
    if let Ok(v) = std::fs::read_to_string(root.join("version")) {
        let p = root.join(v.trim()).join(LIB);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Some((_, dir)) = installed_versions(root).into_iter().max_by(|a, b| a.0.cmp(&b.0)) {
        return Ok(dir.join(LIB));
    }
    let p = root.join(LIB);
    if p.is_file() {
        return Ok(p);
    }
    Err(format!(
        "No browser version found in {}.\nPlease reinstall.",
        root.display()
    ))
}

fn installed_versions(root: &Path) -> Vec<(Vec<u64>, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(root) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.path().join(LIB).is_file())
        .filter_map(|e| {
            let v = parse_version(&e.file_name().to_string_lossy())?;
            Some((v, e.path()))
        })
        .collect()
}

/// Keep the active version and the newest other one (rollback); delete the rest.
/// Deleting fails harmlessly for versions still in use by a running instance.
fn cleanup_old_versions(root: &Path, active_lib: &Path) {
    let Some(active_dir) = active_lib.parent() else { return };
    if active_dir == root {
        return; // dev / portable layout
    }
    let mut others: Vec<_> = installed_versions(root)
        .into_iter()
        .filter(|(_, d)| d != active_dir)
        .collect();
    others.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, dir) in others.into_iter().skip(1) {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_file(root.join(format!("{EXE}.old")));
}

/// An update may ship a new launcher as `browser.new(.exe)`: move it into place.
fn swap_in_new_launcher(root: &Path) {
    let new = root.join(format!("{EXE}.new"));
    if !new.is_file() {
        return;
    }
    let current = root.join(EXE);
    let old = root.join(format!("{EXE}.old"));
    let _ = std::fs::remove_file(&old);
    if std::fs::rename(&current, &old).is_ok() && std::fs::rename(&new, &current).is_err() {
        // Put the old one back if the swap failed half-way.
        let _ = std::fs::rename(&old, &current);
    }
}

#[cfg(windows)]
fn fatal(msg: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = wide(msg);
    let title = wide("Browser");
    // SAFETY: valid, NUL-terminated UTF-16 strings.
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn fatal(msg: &str) {
    eprintln!("browser: {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(parse_version("0.10.0").unwrap() > parse_version("0.9.3").unwrap());
        assert_eq!(parse_version("v1.2.3-beta.1").unwrap(), vec![1, 2, 3]);
        assert!(parse_version("resources").is_none());
    }
}
