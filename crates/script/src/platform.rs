//! Process-wide V8 initialization.

use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_START: OnceLock<Instant> = OnceLock::new();
static V8_INIT: OnceLock<()> = OnceLock::new();

/// Monotonic reference point shared by [`crate::animation_time`].
pub(crate) fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

/// Initialize ICU data and the V8 platform exactly once per process.
pub(crate) fn init_v8() {
    V8_INIT.get_or_init(|| {
        process_start();
        // ICU data must match the ICU version compiled into the prebuilt V8 (78).
        // Release builds ship it as `resources/icudtl.dat` (like Chrome); development
        // builds may embed it (feature `embedded-icu`).
        let data: Option<&'static [u8]> = match common::resources::read("icudtl.dat") {
            Some(bytes) => Some(Box::leak(bytes.into_boxed_slice())),
            None => {
                #[cfg(feature = "embedded-icu")]
                {
                    Some(deno_core_icudata::ICU_DATA)
                }
                #[cfg(not(feature = "embedded-icu"))]
                {
                    None
                }
            }
        };
        match data {
            Some(d) => {
                if let Err(code) = v8::icu::set_common_data_78(d) {
                    eprintln!("script: failed to load ICU data (error {code}); Intl will be limited");
                }
            }
            None => eprintln!(
                "script: {} not found; Intl will be limited",
                common::resources::path("icudtl.dat").display()
            ),
        }
        // Harmony features shipped in Chrome are on by default; keep flags minimal.
        v8::V8::set_flags_from_string("--no-freeze-flags-after-init");
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

/// Run pending foreground platform tasks (e.g. FinalizationRegistry cleanup, wasm
/// compilation results). Cheap when there is nothing to do.
pub(crate) fn pump_message_loop(isolate: &v8::Isolate) {
    let platform = v8::V8::get_current_platform();
    let mut n = 0;
    while v8::Platform::pump_message_loop(&platform, isolate, false) {
        n += 1;
        if n > 64 {
            break;
        }
    }
}
