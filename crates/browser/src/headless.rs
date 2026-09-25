//! Headless mode: load a page without a window, then take screenshots, dump the DOM,
//! evaluate JavaScript and report timings. Used for automated testing.

use crate::{Browser, BrowserEvent, BrowserOptions, TabId};
use common::protocol::{FromRenderer, LoadEvent, ToRenderer, ViewportInfo};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct HeadlessOptions {
    pub url: String,
    pub screenshot: Option<PathBuf>,
    pub full_page: bool,
    pub width: u32,
    pub height: u32,
    pub scale: f32,
    pub dump_dom: bool,
    pub eval: Vec<String>,
    /// Give up waiting for `load` after this long (then continue with what we have).
    pub timeout: Duration,
    /// Extra time to let the page settle after `load` (timers, late fetches).
    pub settle: Duration,
    pub print_console: bool,
    pub timings: bool,
    /// Simulated input after load: list of (x, y) clicks.
    pub clicks: Vec<(f32, f32)>,
    /// Time to let the page react after each click.
    pub click_wait: Duration,
    /// Buttons/links to click by text (case-insensitive regexes), also inside iframes.
    pub click_text: Vec<String>,
    /// Scroll by this many CSS px after load (before the screenshot).
    pub scroll_y: f64,
    /// Before `--eval`, poll this expression until it is truthy (or `timeout` passes).
    pub wait_for: Option<String>,
    /// Poll interval for `wait_for`.
    pub wait_poll: Duration,
    /// Batch mode: read `URL[<TAB>TIMEOUT_MS]` lines from stdin, load each in the same
    /// tab (`wait_for`, then the `--eval`s) and print one JSON line per URL.
    pub batch: bool,
}

impl Default for HeadlessOptions {
    fn default() -> Self {
        Self {
            url: "about:blank".into(),
            screenshot: None,
            full_page: false,
            width: 1280,
            height: 800,
            scale: 1.0,
            dump_dom: false,
            eval: Vec::new(),
            timeout: Duration::from_secs(30),
            settle: Duration::from_millis(300),
            click_wait: Duration::from_millis(300),
            click_text: Vec::new(),
            print_console: false,
            timings: true,
            clicks: Vec::new(),
            scroll_y: 0.0,
            wait_for: None,
            wait_poll: Duration::from_millis(50),
            batch: false,
        }
    }
}

struct Driver {
    browser: Browser,
    #[allow(dead_code)]
    tab: TabId,
    print_console: bool,
    /// Batch mode collects the console per URL instead of printing it.
    collect_console: bool,
    console: Vec<(String, String)>,
}

/// JSON string literal (for the batch-mode result lines; no serde dependency here).
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

impl Driver {
    /// Pump events for `dur` or until `pred` returns true for an event.
    fn pump_until(
        &mut self,
        dur: Duration,
        mut pred: impl FnMut(&BrowserEvent) -> bool,
    ) -> Option<BrowserEvent> {
        let deadline = Instant::now() + dur;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            match self.browser.events.recv_timeout(deadline - now) {
                Ok(ev) => {
                    if let Some(ev) = self.browser.process_event(ev) {
                        if let BrowserEvent::Tab(_, FromRenderer::Console { level, message }) = &ev {
                            if self.collect_console {
                                if self.console.len() < 200 {
                                    self.console.push((level.clone(), message.clone()));
                                }
                            } else if self.print_console {
                                eprintln!("console.{level}: {message}");
                            }
                        }
                        if let BrowserEvent::TabCrashed(_) = ev {
                            eprintln!("[headless] renderer crashed");
                            return Some(ev);
                        }
                        if pred(&ev) {
                            return Some(ev);
                        }
                    }
                }
                Err(_) => return None,
            }
        }
    }
}

