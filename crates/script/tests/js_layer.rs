//! Tests with the real JS DOM layer (crates/script/js/*.js) loaded.

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use blitz_dom::{Document, EventDriver};
use blitz_traits::SmolStr;
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, KeyState, MouseEventButton,
    MouseEventButtons, PointerCoords, UiEvent,
};
use common::Env;
use keyboard_types::{Code, Key, Location, Modifiers};
use script::JsEventHandler;

const PAGE: &str = r#"<!DOCTYPE html><html><head><title>Smoke</title></head>
<body style="margin:0">
<button id="btn" style="position:absolute;left:0;top:0;width:100px;height:30px">Go</button>
<div id="a" style="position:absolute;top:50px">hello <b>world</b></div>
</body></html>"#;

fn js_env(html: &str) -> Env {
    let mut e = Env::with_profile(html, PathBuf::new(), true);
    e.doc.resolve(0.0);
    e
}

fn pointer(x: f32, y: f32, buttons: MouseEventButtons) -> BlitzPointerEvent {
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    }
}

fn send(e: &mut Env, ev: UiEvent) {
    let doc: &mut dyn Document = &mut e.doc;
    let mut driver = EventDriver::new(doc, JsEventHandler { runtime: &mut e.rt });
    driver.handle_ui_event(ev);
}

/// Run due timers until none is due within `max`.
fn run_timers_for(e: &mut Env, max: Duration) {
    let end = Instant::now() + max;
    while let Some(deadline) = e.rt.next_timer_deadline() {
        if deadline > end {
            break;
        }
        let now = Instant::now();
        if deadline > now {
            std::thread::sleep(deadline - now);
        }
        e.rt.run_timers(&mut e.doc);
    }
}

/// The layer files that exist evaluate without errors and hide `__native`.
#[test]
fn js_layer_loads_cleanly() {
    let mut e = js_env(PAGE);
    let errors = e.host.errors();
    assert!(
        errors.is_empty(),
        "errors while loading the JS layer: {errors:#?}"
    );
    let stats = e.rt.startup_stats();
    assert!(stats.js_layer_files > 0);
    assert_eq!(e.eval("typeof __native"), "\"undefined\"");
}

/// Shape of the global environment the JS layer builds: global names with their types,
/// and the own property names of each global constructor's prototype.
const FINGERPRINT: &str = r#"(() => {
  const out = [];
  for (const k of Object.getOwnPropertyNames(globalThis).sort()) {
    let v, t;
    try { v = globalThis[k]; t = typeof v; } catch (e) { t = 'throws'; }
    let extra = '';
    if (t === 'function' && v.prototype && typeof v.prototype === 'object') {
      extra = ' ' + Object.getOwnPropertyNames(v.prototype).sort().join(',');
    }
    out.push(k + ':' + t + extra);
  }
  return out.join('\n');
})()"#;

/// The context deserialized from the startup snapshot looks exactly like one where the
/// layer was executed normally (computed in a child process with snapshots disabled).
#[test]
fn snapshot_matches_normal_load() {
    let mut e = js_env(PAGE);
    let from_snapshot = e.rt.startup_stats().from_snapshot;
    let with_snapshot = e.eval(FINGERPRINT);
    let out = common::temp_dir("fingerprint").join("normal.txt");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "fingerprint_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("SCRIPT_NO_SNAPSHOT", "1")
        .env("FINGERPRINT_OUT", &out)
        .status()
        .unwrap();
    assert!(status.success());
    let normal = std::fs::read_to_string(&out).unwrap();
    assert_eq!(with_snapshot, normal);
    eprintln!("from_snapshot: {from_snapshot}; notes: {:?}", e.host.logs());
}

/// Helper for `snapshot_matches_normal_load` (runs in a child process).
#[test]
#[ignore = "helper run by snapshot_matches_normal_load"]
fn fingerprint_child() {
    let Some(out) = std::env::var_os("FINGERPRINT_OUT") else {
        return;
    };
    let mut e = js_env(PAGE);
    assert!(!e.rt.startup_stats().from_snapshot);
    let fp = e.eval(FINGERPRINT);
    std::fs::write(out, fp).unwrap();
}

