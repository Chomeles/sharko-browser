//! Entry point. One executable, several process roles (like Chromium):
//!
//! * no `--type`            → browser process (window UI, or `--headless`)
//! * `--type=renderer`      → one per tab: DOM, CSS, layout, JavaScript, paint
//! * `--type=network`       → HTTP/1.1/2/3, TLS, cache, cookies

use browser::headless::{HeadlessOptions, run_headless};
use browser::{BrowserOptions, default_profile_dir};
use std::path::PathBuf;
use std::time::Duration;

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
  --click=X,Y               click at viewport position after load (repeatable)
  --scroll=PX               scroll down by PX before the screenshot
  --timeout=MS              max wait for the load event (default 30000)
  --settle=MS               extra wait after load (default 300)
  --console                 print the page's console messages

Common options:
  --single-process          run network + renderer as threads (debugging)
  --no-js                   disable JavaScript
  --profile=DIR             profile directory (cookies, cache, storage)
  --verbose                 verbose logging
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| -> Option<String> {
        let prefix = format!("--{name}=");
        args.iter().find_map(|a| a.strip_prefix(&prefix).map(|s| s.to_string()))
    };
    let has = |name: &str| args.iter().any(|a| a == &format!("--{name}"));
    let verbose = has("verbose");

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(if verbose {
        "info"
    } else {
        "warn"
    }))
    .init();

    match get("type").as_deref() {
        Some("renderer") => {
            let ep = get("ipc").expect("--ipc missing");
            engine::renderer_main(&ep, verbose);
            return;
        }
        Some("network") => {
            let ep = get("ipc").expect("--ipc missing");
            let profile = get("profile").map(PathBuf::from).unwrap_or_else(default_profile_dir);
            browser::network_main(&ep, profile);
            return;
        }
        Some(other) => {
            eprintln!("unknown process type {other}");
            std::process::exit(2);
        }
        None => {}
    }

    if has("help") || has("h") {
        print!("{USAGE}");
        return;
    }

    let url = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .cloned()
        .map(|u| normalize_url(&u));

    let bopts = BrowserOptions {
        single_process: has("single-process"),
        profile_dir: get("profile").map(PathBuf::from).unwrap_or_else(default_profile_dir),
        javascript: !has("no-js"),
        verbose,
        ..Default::default()
    };

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
        if let Some(s) = get("scroll") {
            o.scroll_y = s.parse().unwrap_or(0.0);
        }
        let prefix_eval = "--eval=";
        o.eval = args
            .iter()
            .filter_map(|a| a.strip_prefix(prefix_eval).map(|s| s.to_string()))
            .collect();
        o.clicks = args
            .iter()
            .filter_map(|a| a.strip_prefix("--click="))
            .filter_map(|s| {
                let (x, y) = s.split_once(',')?;
                Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
            })
            .collect();
        std::process::exit(run_headless(bopts, o));
    }

    eprintln!("UI not built yet; use --headless. \n{USAGE}");
    std::process::exit(2);
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
