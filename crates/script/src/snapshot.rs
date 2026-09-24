//! V8 startup snapshot of a context in which the JS layer has already run.
//!
//! Executing the JS layer (`js/*.js`) costs ~100 ms per runtime, most of it spent
//! defining thousands of accessors. Instead, the first runtime of a process builds a
//! snapshot: a separate snapshot-creator isolate installs the natives, runs the layer
//! and serializes the heap. Runtimes then deserialize that context (a few ms).
//!
//! * The blob holds two contexts: the default context (only `__native` installed, for
//!   runtimes created with `load_js_layer: false`) and context 0 (the JS layer loaded).
//! * V8 aborts when isolates created from different snapshots run concurrently, and when
//!   a snapshot is created while other isolates are active. So the choice is made once
//!   per process, by the first `ScriptRuntime::new` (before any isolate exists): every
//!   isolate of the process is then created from the blob (built right then if needed),
//!   or, if snapshots are disabled or unusable, none is.
//! * The blob is cached on disk under `<profile_dir>/cache/`, keyed by the JS sources,
//!   the natives table, the V8 version and the executable, so later renderer processes
//!   load it directly.
//! * Only natives without per-document state may run while the layer loads (see
//!   [`SAFE_DURING_LOAD`]); if the layer calls another one (e.g. `N.location()` at load
//!   time), the result would be baked into the snapshot, so snapshotting is abandoned
//!   and every runtime runs the layer normally. The same happens on load errors and when
//!   the layer does something else a snapshot can't reproduce (see [`PROBE`]).
//! * Native functions find their `RuntimeState` through an isolate data slot (no
//!   `External`s in the heap) and their callbacks are listed as external references.
//! * The hooks object registered with `N.setHooks` is stored as context data and
//!   re-registered after deserialization.
//! * A crash fuse on disk (`.inprogress` marker) disables snapshotting if creating it
//!   ever brought the process down.
//!
//! Set `SCRIPT_NO_SNAPSHOT=1` (or call [`crate::set_snapshots_enabled`] before the first
//! runtime is created) to disable.

use std::borrow::Cow;
use std::cell::RefCell;
use std::hash::Hasher;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use crate::ScriptHost;
use crate::runtime::{JS_LAYER_FILES, exception_text, run_classic};
use crate::state::{RuntimeState, StatePtr};

/// Isolate data slot holding the `*const RuntimeState` (read by every native).
pub(crate) const STATE_SLOT: u32 = 0;

/// Bump when the snapshot setup changes incompatibly.
const FORMAT_VERSION: u64 = 1;
const MAGIC: &[u8; 8] = b"BRSNAP01";

/// Natives the JS layer may call while it loads without making the snapshot
/// document-specific (they are pure or only register state that is re-established).
pub(crate) const SAFE_DURING_LOAD: &[&str] = &[
    "documentId",
    "setHooks",
    "log",
    "urlParse",
    "urlSet",
    "textEncode",
    "textDecode",
    "structuredClone",
    "cssSupports",
    "compileFunction",
];

static ENABLED: AtomicBool = AtomicBool::new(true);

pub(crate) fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
        && std::env::var_os("SCRIPT_NO_SNAPSHOT").is_none_or(|v| v.is_empty() || v == "0")
}

/// External references of the snapshot: the natives' callbacks, null-terminated.
pub(crate) fn external_references() -> &'static [v8::ExternalReference] {
    struct Refs(Vec<v8::ExternalReference>);
    // SAFETY: the table only holds function pointers (and the null terminator); it is
    // immutable once built.
    unsafe impl Send for Refs {}
    unsafe impl Sync for Refs {}
    static REFS: OnceLock<Refs> = OnceLock::new();
    &REFS
        .get_or_init(|| {
            let mut v: Vec<v8::ExternalReference> = crate::natives::callbacks()
                .iter()
                .map(|&(_, f)| v8::ExternalReference { function: f })
                .collect();
            v.push(v8::ExternalReference {
                pointer: std::ptr::null_mut(),
            });
            Refs(v)
        })
        .0
}

