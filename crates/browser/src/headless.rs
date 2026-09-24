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
    /// Scroll by this many CSS px after load (before the screenshot).
    pub scroll_y: f64,
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
            print_console: false,
            timings: true,
            clicks: Vec::new(),
            scroll_y: 0.0,
        }
    }
}

struct Driver {
    browser: Browser,
    #[allow(dead_code)]
    tab: TabId,
    print_console: bool,
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
                        if self.print_console {
                            if let BrowserEvent::Tab(_, FromRenderer::Console { level, message }) = &ev {
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
    };

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
        d.pump_until(Duration::from_millis(300), |_| false);
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
            let errors = t.console.iter().filter(|(l, _)| l == "error").count();
            if errors > 0 {
                eprintln!("[headless] {errors} console error(s) (use --console to show)");
            }
        }
    }
    d.browser.shutdown();
    exit
}
