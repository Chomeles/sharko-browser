//! Runtime state shared by the public API, natives and V8 callbacks.
//!
//! # Document access — safety invariants
//!
//! The renderer owns the `BaseDocument`. Every public `ScriptRuntime` method that may run
//! JS takes `&mut BaseDocument`; on entry it stores `doc as *mut BaseDocument` in
//! [`RuntimeState::doc`] (saving the previous value) and restores the previous value on
//! exit. While the pointer is set:
//!
//! 1. The renderer cannot touch the document: its `&mut` is borrowed by our method for
//!    the whole entry, and the method itself only accesses the document through the
//!    stored raw pointer from then on.
//! 2. Natives obtain a `&mut BaseDocument` through [`RuntimeState::doc`]. Such a
//!    reference must never be held across anything that can run JS (calling a JS
//!    function or hook, running a script, a microtask checkpoint). Code that needs to
//!    call into JS drops its reference first and re-acquires it afterwards. Hence at any
//!    point in time at most one `&mut BaseDocument` derived from the pointer is live: a
//!    nested native (called from JS) acquires its own reference, which ends before
//!    control returns to the outer code.
//! 3. Blitz code never calls into JS. Blitz calls the renderer's providers (net, shell,
//!    navigation), which per the `ScriptHost` contract must not re-enter the runtime.
//!
//! Outside of an entry the pointer is null and natives throw `InvalidStateError`
//! (e.g. a callback invoked by V8 during garbage collection).
//!
//! Interior mutability: fields use `Cell`/`RefCell`. `RefCell` borrows are always
//! short-lived and never held across calls into JS, so re-entrant natives can't observe
//! a borrow conflict.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Instant;

use blitz_dom::{BaseDocument, LocalName, NodeId};

use crate::ScriptHost;
use crate::cx::JsErr;
use crate::modules::ModuleLoader;
use crate::storage::Storage;
use crate::timers::Timers;

/// Hooks registered by the JS layer with `N.setHooks`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Hook {
    DocumentParsed,
    Event,
    Timer,
    Frame,
    Fetch,
    ResourcesLoaded,
    ViewportChanged,
    Scroll,
    PageHide,
    UnhandledRejection,
    RejectionHandled,
    Error,
    PopState,
    ElementEvent,
    WebSocket,
}

impl Hook {
    pub(crate) const ALL: [Hook; 15] = [
        Hook::DocumentParsed,
        Hook::Event,
        Hook::Timer,
        Hook::Frame,
        Hook::Fetch,
        Hook::ResourcesLoaded,
        Hook::ViewportChanged,
        Hook::Scroll,
        Hook::PageHide,
        Hook::UnhandledRejection,
        Hook::RejectionHandled,
        Hook::Error,
        Hook::PopState,
        Hook::ElementEvent,
        Hook::WebSocket,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Hook::DocumentParsed => "onDocumentParsed",
            Hook::Event => "onEvent",
            Hook::Timer => "onTimer",
            Hook::Frame => "onFrame",
            Hook::Fetch => "onFetch",
            Hook::ResourcesLoaded => "onResourcesLoaded",
            Hook::ViewportChanged => "onViewportChanged",
            Hook::Scroll => "onScroll",
            Hook::PageHide => "onPageHide",
            Hook::UnhandledRejection => "onUnhandledRejection",
            Hook::RejectionHandled => "onRejectionHandled",
            Hook::Error => "onError",
            Hook::PopState => "onPopState",
            Hook::ElementEvent => "onElementEvent",
            Hook::WebSocket => "onWebSocket",
        }
    }
}

#[derive(Default)]
pub(crate) struct Hooks {
    pub(crate) obj: Option<v8::Global<v8::Object>>,
    pub(crate) funcs: [Option<v8::Global<v8::Function>>; 15],
}

impl Hooks {
    pub(crate) fn get(&self, hook: Hook) -> Option<&v8::Global<v8::Function>> {
        self.funcs[hook as usize].as_ref()
    }
}