/// Outcome of the per-process snapshot decision.
struct Snapshot {
    blob: Option<&'static [u8]>,
    /// What happened (reported once, at level "debug", through the first host).
    note: Option<String>,
}

static SNAPSHOT: OnceLock<Snapshot> = OnceLock::new();

/// The startup snapshot every isolate of this process is created from (`None`: the
/// built-in V8 snapshot). Decided by the first call in the process, before any isolate
/// exists: unless snapshots are disabled, the blob is loaded or created then (runtimes
/// without the JS layer use its clean default context).
pub(crate) fn process_blob(profile_dir: &Path, host: &dyn ScriptHost) -> Option<&'static [u8]> {
    let mut first = false;
    let s = SNAPSHOT.get_or_init(|| {
        first = true;
        if enabled() {
            load_or_create(profile_dir)
        } else {
            Snapshot {
                blob: None,
                note: None,
            }
        }
    });
    if first && let Some(note) = &s.note {
        host.console("debug", note);
    }
    s.blob
}

fn leak(v: Vec<u8>) -> &'static [u8] {
    Box::leak(v.into_boxed_slice())
}

fn load_or_create(profile_dir: &Path) -> Snapshot {
    let Some(key) = snapshot_key() else {
        return create_in_memory();
    };
    if profile_dir.as_os_str().is_empty() {
        return create_in_memory();
    }
    let dir = profile_dir.join("cache");
    let base = format!("script-snapshot-{key:016x}");
    let bin = dir.join(format!("{base}.bin"));
    let failed = dir.join(format!("{base}.failed"));
    let inprogress = dir.join(format!("{base}.inprogress"));

    if let Some(blob) = read_blob(&bin, key) {
        return Snapshot {
            blob: Some(leak(blob)),
            note: None,
        };
    }
    if failed.exists() {
        let why = std::fs::read_to_string(&failed).unwrap_or_default();
        return Snapshot {
            blob: None,
            note: Some(format!("JS layer snapshot disabled: {why}")),
        };
    }
    if let Ok(meta) = std::fs::metadata(&inprogress) {
        let age = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok());
        if age.is_some_and(|a| a < Duration::from_secs(120)) {
            // Another process is creating it right now; run the layer normally.
            return Snapshot {
                blob: None,
                note: None,
            };
        }
        // A previous attempt never finished: assume it crashed the process.
        let _ = std::fs::write(&failed, "a previous snapshot creation did not complete");
        let _ = std::fs::remove_file(&inprogress);
        return Snapshot {
            blob: None,
            note: Some("JS layer snapshot disabled: a previous creation attempt crashed".into()),
        };
    }
    if std::fs::create_dir_all(&dir).is_err()
        || std::fs::write(&inprogress, std::process::id().to_string()).is_err()
    {
        return create_in_memory();
    }
    let t0 = std::time::Instant::now();
    let result = create();
    let snapshot = match result {
        Ok(blob) => {
            write_blob(&dir, &bin, key, &blob);
            let note = format!(
                "created the JS layer snapshot ({} KiB) in {:?}",
                blob.len() / 1024,
                t0.elapsed()
            );
            Snapshot {
                blob: Some(leak(blob)),
                note: Some(note),
            }
        }
        Err(why) => {
            let _ = std::fs::write(&failed, &why);
            Snapshot {
                blob: None,
                note: Some(format!("JS layer snapshot disabled: {why}")),
            }
        }
    };
    let _ = std::fs::remove_file(&inprogress);
    snapshot
}