/// End-to-end smoke test of the JS layer on top of the natives.
#[test]
fn js_layer_smoke() {
    let mut e = js_env(PAGE);
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    run_timers_for(&mut e, Duration::from_millis(50));
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());

    // querySelector / textContent
    assert_eq!(
        e.eval("document.querySelector('#a').textContent"),
        r#""hello world""#
    );
    assert_eq!(e.eval("document.querySelectorAll('body *').length"), "3");
    assert_eq!(e.eval("document.title"), r#""Smoke""#);

    // createElement + appendChild
    let r = e.eval(
        r#"
        const d = document.createElement('div');
        d.id = 'new';
        d.textContent = 'x';
        document.body.appendChild(d);
        [document.getElementById('new') === d, d.parentNode === document.body, d.outerHTML]
    "#,
    );
    assert_eq!(r, r#"[true,true,"<div id=\"new\">x</div>"]"#);

    // addEventListener + a native click through blitz's EventDriver
    e.eval(
        r#"
        globalThis.clicks = [];
        const btn = document.getElementById('btn');
        btn.addEventListener('click', ev => clicks.push(ev.type + ':' + ev.target.id + ':' + (ev instanceof MouseEvent)));
        document.addEventListener('click', ev => clicks.push('doc:' + ev.eventPhase));
        1
    "#,
    );
    send(
        &mut e,
        UiEvent::PointerMove(pointer(10.0, 10.0, MouseEventButtons::None)),
    );
    send(
        &mut e,
        UiEvent::PointerDown(pointer(10.0, 10.0, MouseEventButtons::Primary)),
    );
    send(
        &mut e,
        UiEvent::PointerUp(pointer(10.0, 10.0, MouseEventButtons::None)),
    );
    assert_eq!(e.eval("clicks"), r#"["click:btn:true","doc:3"]"#);

    // setTimeout ordering, microtasks between tasks
    e.eval(
        r#"
        globalThis.order = [];
        setTimeout(() => { order.push('t2'); }, 5);
        setTimeout(() => { order.push('t1'); Promise.resolve().then(() => order.push('micro')); }, 0);
        1
    "#,
    );
    run_timers_for(&mut e, Duration::from_millis(100));
    assert_eq!(e.eval("order"), r#"["t1","micro","t2"]"#);

    // Uncaught errors reach window.onerror / the error event.
    e.eval(
        r#"
        globalThis.seen = [];
        window.addEventListener('error', ev => seen.push(ev.message));
        setTimeout(() => { throw new Error('boom'); }, 0);
        1
    "#,
    );
    run_timers_for(&mut e, Duration::from_millis(50));
    assert_eq!(e.eval("seen.length"), "1");
    assert!(e.host.errors().iter().any(|m| m.contains("boom")));
}

/// Parser-inserted scripts (inline and external), readyState, DOMContentLoaded / load.
#[test]
fn js_layer_page_scripts() {
    let page = r#"<!DOCTYPE html><html><head>
<script>window.log = ['inline:' + document.readyState];
document.addEventListener('DOMContentLoaded', () => log.push('dcl'));
window.addEventListener('load', () => log.push('load:' + document.readyState));</script>
<script src="ext.js"></script>
<script defer src="deferred.js"></script>
</head><body><p id="p">text</p><script>log.push('body:' + document.getElementById('p').textContent);</script></body></html>"#;
    let mut e = js_env(page);
    e.host.serve(
        "https://example.com/dir/ext.js",
        "text/javascript",
        "log.push('ext:' + !!document.getElementById('p'));",
    );
    e.host.serve(
        "https://example.com/dir/deferred.js",
        "text/javascript",
        "log.push('defer');",
    );
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    for _ in 0..10 {
        e.serve_fetches();
        run_timers_for(&mut e, Duration::from_millis(20));
        let doc = &mut e.doc;
        e.rt.resources_loaded(doc);
    }
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());
    assert_eq!(
        e.eval("log"),
        r#"["inline:loading","ext:true","body:text","defer","dcl","load:complete"]"#
    );
}

/// A broader tour of Web APIs implemented by the JS layer over the natives.
#[test]
fn js_layer_web_apis() {
    let page = r#"<!DOCTYPE html><html><head><style>.big { width: 300px; height: 40px; }</style></head>
<body style="margin:0"><div id="box" class="big" onclick="window.attrClicks = (window.attrClicks || 0) + 1">box</div>
<form id="f" action="/submit"><input name="q" value="init"><button id="b">Go</button></form>
<script type="module">import { v } from './mod.js'; window.modValue = v; window.metaUrl = import.meta.url;</script>
</body></html>"#;
    let mut e = js_env(page);
    e.host.serve(
        "https://example.com/dir/mod.js",
        "text/javascript",
        "export const v = 42;",
    );
    e.host.serve(
        "https://example.com/dir/data.json",
        "application/json",
        r#"{"answer": 7}"#,
    );
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    let settle = |e: &mut Env| {
        for _ in 0..6 {
            e.serve_fetches();
            run_timers_for(e, Duration::from_millis(10));
            let doc = &mut e.doc;
            e.rt.resources_loaded(doc);
            if e.rt.wants_frame() {
                let doc = &mut e.doc;
                e.rt.run_frame(doc, 16.0);
            }
        }
    };
    settle(&mut e);
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());
    // import.meta.url of an inline module is the document's base URL.
    assert_eq!(
        e.eval("[modValue, metaUrl]"),
        r#"[42,"https://example.com/dir/page.html"]"#
    );

    // DOM + CSSOM + layout
    let r = e.eval(
        r#"
        const box = document.getElementById('box');
        box.classList.add('x');
        box.style.backgroundColor = 'red';
        const rect = box.getBoundingClientRect();
        [box.className, box.getAttribute('style'), getComputedStyle(box).width, rect.width, rect.height,
         document.querySelectorAll('form input, form button').length, box.outerHTML.startsWith('<div id="box"')]
    "#,
    );
    assert_eq!(
        r,
        r#"["big x","background-color: red;","300px",300,40,2,true]"#
    );

    // Inline handler attribute + synthetic click
    assert_eq!(
        e.eval("document.getElementById('box').click(); attrClicks"),
        "1"
    );

    // fetch() + async/await + JSON
    e.eval("globalThis.got = null; (async () => { const r = await fetch('data.json'); got = [r.status, (await r.json()).answer]; })(); 1");
    settle(&mut e);
    assert_eq!(e.eval("got"), "[200,7]");

    // Storage, URL, TextEncoder, structuredClone, timers, rAF, MutationObserver
    let r = e.eval(
        r#"
        localStorage.setItem('k', 'v');
        sessionStorage.setItem('s', '1');
        const u = new URL('../x?y=1#z', location.href);
        const bytes = new TextEncoder().encode('é');
        const clone = structuredClone({ a: [1, { b: 2 }], d: new Date(0) });
        globalThis.mo = [];
        new MutationObserver(recs => mo.push(recs.length)).observe(document.body, { childList: true });
        document.body.appendChild(document.createElement('span'));
        globalThis.raf = 0; requestAnimationFrame(() => raf++);
        [localStorage.getItem('k'), sessionStorage.length, u.href, Array.from(bytes), clone.a[1].b, clone.d instanceof Date]
    "#,
    );
    assert_eq!(
        r,
        r#"["v",1,"https://example.com/x?y=1#z",[195,169],2,true]"#
    );
    settle(&mut e);
    assert_eq!(e.eval("[mo.length > 0, raf]"), "[true,1]");

    // history / location
    let r = e.eval(
        r#"
        globalThis.pops = [];
        addEventListener('popstate', ev => pops.push(ev.state));
        history.pushState({ n: 1 }, '', '?page=2');
        [location.search, history.length, history.state.n]
    "#,
    );
    assert_eq!(r, r#"["?page=2",2,1]"#);
    let doc = &mut e.doc;
    e.rt.history_traversed(doc, "https://example.com/dir/page.html", 0);
    assert_eq!(
        e.eval("[location.search, JSON.stringify(pops)]"),
        r#"["","[null]"]"#
    );

    // Form submission through a native click on the button.
    e.eval("document.querySelector('input[name=q]').value = 'hello'; document.getElementById('b').click(); 1");
    assert_eq!(
        e.host
            .navigations
            .borrow()
            .last()
            .map(|n| n.url.clone())
            .as_deref(),
        Some("https://example.com/submit?q=hello")
    );
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());
}

fn click_at(e: &mut Env, x: f32, y: f32) {
    send(
        e,
        UiEvent::PointerMove(pointer(x, y, MouseEventButtons::None)),
    );
    send(
        e,
        UiEvent::PointerDown(pointer(x, y, MouseEventButtons::Primary)),
    );
    send(
        e,
        UiEvent::PointerUp(pointer(x, y, MouseEventButtons::None)),
    );
    e.doc.resolve(0.0);
}

fn key(e: &mut Env, k: Key, code: Code, text: Option<&str>) {
    let ev = BlitzKeyEvent {
        key: k,
        code,
        modifiers: Modifiers::empty(),
        location: Location::Standard,
        is_auto_repeating: false,
        is_composing: false,
        state: KeyState::Pressed,
        text: text.map(SmolStr::new),
    };
    send(e, UiEvent::KeyDown(ev.clone()));
    send(
        e,
        UiEvent::KeyUp(BlitzKeyEvent {
            state: KeyState::Released,
            ..ev
        }),
    );
}

/// Native input through blitz's EventDriver with the real layer: default actions run
/// exactly once (Rust performs activation behavior; the layer only dispatches).
#[test]
fn js_layer_native_default_actions() {
    let page = r#"<!DOCTYPE html><html><body style="margin:0">
<div style="height:40px"><input id="cb" type="checkbox" style="width:20px;height:20px;margin:0"></div>
<div style="height:40px"><a id="link" href="/next" style="display:block;width:100px;height:20px">next</a></div>
<form id="f" action="/search"><div style="height:40px"><input id="q" name="q" style="width:200px;height:20px"></div>
<button id="go">Go</button></form>
</body></html>"#;
    let mut e = js_env(page);
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    run_timers_for(&mut e, Duration::from_millis(20));
    e.eval(
        r#"
        globalThis.log = [];
        for (const t of ['click', 'input', 'change', 'submit', 'keydown', 'keypress'])
          document.addEventListener(t, ev => log.push(t + '@' + ev.target.id), true);
        1
    "#,
    );
    click_at(&mut e, 10.0, 10.0);
    assert_eq!(
        e.eval("[document.getElementById('cb').checked, log.join(' ')]"),
        r#"[true,"click@cb input@cb change@cb"]"#
    );
    e.eval("log.length = 0; 1");
    click_at(&mut e, 20.0, 50.0);
    assert_eq!(e.host.navigations.borrow().len(), 1);
    assert_eq!(
        e.host.navigations.borrow()[0].url,
        "https://example.com/next"
    );
    // Typing then Enter: one implicit submission.
    click_at(&mut e, 10.0, 90.0);
    key(&mut e, Key::Character("a".into()), Code::KeyA, Some("a"));
    e.eval("log.length = 0; 1");
    key(&mut e, Key::Enter, Code::Enter, None);
    let log = e.eval("log.join(' ')");
    assert_eq!(log.matches("submit@f").count(), 1, "{log}");
    assert_eq!(e.host.navigations.borrow().len(), 2);
    assert_eq!(
        e.host.navigations.borrow()[1].url,
        "https://example.com/search?q=a"
    );
    // Change fires once when the edited field loses focus.
    e.eval("log.length = 0; 1");
    click_at(&mut e, 10.0, 90.0);
    key(&mut e, Key::Character("b".into()), Code::KeyB, Some("b"));
    key(&mut e, Key::Tab, Code::Tab, None);
    let log = e.eval("log.join(' ')");
    assert_eq!(log.matches("change@q").count(), 1, "{log}");
    assert_eq!(e.eval("document.activeElement.id"), r#""go""#);
    // Keyboard activation: Space on the focused checkbox, Enter on a focused button.
    e.eval("document.getElementById('cb').focus(); log.length = 0; 1");
    key(&mut e, Key::Character(" ".into()), Code::Space, Some(" "));
    assert_eq!(
        e.eval("[document.getElementById('cb').checked, log.join(' ')]"),
        r#"[false,"keydown@cb keypress@cb click@cb input@cb change@cb"]"#
    );
    e.eval("document.getElementById('go').focus(); 1");
    key(&mut e, Key::Enter, Code::Enter, None);
    assert_eq!(e.host.navigations.borrow().len(), 3);
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());
}

/// `<template>` contents through the layer (backed by `N.templateContent`).
#[test]
fn js_layer_templates() {
    let mut e = js_env(
        r#"<!DOCTYPE html><html><body><template id="t"><b>x</b><template id="inner"><i>n</i></template></template><div id="d"></div></body></html>"#,
    );
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    run_timers_for(&mut e, Duration::from_millis(20));
    let r = e.eval(
        r#"
        const t = document.getElementById('t');
        const d = document.getElementById('d');
        d.innerHTML = '<template><i>y</i></template>';
        const t2 = d.firstChild;
        const innerBefore = document.getElementById('inner');
        document.body.appendChild(t.content.cloneNode(true));
        [t.content.firstChild.textContent, document.querySelectorAll('b').length, t.childNodes.length,
         t.innerHTML, t2.content.textContent, d.querySelector('i'), t.content instanceof DocumentFragment,
         innerBefore, t.content.querySelector('template').content.textContent,
         document.getElementById('inner').content.textContent]
    "#,
    );
    assert_eq!(
        r,
        r#"["x",1,0,"<b>x</b><template id=\"inner\"><i>n</i></template>","y",null,true,null,"n","n"]"#
    );
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());
}

/// Import maps in the document apply to module scripts and dynamic imports.
#[test]
fn js_layer_import_maps() {
    let page = r#"<!DOCTYPE html><html><head>
<script type="importmap">{"imports": {"dep": "./lib/dep.js", "util/": "/shared/util/"}}</script>
<script type="module">import d from 'dep'; window.d = d; window.u = (await import('util/x.js')).x;</script>
</head><body></body></html>"#;
    let mut e = js_env(page);
    e.host.serve(
        "https://example.com/dir/lib/dep.js",
        "text/javascript",
        "import { x } from 'util/x.js'; export default 'dep+' + x;",
    );
    e.host.serve(
        "https://example.com/shared/util/x.js",
        "application/javascript",
        "export const x = 'x';",
    );
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    for _ in 0..6 {
        e.serve_fetches();
        run_timers_for(&mut e, Duration::from_millis(10));
    }
    assert!(e.host.errors().is_empty(), "{:#?}", e.host.errors());
    assert_eq!(e.eval("[d, u]"), r#"["dep+x","x"]"#);
}