/// Work queued by Rust to run as its own task (from `run_timers`).
pub(crate) enum InternalTask {
    /// A handler was attached to a rejected promise already reported as unhandled.
    RejectionHandled(v8::Global<v8::Promise>, v8::Global<v8::Value>),
    /// The viewport was scrolled programmatically: fire `scroll` on the document.
    ViewportScroll,
    /// An element was scrolled programmatically: fire `scroll` at it.
    ElementScroll(NodeId),
}

/// Form control state that blitz doesn't track (HTML "dirty" flags, option
/// selectedness, values of input types without an editor).
#[derive(Default)]
pub(crate) struct FormState {
    /// Inputs/textareas whose value was changed by the user or by script.
    pub(crate) dirty_value: HashSet<NodeId>,
    /// Values of inputs in "value" mode without a text editor (range, color, date...).
    pub(crate) mode_value: HashMap<NodeId, String>,
    /// Checkboxes/radios whose checkedness was changed by the user or by script.
    pub(crate) dirty_checked: HashSet<NodeId>,
    /// Checkedness of non-checkbox/radio inputs (`input.checked` on other types).
    pub(crate) other_checked: HashMap<NodeId, bool>,
    /// Explicit `<option>` selectedness (absent: follows the `selected` attribute).
    pub(crate) selectedness: HashMap<NodeId, bool>,
    /// Value of the focused text control when it gained focus (for `change`).
    pub(crate) focus_value: Option<(NodeId, String)>,
    /// Checkboxes whose IDL `indeterminate` flag is set (`N.setIndeterminate`).
    pub(crate) indeterminate: HashSet<NodeId>,
}

impl FormState {
    pub(crate) fn forget(&mut self, id: NodeId) {
        self.dirty_value.remove(&id);
        self.mode_value.remove(&id);
        self.dirty_checked.remove(&id);
        self.other_checked.remove(&id);
        self.selectedness.remove(&id);
        self.indeterminate.remove(&id);
        if self.focus_value.as_ref().is_some_and(|(n, _)| *n == id) {
            self.focus_value = None;
        }
    }
}

/// Pointer interaction tracking used to synthesize DOM details blitz doesn't provide.
#[derive(Default)]
pub(crate) struct InputTracking {
    /// Last mousedown (time, x, y) for click counting.
    pub(crate) last_down: Option<(Instant, f32, f32)>,
    pub(crate) click_count: u32,
    /// Target of the last `mouseout`/`pointerout` (relatedTarget for the next `over`).
    pub(crate) last_out: Option<NodeId>,
    /// Node that lost focus most recently (relatedTarget for the following `focus`).
    pub(crate) last_blur: Option<NodeId>,
    /// An IME composition is in progress.
    pub(crate) composing: bool,
}