fn create_in_memory() -> Snapshot {
    let t0 = std::time::Instant::now();
    match create() {
        Ok(blob) => {
            let note = format!(
                "created the JS layer snapshot ({} KiB) in {:?}",
                blob.len() / 1024,
                t0.elapsed()
            );
            Snapshot {
                blob: Some(leak(blob)),
                note: Some(note),
            }
        }
        Err(why) => Snapshot {
            blob: None,
            note: Some(format!("JS layer snapshot disabled: {why}")),
        },
    }
}

/// Identity of everything the snapshot depends on; `None` if the executable can't be
/// identified (then only an in-memory snapshot is used).
fn snapshot_key() -> Option<u64> {
    let exe = std::env::current_exe().ok()?;
    let meta = std::fs::metadata(&exe).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()?;
    let mut h = std::hash::DefaultHasher::new();
    h.write_u64(FORMAT_VERSION);
    h.write(exe.as_os_str().as_encoded_bytes());
    h.write_u64(meta.len());
    h.write_u128(mtime.as_nanos());
    h.write(v8::V8::get_version().as_bytes());
    h.write(env!("CARGO_PKG_VERSION").as_bytes());
    for &(name, _) in crate::natives::callbacks() {
        h.write(name.as_bytes());
    }
    for (name, source) in JS_LAYER_FILES {
        h.write(name.as_bytes());
        h.write(source.as_bytes());
    }
    Some(h.finish())
}

/// Fast 64-bit checksum (corruption/truncation detection, not adversarial).
fn checksum(data: &[u8]) -> u64 {
    let mut h: u64 = 0x9e37_79b9_7f4a_7c15 ^ data.len() as u64;
    let mut chunks = data.chunks_exact(8);
    for c in &mut chunks {
        let w = u64::from_le_bytes(c.try_into().unwrap());
        h = (h.rotate_left(5) ^ w).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    for &b in chunks.remainder() {
        h = (h.rotate_left(5) ^ b as u64).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    h
}

fn read_blob(path: &Path, key: u64) -> Option<Vec<u8>> {
    let data = std::fs::read(path).ok()?;
    if data.len() < 32 || &data[..8] != MAGIC {
        return None;
    }
    let word = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
    let (k, len, sum) = (word(8), word(16) as usize, word(24));
    let blob = &data[32..];
    if k != key || blob.len() != len || checksum(blob) != sum {
        return None;
    }
    let startup = v8::StartupData::from(blob.to_vec());
    if !startup.is_valid() {
        return None;
    }
    Some(blob.to_vec())
}

fn write_blob(dir: &Path, path: &Path, key: u64, blob: &[u8]) {
    // Remove snapshots of other builds.
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("script-snapshot-")
                && e.path() != path
                && !name.ends_with(".inprogress")
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let mut out = Vec::with_capacity(blob.len() + 32);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&key.to_le_bytes());
    out.extend_from_slice(&(blob.len() as u64).to_le_bytes());
    out.extend_from_slice(&checksum(blob).to_le_bytes());
    out.extend_from_slice(blob);
    let tmp: PathBuf = path.with_extension(format!("tmp{}", std::process::id()));
    if std::fs::write(&tmp, &out).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Host of the snapshot-creator runtime: nothing may reach the outside world.
#[derive(Default)]
struct CreatorHost {
    errors: RefCell<Vec<String>>,
}

impl ScriptHost for CreatorHost {
    fn fetch(&self, _: common::protocol::NetRequest) {}
    fn abort_fetch(&self, _: u64) {}
    fn get_cookies(&self, _: &str) -> String {
        String::new()
    }
    fn set_cookie(&self, _: &str, _: &str) {}
    fn navigate(&self, _: &str, _: bool, _: &str, _: Option<Vec<u8>>, _: Option<String>) {}
    fn open_new_tab(&self, _: &str) {}
    fn history_go(&self, _: i32) {}
    fn url_changed(&self, _: &str) {}
    fn title_changed(&self, _: &str) {}
    fn console(&self, level: &str, message: &str) {
        if level == "error" {
            self.errors.borrow_mut().push(message.to_string());
        }
    }
    fn request_redraw(&self) {}
}

/// Runs before the layer in the snapshot creator. Detects load-time behavior that a
/// snapshot cannot reproduce:
/// * `globalThis` used as a key of a Map/Set/WeakMap/WeakSet that is still alive once
///   the layer has loaded: the global proxy is recreated on deserialization with a new
///   identity hash, so such entries would become unreachable;
/// * `Date.now()` / `Math.random()`: their results would be identical in every page.
///
/// Methods the layer captured during load keep working (they forward to the originals).
const PROBE: &str = r#"(() => {
  const g = globalThis;
  const hits = [];
  const keyed = [];
  const restore = [];
  const note = (what) => { if (hits.length < 8 && !hits.includes(what)) hits.push(what); };
  const patch = (obj, name, onCall) => {
    const orig = obj[name];
    const wrapped = { [name](...args) { onCall(this, args); return Reflect.apply(orig, this, args); } }[name];
    Object.defineProperty(wrapped, 'length', { value: orig.length });
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    Object.defineProperty(obj, name, { ...desc, value: wrapped });
    restore.push(() => Object.defineProperty(obj, name, desc));
  };
  const keyedBy = (label) => (self, args) => {
    if (args[0] === g && keyed.length < 64) keyed.push({ label, ref: new WeakRef(self) });
  };
  patch(Map.prototype, 'set', keyedBy('globalThis used as a Map key'));
  patch(Set.prototype, 'add', keyedBy('globalThis used as a Set member'));
  patch(WeakMap.prototype, 'set', keyedBy('globalThis used as a WeakMap key'));
  patch(WeakSet.prototype, 'add', keyedBy('globalThis used as a WeakSet member'));
  patch(Date, 'now', () => note('Date.now() called'));
  patch(Math, 'random', () => note('Math.random() called'));
  return {
    restore() { for (const r of restore) r(); },
    // Call after a full GC: collections that still hold globalThis.
    findings() {
      for (const k of keyed) if (k.ref.deref() !== undefined) note(k.label + ' (still referenced after loading)');
      return hits;
    },
  };
})()"#;

