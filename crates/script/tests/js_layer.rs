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

/// Web Crypto on the aws-lc-rs natives: known answers (checked against Chromium) for
/// AES-GCM, HMAC, PBKDF2 and SHA-256, and a failed authentication.
#[test]
fn js_layer_web_crypto() {
    let mut e = js_env(PAGE);
    e.eval(
        r#"globalThis.cr = null; (async () => {
      const S = crypto.subtle, enc = new TextEncoder();
      const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
      const bytes = (n, s) => new Uint8Array(n).map((_, i) => (i * s + 7) & 255);
      const msg = enc.encode('Hello, Sharko! The quick brown fox jumps over the lazy dog.');
      const gcm = await S.importKey('raw', bytes(32, 3), 'AES-GCM', true, ['encrypt', 'decrypt']);
      const params = { name: 'AES-GCM', iv: bytes(12, 5), additionalData: enc.encode('aad') };
      const ct = await S.encrypt(params, gcm, msg);
      const pt = new TextDecoder().decode(await S.decrypt(params, gcm, ct));
      let tamper = 'none';
      try { const c = new Uint8Array(ct).slice(); c[0] ^= 1; await S.decrypt(params, gcm, c); } catch (err) { tamper = err.name; }
      const hm = await S.importKey('raw', bytes(32, 3), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const pb = await S.importKey('raw', enc.encode('password'), 'PBKDF2', false, ['deriveBits']);
      const bits = await S.deriveBits({ name: 'PBKDF2', salt: enc.encode('salt'), iterations: 1000, hash: 'SHA-256' }, pb, 256);
      cr = [hex(ct).slice(0, 32), pt.slice(0, 6), tamper, hex(await S.sign('HMAC', hm, msg)).slice(0, 16),
        hex(bits).slice(0, 16), hex(await S.digest('SHA-256', msg)).slice(0, 16), String(gcm), gcm.algorithm.length];
    })(); 1"#,
    );
    run_timers_for(&mut e, Duration::from_millis(10));
    assert_eq!(
        e.eval("cr"),
        r#"["f5b251874e90c050b5106b700646beb4","Hello,","OperationError","a270d36291d79755","632c2812e46d4604","402e800b29584d63","[object CryptoKey]",256]"#
    );
}