pub(crate) struct RuntimeState {
    pub(crate) host: Rc<dyn ScriptHost>,
    doc: Cell<*mut BaseDocument>,
    /// Nesting depth of entries into JS from the public API.
    pub(crate) depth: Cell<u32>,
    pub(crate) url: RefCell<url::Url>,
    pub(crate) user_agent: String,
    pub(crate) nav_start: Instant,
    pub(crate) time_origin: f64,
    pub(crate) hooks: RefCell<Hooks>,
    pub(crate) timers: RefCell<Timers>,
    pub(crate) tasks: RefCell<VecDeque<InternalTask>>,
    pub(crate) frame_requested: Cell<bool>,
    /// JS-layer fetch ids in flight.
    pub(crate) pending_fetches: RefCell<HashSet<u64>>,
    pub(crate) modules: RefCell<ModuleLoader>,
    pub(crate) storage: RefCell<Storage>,
    /// Style/layout known to be up to date (reset on every entry and every mutation).
    pub(crate) layout_clean: Cell<bool>,
    /// Signature of the stylesheet set + viewport at the last forced resolve.
    pub(crate) layout_sig: Cell<u64>,
    pub(crate) selector_cache: RefCell<HashMap<String, blitz_dom::SelectorList>>,
    pub(crate) pending_rejections: RefCell<Vec<(v8::Global<v8::Promise>, v8::Global<v8::Value>)>>,
    /// Rejections reported as unhandled (most recent last, bounded) for `rejectionhandled`.
    pub(crate) reported_rejections:
        RefCell<VecDeque<(v8::Global<v8::Promise>, v8::Global<v8::Value>)>>,
    /// Session history position `(index, length)` tracked by the runtime, used when the
    /// host doesn't report one (`ScriptHost::history_position`).
    pub(crate) history: Cell<(u32, u32)>,
    /// Local name of the elements emulating DocumentFragment nodes.
    pub(crate) fragment_atom: LocalName,
    /// `<template>` element -> content fragment.
    pub(crate) template_contents: RefCell<HashMap<NodeId, NodeId>>,
    pub(crate) forms: RefCell<FormState>,
    pub(crate) input: RefCell<InputTracking>,
    /// The JS layer was loaded (hooks may exist).
    pub(crate) js_layer: Cell<bool>,
    /// The runtime was created with the JS layer (it performs click activation behavior
    /// in its dispatch; see `activation::click_with_activation`).
    pub(crate) layer_loaded: Cell<bool>,
    /// Last sibling lookups (node, index in parent), one slot per parent (hashed), to make
    /// sibling iteration O(1) also while a recursive walk alternates between parents.
    pub(crate) sibling_hints: [Cell<(NodeId, usize)>; 64],
    /// Pending synthetic-click activations (`activationBegin`/`activationEnd`).
    #[allow(clippy::type_complexity)]
    pub(crate) activations: RefCell<(
        HashMap<u64, (NodeId, NodeId, crate::activation::PreActivation)>,
        u64,
    )>,
    /// Sequence for synchronous fetch ids.
    pub(crate) sync_fetch_seq: Cell<u64>,
    /// `blob:` URLs this runtime registered (revoked when it is dropped).
    pub(crate) blob_urls: RefCell<Vec<String>>,
    /// The main document's `<!DOCTYPE>` (name, public id, system id); `None`: the source
    /// had none. blitz-html drops it; the renderer may report it (`set_doctype`).
    pub(crate) doctype: RefCell<Option<(String, String, String)>>,
    /// Natives currently executing (> 0: JS is on the stack).
    pub(crate) native_depth: Cell<u32>,
    /// A microtask checkpoint (`runtime::end_of_task`) is running.
    pub(crate) in_checkpoint: Cell<bool>,
    /// This state belongs to the snapshot-creator isolate (see `snapshot.rs`).
    pub(crate) snapshotting: Cell<bool>,
    /// First native called during snapshot creation that is not snapshot-safe.
    pub(crate) snapshot_taint: Cell<Option<&'static str>>,
}

impl RuntimeState {
    /// The sibling-lookup hint slot of `parent`.
    #[inline]
    pub(crate) fn sibling_hint(&self, parent: NodeId) -> &Cell<(NodeId, usize)> {
        let k = parent.as_u64();
        &self.sibling_hints[((k ^ (k >> 32)) as usize) & 63]
    }

    pub(crate) fn new(
        host: Rc<dyn ScriptHost>,
        url: url::Url,
        user_agent: String,
        profile_dir: PathBuf,
    ) -> Self {
        let time_origin = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let storage = Storage::new(profile_dir, &url);
        RuntimeState {
            host,
            doc: Cell::new(std::ptr::null_mut()),
            depth: Cell::new(0),
            url: RefCell::new(url),
            user_agent,
            nav_start: Instant::now(),
            time_origin,
            hooks: RefCell::new(Hooks::default()),
            timers: RefCell::new(Timers::default()),
            tasks: RefCell::new(VecDeque::new()),
            frame_requested: Cell::new(false),
            pending_fetches: RefCell::new(HashSet::new()),
            modules: RefCell::new(ModuleLoader::default()),
            storage: RefCell::new(storage),
            layout_clean: Cell::new(false),
            layout_sig: Cell::new(0),
            selector_cache: RefCell::new(HashMap::new()),
            pending_rejections: RefCell::new(Vec::new()),
            reported_rejections: RefCell::new(VecDeque::new()),
            history: Cell::new((0, 1)),
            fragment_atom: LocalName::from("#document-fragment"),
            template_contents: RefCell::new(HashMap::new()),
            forms: RefCell::new(FormState::default()),
            input: RefCell::new(InputTracking::default()),
            js_layer: Cell::new(false),
            layer_loaded: Cell::new(false),
            sibling_hints: std::array::from_fn(|_| Cell::new((NodeId::default(), 0))),
            activations: RefCell::new((HashMap::new(), 0)),
            sync_fetch_seq: Cell::new(0),
            blob_urls: RefCell::new(Vec::new()),
            doctype: RefCell::new(Some(("html".into(), String::new(), String::new()))),
            native_depth: Cell::new(0),
            in_checkpoint: Cell::new(false),
            snapshotting: Cell::new(false),
            snapshot_taint: Cell::new(None),
        }
    }