/// Undo the probe's patches. `Err(reason)` if that failed or the probe saw something
/// a snapshot cannot reproduce.
fn finish_probe<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    probe: v8::Local<'s, v8::Object>,
) -> Result<(), String> {
    let call = |scope: &mut v8::PinScope<'s, '_>, name: &str| -> Option<v8::Local<'s, v8::Value>> {
        v8::tc_scope!(let tc, scope);
        let f = crate::cx::get_prop(tc, probe, name)?;
        let f = v8::Local::<v8::Function>::try_from(f).ok()?;
        let r = f.call(tc, probe.into(), &[])?;
        Some(v8::Local::new(tc, r))
    };
    if call(scope, "restore").is_none() {
        return Err("could not restore the builtins patched by the snapshot probe".into());
    }
    // Collect everything the load left behind so only live collections are reported.
    scope.clear_kept_objects();
    scope.low_memory_notification();
    let hits = call(scope, "findings").and_then(|h| v8::Local::<v8::Array>::try_from(h).ok());
    let Some(hits) = hits else {
        return Err("snapshot probe failed".into());
    };
    if hits.length() == 0 {
        return Ok(());
    }
    let mut list = Vec::new();
    for i in 0..hits.length() {
        if let Some(v) = hits.get_index(scope, i) {
            list.push(v.to_rust_string_lossy(scope));
        }
    }
    Err(format!(
        "while loading, the JS layer did something a snapshot cannot reproduce: {}",
        list.join("; ")
    ))
}

/// Build the snapshot blob: natives + JS layer in a snapshot-creator isolate.
fn create() -> Result<Vec<u8>, String> {
    create_from(JS_LAYER_FILES)
}