pub fn run_headless(bopts: BrowserOptions, opts: HeadlessOptions) -> i32 {
    let t0 = Instant::now();
    let mut browser = match Browser::new(bopts) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[headless] failed to start: {e}");
            return 2;
        }
    };
    let viewport = ViewportInfo {
        width: (opts.width as f32 * opts.scale) as u32,
        height: (opts.height as f32 * opts.scale) as u32,
        scale: opts.scale,
        zoom: 1.0,
        dark_mode: false,
    };
    let startup = t0.elapsed();
    let tab = match browser.new_tab(&opts.url, viewport) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[headless] failed to create tab: {e}");
            return 2;
        }
    };
    let mut d = Driver {
        browser,
        tab,
        print_console: opts.print_console,
        collect_console: opts.batch,
        console: Vec::new(),
    };

    if opts.batch {
        return run_batch(&mut d, tab, &opts);
    }

    // Wait for load (or failure / timeout).
    let mut exit = 0;
    let ev = d.pump_until(opts.timeout, |ev| {
        matches!(
            ev,
            BrowserEvent::Tab(_, FromRenderer::Load { event: LoadEvent::Load | LoadEvent::Failed, .. })
                | BrowserEvent::TabCrashed(_)
        )
    });
    match ev {
        Some(BrowserEvent::Tab(_, FromRenderer::Load { event: LoadEvent::Failed, error, .. })) => {
            eprintln!("[headless] navigation failed: {}", error.unwrap_or_default());
            exit = 1;
        }
        Some(BrowserEvent::TabCrashed(_)) => {
            d.browser.shutdown();
            return 3;
        }
        None => eprintln!("[headless] load timeout after {:?} (continuing)", opts.timeout),
        _ => {}
    }
    d.pump_until(opts.settle, |_| false);

    // Simulated input.
    for (x, y) in &opts.clicks {
        let mods = Default::default();
        for m in [
            common::protocol::InputEvent::MouseMove { x: *x, y: *y, buttons: 0, mods },
            common::protocol::InputEvent::MouseDown { x: *x, y: *y, button: 0, buttons: 1, mods },
            common::protocol::InputEvent::MouseUp { x: *x, y: *y, button: 0, buttons: 0, mods },
        ] {
            d.browser.send(tab, ToRenderer::Input(m));
        }
        d.pump_until(opts.click_wait, |_| false);
    }
    for (i, pattern) in opts.click_text.iter().enumerate() {
        let id = 900 + i as u64;
        d.browser.send(tab, ToRenderer::Eval { id, source: format!("click-text:{pattern}") });
        if let Some(BrowserEvent::Tab(_, FromRenderer::EvalResult { value, .. })) = d.pump_until(
            Duration::from_secs(10),
            |ev| matches!(ev, BrowserEvent::Tab(_, FromRenderer::EvalResult { id: rid, .. }) if *rid == id),
        ) {
            eprintln!("[headless] click-text /{pattern}/: {value}");
        }
        d.pump_until(opts.click_wait, |_| false);
    }
    if opts.scroll_y != 0.0 {
        d.browser.send(
            tab,
            ToRenderer::Input(common::protocol::InputEvent::Wheel {
                x: opts.width as f32 / 2.0,
                y: opts.height as f32 / 2.0,
                dx: 0.0,
                dy: opts.scroll_y,
                mods: Default::default(),
            }),
        );
        d.pump_until(Duration::from_millis(300), |_| false);
    }

    // Wait for a page condition (test harness completion, a rendered widget, ...).
    if let Some(cond) = &opts.wait_for {
        let source = format!("!!({cond})");
        let deadline = Instant::now() + opts.timeout;
        let mut n = 0u64;
        loop {
            let id = 2000 + n;
            n += 1;
            d.browser.send(tab, ToRenderer::Eval { id, source: source.clone() });
            let ev = d.pump_until(Duration::from_secs(10), |ev| {
                matches!(
                    ev,
                    BrowserEvent::Tab(_, FromRenderer::EvalResult { id: rid, .. }) if *rid == id
                ) || matches!(ev, BrowserEvent::TabCrashed(_))
            });
            match ev {
                Some(BrowserEvent::TabCrashed(_)) => {
                    d.browser.shutdown();
                    return 3;
                }
                Some(BrowserEvent::Tab(_, FromRenderer::EvalResult { ok, value, .. }))
                    if ok && value == "true" =>
                {
                    break;
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                eprintln!("[headless] wait-for timeout after {:?}", opts.timeout);
                exit = exit.max(4);
                break;
            }
            if let Some(BrowserEvent::TabCrashed(_)) = d.pump_until(opts.wait_poll, |ev| {
                matches!(ev, BrowserEvent::TabCrashed(_))
            }) {
                d.browser.shutdown();
                return 3;
            }
        }
    }

    // Evaluate scripts.
    for (i, src) in opts.eval.iter().enumerate() {
        let id = 1000 + i as u64;
        d.browser.send(tab, ToRenderer::Eval { id, source: src.clone() });
        match d.pump_until(Duration::from_secs(10), |ev| {
            matches!(ev, BrowserEvent::Tab(_, FromRenderer::EvalResult { id: rid, .. }) if *rid == id)
        }) {
            Some(BrowserEvent::Tab(_, FromRenderer::EvalResult { ok, value, .. })) => {
                if ok {
                    println!("{value}");
                } else {
                    println!("Error: {value}");
                    exit = exit.max(1);
                }
            }
            _ => println!("Error: eval timeout"),
        }
        d.pump_until(Duration::from_millis(50), |_| false);
    }

    if opts.dump_dom {
        d.browser.send(tab, ToRenderer::GetDom { id: 1 });
        if let Some(BrowserEvent::Tab(_, FromRenderer::Dom { html, .. })) = d.pump_until(
            Duration::from_secs(10),
            |ev| matches!(ev, BrowserEvent::Tab(_, FromRenderer::Dom { .. })),
        ) {
            println!("{html}");
        }
    }

    if let Some(path) = &opts.screenshot {
        let t = Instant::now();
        let frame = if opts.full_page {
            d.browser.send(
                tab,
                ToRenderer::CaptureFullPage { id: 7, max_height: 16_000 },
            );
            match d.pump_until(Duration::from_secs(10), |ev| {
                matches!(ev, BrowserEvent::Tab(_, FromRenderer::Frame(f)) if f.capture_id == Some(7))
            }) {
                Some(BrowserEvent::Tab(_, FromRenderer::Frame(f))) => Some(f),
                _ => None,
            }
        } else {
            if d.browser.tab(tab).and_then(|t| t.frame.as_ref()).is_none() {
                d.pump_until(Duration::from_secs(5), |_| {
                    false
                });
            }
            d.browser.tab_mut(tab).and_then(|t| t.frame.take())
        };
        match frame {
            Some(frame) => {
                let tab_ref = d.browser.tab(tab).expect("tab");
                let rgba = engine::raster::rasterize(
                    &frame.list,
                    &tab_ref.resources,
                    frame.width,
                    frame.height,
                );
                let raster = t.elapsed();
                match engine::raster::encode_png(&rgba, frame.width, frame.height)
                    .and_then(|png| std::fs::write(path, png))
                {
                    Ok(()) => eprintln!(
                        "[headless] screenshot {}x{} -> {} (raster {:.1} ms, {} cmds)",
                        frame.width,
                        frame.height,
                        path.display(),
                        raster.as_secs_f64() * 1000.0,
                        frame.list.cmds.len()
                    ),
                    Err(e) => {
                        eprintln!("[headless] cannot write screenshot: {e}");
                        exit = 1;
                    }
                }
            }
            None => {
                eprintln!("[headless] no frame to capture");
                exit = 1;
            }
        }
    }

    if opts.timings {
        if let Some(t) = d.browser.tab(tab) {
            let ms = |d: Option<Duration>| {
                d.map(|d| format!("{:.0} ms", d.as_secs_f64() * 1000.0))
                    .unwrap_or_else(|| "-".into())
            };
            eprintln!(
                "[headless] startup {:.0} ms | first frame {} | DOMContentLoaded {} | load {} | frames {} | title {:?}",
                startup.as_secs_f64() * 1000.0,
                ms(t.first_frame),
                ms(t.dom_content_loaded),
                ms(t.load_finished),
                t.frames,
                t.title
            );
            if let Some((parse, script, style_layout, paint)) = t.metrics {
                eprintln!(
                    "[headless] renderer: parse {parse:.1} ms | scripts (sync part) {script:.1} ms | style+layout {style_layout:.1} ms | paint {paint:.1} ms"
                );
            }
            let errors = t.console.iter().filter(|(l, _)| l == "error").count();
            if errors > 0 {
                eprintln!("[headless] {errors} console error(s) (use --console to show)");
            }
        }
    }
    d.browser.shutdown();
    exit
}