    /// Install `doc` as the current document; returns the previous pointer, which must
    /// be restored with [`RuntimeState::restore_doc`] when the entry ends.
    pub(crate) fn set_doc(&self, doc: *mut BaseDocument) -> *mut BaseDocument {
        self.doc.replace(doc)
    }

    pub(crate) fn restore_doc(&self, prev: *mut BaseDocument) {
        self.doc.set(prev);
    }

    pub(crate) fn has_doc(&self) -> bool {
        !self.doc.get().is_null()
    }

    /// The document of the current entry. See the module docs for the invariants every
    /// caller must uphold (never hold the reference across a call into JS).
    #[allow(clippy::mut_from_ref)]
    pub(crate) fn doc(&self) -> Result<&mut BaseDocument, JsErr> {
        let ptr = self.doc.get();
        if ptr.is_null() {
            return Err(JsErr::dom("InvalidStateError", "no active document"));
        }
        // SAFETY: see module docs. The pointer comes from a `&mut BaseDocument` whose
        // borrow outlives the current entry, and no other reference derived from it is
        // live while natives run (invariant 2).
        Ok(unsafe { &mut *ptr })
    }

    /// The document URL as a string.
    pub(crate) fn url_string(&self) -> String {
        self.url.borrow().as_str().to_string()
    }

    /// Mark style/layout possibly stale (called after DOM mutations).
    #[inline]
    pub(crate) fn invalidate_layout(&self) {
        self.layout_clean.set(false);
    }

    pub(crate) fn queue_task(&self, task: InternalTask) {
        self.tasks.borrow_mut().push_back(task);
    }

    /// Drop all V8 handles held by the state (called before the isolate is disposed).
    pub(crate) fn clear_v8_handles(&self) {
        *self.hooks.borrow_mut() = Hooks::default();
        self.pending_rejections.borrow_mut().clear();
        self.reported_rejections.borrow_mut().clear();
        self.tasks.borrow_mut().clear();
        self.modules.borrow_mut().clear();
    }

    /// Session history `(index, length)`: the host's if it tracks it, else our own.
    pub(crate) fn history_position(&self) -> (u32, u32) {
        self.host
            .history_position()
            .unwrap_or_else(|| self.history.get())
    }

    /// Record a same-document navigation (pushState/replaceState/fragment): update the
    /// document URL and tell the host.
    pub(crate) fn same_document_navigation(&self, url: &url::Url, replace: bool) {
        *self.url.borrow_mut() = url.clone();
        if let Ok(doc) = self.doc() {
            doc.set_base_url(url.as_str());
        }
        self.storage.borrow_mut().set_url(url);
        if !replace {
            let (index, _) = self.history.get();
            self.history.set((index + 1, index + 2));
        }
        self.host.history_push(url.as_str(), replace);
        self.host.url_changed(url.as_str());
    }
}

/// Stored in the isolate slot so V8 callbacks that only receive a context (module
/// resolution, promise rejection, dynamic import, import.meta) can find the state.
#[derive(Clone, Copy)]
pub(crate) struct StatePtr(pub(crate) *const RuntimeState);

impl StatePtr {
    /// # Safety
    /// The runtime owning the state outlives its isolate (the isolate is disposed first
    /// in `ScriptRuntime::drop`), so the pointer is valid whenever V8 runs a callback.
    pub(crate) fn get<'a>(self) -> &'a RuntimeState {
        unsafe { &*self.0 }
    }
}
