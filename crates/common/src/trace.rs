//! Startup tracing: `BROWSER_TRACE_STARTUP=1` prints milestones with the time since the
//! process started (to find what makes startup slow). On Windows the windowed browser
//! always records them in its log file (`<profile>/logs/browser.log`).

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Once, OnceLock};
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();
static ENABLED: AtomicBool = AtomicBool::new(false);
static FROM_ENV: Once = Once::new();

/// Call as early as possible in `main`.
pub fn init() {
    START.get_or_init(Instant::now);
}

pub fn enabled() -> bool {
    FROM_ENV.call_once(|| {
        if std::env::var_os("BROWSER_TRACE_STARTUP").is_some() {
            ENABLED.store(true, Ordering::Relaxed);
        }
    });
    ENABLED.load(Ordering::Relaxed)
}

/// Turn tracing on for this process (child processes follow `BROWSER_TRACE_STARTUP`).
pub fn enable() {
    FROM_ENV.call_once(|| {});
    ENABLED.store(true, Ordering::Relaxed);
}

/// Print a milestone (no-op unless enabled).
pub fn mark(what: &str) {
    if enabled() {
        let t = START.get_or_init(Instant::now).elapsed();
        // One write per line: several processes may share the same log file.
        let line = format!(
            "[trace {:>7.1} ms] [{}] {what}\n",
            t.as_secs_f64() * 1000.0,
            std::process::id()
        );
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }
}