/// Build a snapshot blob from the given layer sources.
pub(crate) fn create_from(layer: &[(&str, &str)]) -> Result<Vec<u8>, String> {
    // V8's snapshot creator is not safe to run on several threads at once.
    static CREATING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = CREATING.lock().unwrap_or_else(|e| e.into_inner());
    let host = Rc::new(CreatorHost::default());
    let url = url::Url::parse("about:blank").unwrap();
    let state = Rc::new(RuntimeState::new(
        host.clone(),
        url,
        String::new(),
        PathBuf::new(),
    ));
    state.snapshotting.set(true);

    let refs = external_references();
    let mut isolate = v8::Isolate::snapshot_creator(Some(Cow::Borrowed(refs)), None);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_promise_reject_callback(crate::runtime::promise_reject_callback);
    isolate.set_slot(StatePtr(Rc::as_ptr(&state)));
    isolate.set_data(STATE_SLOT, Rc::as_ptr(&state) as *mut std::ffi::c_void);
    let watchdog = crate::watchdog::Watchdog::new(isolate.thread_safe_handle());
    watchdog.arm(crate::runtime::SCRIPT_TIMEOUT);

    let mut failure: Option<String> = None;
    {
        v8::scope!(let hs, &mut isolate);
        // Default context: natives only (runtimes without the JS layer).
        {
            let clean = v8::Context::new(hs, Default::default());
            let scope = &mut v8::ContextScope::new(hs, clean);
            crate::runtime::install_native_object(scope);
            scope.set_default_context(clean);
        }
        // Context 0: the JS layer loaded.
        let context = v8::Context::new(hs, Default::default());
        let scope = &mut v8::ContextScope::new(hs, context);
        crate::runtime::install_native_object(scope);
        let probe = match run_classic(scope, PROBE, "internal:///snapshot-probe.js") {
            Ok(p) => v8::Local::<v8::Object>::try_from(p).ok(),
            Err(_) => None,
        };
        if probe.is_none() {
            failure = Some("snapshot probe failed".into());
        }
        for (name, source) in layer {
            if failure.is_some() {
                break;
            }
            if let Err(e) = run_classic(scope, source, &format!("internal:///{name}")) {
                let text = match e.exception {
                    Some(exc) => exception_text(scope, exc),
                    None => "terminated".to_string(),
                };
                failure = Some(format!("error while loading {name}: {text}"));
                break;
            }
        }
        scope.perform_microtask_checkpoint();
        let probed = match probe {
            Some(p) => finish_probe(scope, p),
            None => Ok(()),
        };
        if failure.is_none() {
            if let Err(why) = probed {
                failure = Some(why);
            } else if let Some(name) = state.snapshot_taint.get() {
                failure = Some(format!(
                    "the JS layer called N.{name}() while loading (its result would be baked into the snapshot)"
                ));
            } else if !state.pending_rejections.borrow().is_empty() {
                failure = Some("unhandled promise rejection while loading the JS layer".into());
            } else if let Some(err) = host.errors.borrow().first() {
                failure = Some(format!("error while loading the JS layer: {err}"));
            }
        }
        if failure.is_none() {
            let hooks = state
                .hooks
                .borrow()
                .obj
                .as_ref()
                .map(|g| v8::Local::new(scope, g));
            if let Some(hooks) = hooks {
                let index = scope.add_context_data(context, hooks);
                if index != 0 {
                    failure = Some(format!("unexpected context data index {index}"));
                }
            }
            let index = scope.add_context(context);
            if index != 0 {
                failure = Some(format!("unexpected context index {index}"));
            }
        }
    }
    if watchdog.disarm() {
        isolate.cancel_terminate_execution();
        failure = Some("loading the JS layer timed out".into());
    }
    drop(watchdog);
    state.clear_v8_handles();
    if let Some(why) = failure {
        // A snapshot creator must still produce a blob before it can be disposed (the
        // default context is set).
        drop(isolate.create_blob(v8::FunctionCodeHandling::Clear));
        return Err(why);
    }
    let blob = isolate
        .create_blob(v8::FunctionCodeHandling::Keep)
        .ok_or_else(|| "V8 could not serialize the heap".to_string())?;
    Ok(blob.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Isolates from different snapshots must not run concurrently (see module docs):
    /// the tests creating isolates run one at a time.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        crate::platform::init_v8();
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
    use crate::runtime::{RuntimeOptions, ScriptRuntime};
    use std::time::Instant;

    fn leak_layer(files: Vec<(&'static str, String)>) -> &'static [(&'static str, &'static str)] {
        let v: Vec<(&'static str, &'static str)> = files
            .into_iter()
            .map(|(n, s)| (n, &*Box::leak(s.into_boxed_str())))
            .collect();
        Box::leak(v.into_boxed_slice())
    }

    fn runtime(
        host: Rc<CreatorHost>,
        blob: Option<&'static [u8]>,
        layer: &'static [(&'static str, &'static str)],
    ) -> ScriptRuntime {
        runtime_with(host, blob, layer, true)
    }

    fn runtime_with(
        host: Rc<CreatorHost>,
        blob: Option<&'static [u8]>,
        layer: &'static [(&'static str, &'static str)],
        load_js_layer: bool,
    ) -> ScriptRuntime {
        let opts = RuntimeOptions {
            document_url: "https://example.com/".into(),
            user_agent: "UA".into(),
            profile_dir: PathBuf::new(),
            load_js_layer,
        };
        ScriptRuntime::new_inner(host, opts, blob, layer, Instant::now())
    }

    fn eval(rt: &mut ScriptRuntime, src: &str) -> String {
        let mut doc = blitz_dom::BaseDocument::new(blitz_dom::DocumentConfig::default());
        rt.eval(&mut doc, src).unwrap_or_else(|e| panic!("{e}"))
    }

    const LAYER: &str = r#"
        const N = globalThis.__native;
        delete globalThis.__native;
        globalThis.NN = N;
        globalThis.x = [1, 2, 3].map(v => v * 2);
        globalThis.fired = [];
        globalThis.docIdAtLoad = N.documentId();
        class Widget { #secret = 7; get secret() { return this.#secret; } }
        const key = {};
        globalThis.key = key;
        globalThis.w = new WeakMap([[key, new Widget()]]);
        globalThis.m = new Map([['s', 'g'], [Object, 'o']]);
        const mapSet = Map.prototype.set;
        globalThis.captured = (m, k, v) => mapSet.call(m, k, v);
        globalThis.enc = new Uint8Array(N.textEncode('hé'));
        N.setHooks({ onTimer(id) { fired.push(id); } });
    "#;

    #[test]
    fn snapshot_roundtrip() {
        let _guard = lock();
        crate::platform::init_v8();
        let layer = leak_layer(vec![("a.js", LAYER.to_string())]);
        let blob = leak(create_from(layer).expect("snapshot"));
        let host = Rc::new(CreatorHost::default());
        let mut a = runtime(host.clone(), Some(blob), layer);
        assert!(a.startup_stats().from_snapshot);
        assert_eq!(
            eval(
                &mut a,
                "[typeof __native, x, w.get(key).secret, m.get('s'), m.get(Object), Array.from(enc), captured(new Map(), 1, 2).get(1)]"
            ),
            "[\"undefined\",[2,4,6],7,\"g\",\"o\",[104,195,169],2]"
        );
        // Natives work (state slot) and the hooks object was re-registered.
        eval(&mut a, "NN.setTimer(5, 0); 1");
        let mut doc = blitz_dom::BaseDocument::new(blitz_dom::DocumentConfig::default());
        std::thread::sleep(std::time::Duration::from_millis(2));
        a.run_timers(&mut doc);
        assert_eq!(eval(&mut a, "fired"), "[5]");
        assert_eq!(eval(&mut a, "NN.location()"), "\"https://example.com/\"");
        // The id handed out while loading (no document yet) is the real document's id.
        assert_eq!(eval(&mut a, "docIdAtLoad === NN.documentId()"), "true");
        let ra = eval(&mut a, "Math.random()");
        drop(a);
        // A second runtime from the same blob is independent (fresh globals, reseeded
        // Math.random).
        let mut b = runtime(host.clone(), Some(blob), layer);
        assert_eq!(eval(&mut b, "fired.length"), "0");
        assert_ne!(eval(&mut b, "Math.random()"), ra);
        drop(b);
        // Runtimes without the JS layer get the snapshot's clean default context.
        let mut c = runtime_with(host.clone(), Some(blob), layer, false);
        assert!(!c.startup_stats().from_snapshot);
        assert_eq!(
            eval(
                &mut c,
                "[typeof NN, typeof x, __native.documentId(), __native.urlParse('/a', 'https://h/')[0]]"
            ),
            "[\"undefined\",\"undefined\",2,\"https://h/a\"]"
        );
        drop(c);
        assert!(
            host.errors.borrow().is_empty(),
            "{:?}",
            host.errors.borrow()
        );
    }

    #[test]
    fn snapshot_refuses_document_state_and_errors() {
        let _guard = lock();
        crate::platform::init_v8();
        let err = create_from(&[("a.js", "const N = __native; globalThis.loc = N.location();")])
            .unwrap_err();
        assert!(err.contains("N.location"), "{err}");
        let err = create_from(&[("a.js", "throw new Error('broken layer')")]).unwrap_err();
        assert!(err.contains("broken layer"), "{err}");
        let err = create_from(&[("a.js", "Promise.reject(new Error('x'))")]).unwrap_err();
        assert!(err.contains("rejection"), "{err}");
        let err = create_from(&[(
            "a.js",
            "globalThis.reg = new WeakMap(); reg.set(globalThis, 1);",
        )])
        .unwrap_err();
        assert!(err.contains("WeakMap key"), "{err}");
        let err = create_from(&[("a.js", "globalThis.keep = new Set([globalThis]);")]).unwrap_err();
        assert!(err.contains("Set member"), "{err}");
        // Temporary collections holding globalThis are fine.
        create_from(&[(
            "a.js",
            "(() => { const seen = new Set(); seen.add(globalThis); return seen.size; })();",
        )])
        .unwrap();
        let err = create_from(&[("a.js", "globalThis.t0 = Date.now();")]).unwrap_err();
        assert!(err.contains("Date.now"), "{err}");
        // Builtins are restored after the probe.
        crate::platform::init_v8();
        let layer: &'static [(&'static str, &'static str)] =
            &[("a.js", "globalThis.captured = Map.prototype.set;")];
        let blob = leak(create_from(layer).unwrap());
        let mut rt = runtime(Rc::new(CreatorHost::default()), Some(blob), layer);
        assert_eq!(
            eval(
                &mut rt,
                "[Map.prototype.set.toString(), Math.random.toString(), captured === Map.prototype.set, captured.call(new Map(), 1, 2).get(1)]"
            ),
            "[\"function set() { [native code] }\",\"function random() { [native code] }\",false,2]"
        );
    }

    #[test]
    fn disk_format_detects_corruption() {
        let _guard = lock();
        let dir = std::env::temp_dir().join(format!("script-snapshot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::platform::init_v8();
        let blob = create_from(&[("a.js", "globalThis.y = 1;")]).unwrap();
        let path = dir.join("script-snapshot-0000000000000001.bin");
        write_blob(&dir, &path, 1, &blob);
        assert_eq!(read_blob(&path, 1).as_deref(), Some(&blob[..]));
        assert!(read_blob(&path, 2).is_none());
        let mut data = std::fs::read(&path).unwrap();
        let n = data.len();
        data[n / 2] ^= 0x40;
        std::fs::write(&path, &data).unwrap();
        assert!(read_blob(&path, 1).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
