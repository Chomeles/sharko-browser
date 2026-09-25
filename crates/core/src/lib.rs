//! The browser as one shared library (`browser_core.dll` / `libbrowser_core.so`), loaded
//! by the tiny launcher executable — the same split as `chrome.exe` + `chrome.dll`.
//!
//! Every process runs the same launcher + library and picks its role from `--type`:
//!
//! * no `--type`            → browser process (window UI, or `--headless`)
//! * `--type=renderer`      → one per tab: DOM, CSS, layout, JavaScript, paint
//! * `--type=network`       → HTTP/1.1/2/3, TLS, cache, cookies
//!
//! Other commands: `--install`, `--uninstall`, `--version`.

mod installer;

use browser::headless::{HeadlessOptions, run_headless};
use browser::{BrowserOptions, default_profile_dir};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Version of this build (`CARGO_PKG_VERSION`).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// C entry point called by the launcher. Arguments are read from the process command
/// line. Returns the process exit code.
#[unsafe(no_mangle)]
pub extern "C" fn browser_core_main() -> i32 {
    match std::panic::catch_unwind(run) {
        Ok(code) => code,
        Err(_) => 101,
    }
}

/// Library ABI version the launcher checks before calling [`browser_core_main`].
#[unsafe(no_mangle)]
pub extern "C" fn browser_core_abi() -> u32 {
    1
}

const USAGE: &str = "\
Usage:
  browser [URL]                         open a window (UI)
  browser --headless [options] URL      load without a window

Headless options:
  --screenshot=FILE.png     save a screenshot (viewport, or whole page with --full-page)
  --full-page               capture the full page height
  --window-size=W,H         viewport in CSS px (default 1280,800)
  --scale=F                 device pixel ratio (default 1)
  --dump-dom                print the serialized DOM after load
  --eval=JS                 evaluate JS after load and print the result (repeatable)
  --wait-for=JS             before --eval, poll until JS is truthy (gives up after --timeout, exit 4)
  --wait-poll=MS            poll interval for --wait-for (default 50)
  --batch                   read URL[<TAB>TIMEOUT_MS] lines from stdin, load each in one
                            tab (--wait-for, --eval) and print a JSON line per URL
  --click=X,Y               click at viewport position after load (repeatable)
  --click-text=REGEX        click the first button/link whose text matches, also in iframes (repeatable)
  --click-wait=MS           time to let the page react after each click (default 300)
  --scroll=PX               scroll down by PX before the screenshot
  --timeout=MS              max wait for the load event (default 30000)
  --settle=MS               extra wait after load (default 300)
  --console                 print the page's console messages

Installation:
  --install                 install for the current user (+ Start menu shortcut)
  --uninstall               remove the installation (keeps the profile)
  --check-update            check for an update now and install it
  --no-update               disable background updates for this session
  --version                 print the version

Common options:
  --single-process          run network + renderer as threads (debugging)
  --no-js                   disable JavaScript
  --profile=DIR             profile directory (cookies, cache, storage)
  --verbose                 verbose logging
  --cpu                     render the UI on the CPU (no GPU)
";

#[cfg(windows)]
fn attach_console() {
    // Reuse the parent terminal's console so --headless / --help output is visible.
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(
            windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
        );
    }
}
#[cfg(not(windows))]
fn attach_console() {}

/// Directory of the launcher executable.
fn app_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// Portable mode: a file named `portable` next to the launcher keeps the profile
/// (cookies, cache, logs) in a `profile` folder beside it instead of the user's AppData.
fn portable_profile_dir() -> Option<PathBuf> {
    let dir = app_dir()?;
    dir.join("portable").is_file().then(|| dir.join("profile"))
}

/// Windows GUI processes have no stderr: send log output (of this process and, through
/// inherited handles, of its renderer/network processes) to `<profile>/logs/browser.log`.
/// The previous run's log is kept as `browser.old.log`. The startup timeline is always
/// recorded there (a few lines; helps diagnosing slow starts on other machines).
#[cfg(windows)]
fn log_to_file(profile: &Path) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle};
    let dir = profile.join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("browser.log");
    let _ = std::fs::rename(&path, dir.join("browser.old.log"));
    let Ok(file) = std::fs::File::create(&path) else { return };
    let handle = file.as_raw_handle();
    // The file stays open for the lifetime of the process.
    std::mem::forget(file);
    // SAFETY: `handle` is a valid, open file handle that is never closed.
    unsafe {
        SetStdHandle(STD_ERROR_HANDLE, handle);
        SetStdHandle(STD_OUTPUT_HANDLE, handle);
    }
    common::trace::enable();
    if std::env::var_os("BROWSER_TRACE_STARTUP").is_none() {
        // SAFETY: still single-threaded (nothing has been started yet); child processes
        // inherit the variable and trace into the same log.
        unsafe { std::env::set_var("BROWSER_TRACE_STARTUP", "1") };
    }
}