/// Run one URL in the batch tab: navigate, wait for load, `wait_for`, the `--eval`s.
/// Returns the JSON fields for the result line, or `None` when the renderer crashed.
fn batch_one(d: &mut Driver, tab: TabId, opts: &HeadlessOptions, url: &str, timeout: Duration) -> Option<String> {
    let t0 = Instant::now();
    d.console.clear();
    d.browser.navigate(tab, url);
    let crashed = |ev: &BrowserEvent| matches!(ev, BrowserEvent::TabCrashed(_));
    // The previous page may still report events; wait for this navigation to start.
    let started = d.pump_until(timeout, |ev| {
        crashed(ev)
            || matches!(
                ev,
                BrowserEvent::Tab(_, FromRenderer::Load { event: LoadEvent::Started | LoadEvent::Failed, .. })
            )
    });
    let load = match started {
        Some(BrowserEvent::TabCrashed(_)) => return None,
        Some(BrowserEvent::Tab(_, FromRenderer::Load { event: LoadEvent::Failed, error, .. })) => {
            format!("failed: {}", error.unwrap_or_default())
        }
        None => "timeout".to_string(),
        _ => {
            let remaining = timeout.saturating_sub(t0.elapsed());
            match d.pump_until(remaining, |ev| {
                crashed(ev)
                    || matches!(
                        ev,
                        BrowserEvent::Tab(_, FromRenderer::Load { event: LoadEvent::Load | LoadEvent::Failed, .. })
                    )
            }) {
                Some(BrowserEvent::TabCrashed(_)) => return None,
                Some(BrowserEvent::Tab(_, FromRenderer::Load { event: LoadEvent::Failed, error, .. })) => {
                    format!("failed: {}", error.unwrap_or_default())
                }
                Some(_) => "ok".to_string(),
                None => "timeout".to_string(),
            }
        }
    };
    if !load.starts_with("failed") {
        d.pump_until(opts.settle, |_| false);
    }
    let mut wait = "none".to_string();
    if let Some(cond) = &opts.wait_for {
        if load.starts_with("failed") {
            wait = "skipped".to_string();
        } else {
            let source = format!("!!({cond})");
            let deadline = t0 + timeout;
            let mut n = 0u64;
            wait = loop {
                let id = 3000 + n;
                n += 1;
                d.browser.send(tab, ToRenderer::Eval { id, source: source.clone() });
                match d.pump_until(Duration::from_secs(10), |ev| {
                    crashed(ev)
                        || matches!(ev, BrowserEvent::Tab(_, FromRenderer::EvalResult { id: rid, .. }) if *rid == id)
                }) {
                    Some(BrowserEvent::TabCrashed(_)) => return None,
                    Some(BrowserEvent::Tab(_, FromRenderer::EvalResult { ok, value, .. })) if ok && value == "true" => {
                        break "ok".to_string();
                    }
                    _ => {}
                }
                if Instant::now() >= deadline {
                    break "timeout".to_string();
                }
                if d.pump_until(opts.wait_poll, crashed).is_some() {
                    return None;
                }
            };
        }
    }
    let mut evals = Vec::new();
    for (i, src) in opts.eval.iter().enumerate() {
        let id = 4000 + i as u64;
        d.browser.send(tab, ToRenderer::Eval { id, source: src.clone() });
        match d.pump_until(Duration::from_secs(10), |ev| {
            crashed(ev) || matches!(ev, BrowserEvent::Tab(_, FromRenderer::EvalResult { id: rid, .. }) if *rid == id)
        }) {
            Some(BrowserEvent::TabCrashed(_)) => return None,
            Some(BrowserEvent::Tab(_, FromRenderer::EvalResult { ok, value, .. })) => {
                evals.push(format!("{{\"ok\":{ok},\"value\":{}}}", json_str(&value)));
            }
            _ => evals.push("{\"ok\":false,\"value\":\"eval timeout\"}".to_string()),
        }
    }
    let console: Vec<String> = d
        .console
        .iter()
        .map(|(level, message)| format!("{}: {}", level, message))
        .map(|s| json_str(&s))
        .collect();
    Some(format!(
        "\"load\":{},\"wait\":{},\"ms\":{},\"evals\":[{}],\"console\":[{}]",
        json_str(&load),
        json_str(&wait),
        t0.elapsed().as_millis(),
        evals.join(","),
        console.join(",")
    ))
}

/// `--batch`: one JSON line per stdin URL. A renderer crash prints `"crash":true` for the
/// URL and ends the process with status 3 (the caller restarts it).
fn run_batch(d: &mut Driver, tab: TabId, opts: &HeadlessOptions) -> i32 {
    use std::io::{BufRead, Write};
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (url, timeout) = match line.split_once('\t') {
            Some((u, t)) => (
                u.trim().to_string(),
                t.trim().parse().map(Duration::from_millis).unwrap_or(opts.timeout),
            ),
            None => (line.to_string(), opts.timeout),
        };
        match batch_one(d, tab, opts, &url, timeout) {
            Some(fields) => {
                let _ = writeln!(stdout, "{{\"url\":{},{}}}", json_str(&url), fields);
            }
            None => {
                let _ = writeln!(stdout, "{{\"url\":{},\"crash\":true}}", json_str(&url));
                let _ = stdout.flush();
                d.browser.shutdown();
                return 3;
            }
        }
        let _ = stdout.flush();
    }
    d.browser.shutdown();
    0
}