/// An iframe document's runtime (`ScriptRuntime::new_frame`) next to the page's: `parent`
/// and `contentWindow` are remote windows, `postMessage` goes both ways (structured clone,
/// origin, `source` identity), and the runtimes can be dropped in any order.
#[test]
fn js_layer_frame_runtimes() {
    use std::rc::Rc;
    let mut page = js_env(
        r#"<!DOCTYPE html><html><body><iframe id="f" src="https://frame.example/x.html"></iframe></body></html>"#,
    );
    let iframe = page.doc.get_element_by_id("f").unwrap().as_u64();
    let frame_host = Rc::new(common::MockHost::default());
    let mut opts = common::options(PathBuf::new(), true);
    opts.document_url = "https://frame.example/x.html".into();
    let mut frame = script::ScriptRuntime::new_frame(frame_host.clone(), opts.clone());
    let mut frame_doc = common::make_doc("<!DOCTYPE html><html><body>child</body></html>");

    // frame -> page
    let r = frame
        .eval(
            &mut frame_doc,
            "parent.postMessage({ a: [1, 2], d: new Date(5) }, '*'); \
             [parent !== window, top === parent, String(parent), window.parent.window === parent]",
        )
        .unwrap();
    assert_eq!(r, r#"[true,true,"[object Window]",true]"#);
    let (target, target_origin, data) = frame_host.posted.borrow_mut().pop().unwrap();
    assert_eq!((target, target_origin.as_str()), (None, "*"));
    page.eval(
        "globalThis.got = []; addEventListener('message', (e) => got.push([e.data.a.join(), \
         e.data.d.getTime(), e.origin, e.source === document.getElementById('f').contentWindow])); 1",
    );
    page.rt
        .deliver_message(&mut page.doc, Some(iframe), "https://frame.example", &data);
    assert_eq!(page.eval("got"), r#"[["1,2",5,"https://frame.example",true]]"#);

    // page -> frame
    page.eval("document.getElementById('f').contentWindow.postMessage('hi', 'https://frame.example/y'); 1");
    let (target, target_origin, data) = page.host.posted.borrow_mut().pop().unwrap();
    assert_eq!((target, target_origin.as_str()), (Some(iframe), "https://frame.example"));
    frame
        .eval(&mut frame_doc, "globalThis.got = []; addEventListener('message', (e) => got.push([e.data, e.source === parent])); 1")
        .unwrap();
    frame.deliver_message(&mut frame_doc, None, "https://example.com", &data);
    assert_eq!(frame.eval(&mut frame_doc, "got").unwrap(), r#"[["hi",true]]"#);
    // Same-origin and about:blank iframes stay unscriptable from the page.
    assert_eq!(
        page.eval("const i = document.createElement('iframe'); document.body.append(i); i.contentWindow"),
        "null"
    );

    // Drop order: the frame's runtime (created later) first, then another frame's after
    // the page's.
    drop(frame);
    assert_eq!(page.eval("1 + 1"), "2");
    let mut late = script::ScriptRuntime::new_frame(Rc::new(common::MockHost::default()), opts);
    assert_eq!(late.eval(&mut frame_doc, "parent === window").unwrap(), "false");
    drop(page);
    assert_eq!(late.eval(&mut frame_doc, "2 + 2").unwrap(), "4");
    drop(late);
}

/// Canvas 2D (tiny-skia natives): fills, strokes, transforms, gradients, clipping, pixel
/// access, text metrics and PNG export; the pixels reach the element's image data.
#[test]
fn js_layer_canvas_2d() {
    let mut e = js_env(
        r#"<!DOCTYPE html><html><body><canvas id="c" width="100" height="60"></canvas></body></html>"#,
    );
    let r = e.eval(
        r#"(() => {
          const c = document.getElementById('c'), x = c.getContext('2d');
          const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data).join(',');
          x.fillStyle = 'red'; x.fillRect(0, 0, 10, 10);
          x.save(); x.translate(20, 0); x.rotate(Math.PI / 2); x.fillStyle = 'rgb(0, 0, 255)'; x.fillRect(0, 0, 10, 10); x.restore();
          x.beginPath(); x.rect(30, 0, 10, 10); x.clip(); x.fillStyle = 'lime'; x.fillRect(0, 0, 100, 60);
          x.restore(); x.save();
          const g = x.createLinearGradient(0, 0, 100, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
          x.globalAlpha = 1;
          const out = [px(5, 5), px(15, 5), px(35, 5), px(50, 5), x.fillStyle, x.getTransform().e];
          const y = document.createElement('canvas').getContext('2d');
          y.canvas.width = 50; y.canvas.height = 20;
          y.fillStyle = g; y.fillRect(0, 0, 50, 20);
          y.lineWidth = 4; y.strokeStyle = '#008000'; y.beginPath(); y.moveTo(0, 18); y.lineTo(50, 18); y.stroke();
          const d = y.getImageData(0, 0, 50, 20).data;
          out.push(d[0] < d[4 * 40], d[(18 * 50 + 10) * 4 + 1], y.measureText('Hallo').width > 10, c.toDataURL().startsWith('data:image/png;base64,iVBOR'));
          y.putImageData(new ImageData(new Uint8ClampedArray([1, 2, 3, 255]), 1, 1), 0, 0);
          out.push(Array.from(y.getImageData(0, 0, 1, 1).data).join(','));
          return out;
        })()"#,
    );
    assert_eq!(
        r,
        r##"["255,0,0,255","0,0,255,255","0,255,0,255","0,0,0,0","#00ff00",0,true,128,true,true,"1,2,3,255"]"##
    );
    // The pixels were handed to the document for painting.
    let id = e.doc.get_element_by_id("c").unwrap();
    let el = e.doc.get_node(id).unwrap().element_data().unwrap();
    let img = el.raster_image_data().expect("canvas image data");
    assert_eq!((img.width, img.height), (100, 60));
    assert_eq!(&img.data.data()[..4], &[255, 0, 0, 255]);
}