/// Run the browser with the process command line; returns the exit code.
pub fn run() -> i32 {
    common::trace::init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let console_command = args.iter().any(|a| {
        a == "--headless" || a == "--help" || a == "--version" || a.starts_with("--type=")
            || a == "--install" || a == "--uninstall" || a == "--check-update"
    });
    if console_command {
        attach_console();
    }
    let get = |name: &str| -> Option<String> {
        let prefix = format!("--{name}=");
        args.iter().find_map(|a| a.strip_prefix(&prefix).map(|s| s.to_string()))
    };
    let has = |name: &str| args.iter().any(|a| a == &format!("--{name}"));
    let verbose = has("verbose");
    let profile_dir = get("profile")
        .map(PathBuf::from)
        .or_else(portable_profile_dir)
        .unwrap_or_else(default_profile_dir);
    #[cfg(windows)]
    if !console_command {
        log_to_file(&profile_dir);
    }
    common::trace::mark("core: start");

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(if verbose {
        "info"
    } else {
        "warn"
    }))
    .init();

    match get("type").as_deref() {
        Some("renderer") => {
            let Some(ep) = get("ipc") else { return 2 };
            engine::renderer_main(&ep, verbose);
            return 0;
        }
        Some("network") => {
            let Some(ep) = get("ipc") else { return 2 };
            browser::network_main(&ep, profile_dir);
            return 0;
        }
        Some(other) => {
            eprintln!("unknown process type {other}");
            return 2;
        }
        None => {}
    }

    if has("help") || has("h") {
        print!("{USAGE}");
        return 0;
    }
    if has("version") {
        println!("{VERSION}");
        return 0;
    }
    if has("install") {
        return installer::install();
    }
    if has("uninstall") {
        return installer::uninstall();
    }

    let url = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .cloned()
        .map(|u| normalize_url(&u));

    let bopts = BrowserOptions {
        single_process: has("single-process"),
        profile_dir,
        javascript: !has("no-js"),
        verbose,
        app_version: VERSION.to_string(),
        auto_update: !has("no-update"),
        ..Default::default()
    };

    if has("check-update") {
        return check_update(bopts);
    }

    if has("headless") {
        let mut o = HeadlessOptions {
            url: url.unwrap_or_else(|| "about:blank".into()),
            screenshot: get("screenshot").map(PathBuf::from),
            full_page: has("full-page"),
            dump_dom: has("dump-dom"),
            print_console: has("console"),
            ..Default::default()
        };
        if let Some(ws) = get("window-size") {
            if let Some((w, h)) = ws.split_once([',', 'x']) {
                o.width = w.trim().parse().unwrap_or(1280);
                o.height = h.trim().parse().unwrap_or(800);
            }
        }
        if let Some(s) = get("scale") {
            o.scale = s.parse().unwrap_or(1.0);
        }
        if let Some(t) = get("timeout") {
            o.timeout = Duration::from_millis(t.parse().unwrap_or(30_000));
        }
        if let Some(t) = get("settle") {
            o.settle = Duration::from_millis(t.parse().unwrap_or(300));
        }
        if let Some(t) = get("click-wait") {
            o.click_wait = Duration::from_millis(t.parse().unwrap_or(300));
        }
        if let Some(s) = get("scroll") {
            o.scroll_y = s.parse().unwrap_or(0.0);
        }
        o.wait_for = get("wait-for").map(String::from);
        o.batch = has("batch");
        if let Some(t) = get("wait-poll") {
            o.wait_poll = Duration::from_millis(t.parse().unwrap_or(50));
        }
        let prefix_eval = "--eval=";
        o.eval = args
            .iter()
            .filter_map(|a| a.strip_prefix(prefix_eval).map(|s| s.to_string()))
            .collect();
        o.click_text = args
            .iter()
            .filter_map(|a| a.strip_prefix("--click-text=").map(String::from))
            .collect();
        o.clicks = args
            .iter()
            .filter_map(|a| a.strip_prefix("--click="))
            .filter_map(|s| {
                let (x, y) = s.split_once(',')?;
                Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
            })
            .collect();
        return run_headless(bopts, o);
    }

    let urls: Vec<String> = args
        .iter()
        .filter(|a| !a.starts_with("--"))
        .map(|u| normalize_url(u))
        .collect();
    if has("cpu") {
        // SAFETY: single-threaded at this point.
        unsafe { std::env::set_var("BROWSER_RENDERER", "cpu") };
    }
    match shell::run(bopts, urls) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("browser: {e}");
            1
        }
    }
}

/// `--check-update`: run one update check synchronously and report.
fn check_update(bopts: BrowserOptions) -> i32 {
    use browser::update::{UpdateConfig, UpdateStatus, check_and_install};
    let cfg = match UpdateConfig::detect(VERSION) {
        Ok(c) => c,
        Err(why) => {
            println!("updates disabled: {why}");
            return 0;
        }
    };
    let mut b = match browser::Browser::new(BrowserOptions { auto_update: false, ..bopts }) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let status = check_and_install(b.net(), &cfg);
    b.shutdown();
    match status {
        UpdateStatus::UpToDate => println!("up to date ({VERSION})"),
        UpdateStatus::Installed(v) => println!("installed {v}; restart to use it"),
        UpdateStatus::Disabled(w) => println!("updates disabled: {w}"),
        UpdateStatus::Failed(e) => {
            println!("update failed: {e}");
            return 1;
        }
    }
    0
}

/// Turn user input into a URL: keep explicit schemes, map existing file paths to file://,
/// otherwise assume https://.
fn normalize_url(input: &str) -> String {
    let s = input.trim();
    if s.contains("://") || s.starts_with("about:") || s.starts_with("data:") {
        return s.to_string();
    }
    let p = std::path::Path::new(s);
    if p.exists() {
        if let Ok(abs) = std::fs::canonicalize(p) {
            let mut path = abs.display().to_string();
            if cfg!(windows) {
                path = path.trim_start_matches(r"\\?\").replace('\\', "/");
                return format!("file:///{path}");
            }
            return format!("file://{path}");
        }
    }
    format!("https://{s}")
}
