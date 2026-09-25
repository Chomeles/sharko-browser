//! Native (user) events through blitz's EventDriver + JsEventHandler, with a minimal
//! JS `onEvent` hook standing in for the JS layer.

mod common;

use blitz_dom::{Document, EventDriver};
use blitz_traits::SmolStr;
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, KeyState, MouseEventButton,
    MouseEventButtons, PointerCoords, UiEvent,
};
use common::Env;
use keyboard_types::{Code, Key, Location, Modifiers};
use script::JsEventHandler;

const PAGE: &str = r#"<!DOCTYPE html><html><body style="margin:0">
<div style="height:40px"><input id="cb" type="checkbox" style="width:20px;height:20px;margin:0"></div>
<div style="height:40px"><a id="link" href="/next" style="display:block;width:100px;height:20px">next</a></div>
<div style="height:40px"><a id="prevent" href="/nope" style="display:block;width:100px;height:20px">x</a></div>
<form id="f" action="/search">
  <div style="height:40px"><input id="q" name="q" style="width:200px;height:20px"></div>
  <div style="height:40px"><button id="go" style="width:50px;height:20px">Go</button></div>
</form>
<div style="height:40px"><label id="lbl" for="cb2" style="display:block;width:100px;height:20px">label</label><input id="cb2" type="checkbox"></div>
<div id="plain" style="height:40px">plain</div>
</body></html>"#;

const HOOK: &str = r#"
    globalThis.N = __native;
    globalThis.events = [];
    globalThis.prevent = new Set();
    N.setHooks({
        onEvent(type, target, path, init) {
            const id = N.getAttr(target, 'id') || N.localName(target);
            if (!['pointermove', 'mousemove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
                  'mouseover', 'mouseout', 'mouseenter', 'mouseleave'].includes(type)) {
                events.push(type + '@' + id);
            }
            if (type === 'click' && id === 'cb') globalThis.checkedDuringClick = N.getChecked(target);
            if (path[path.length - 1] !== N.documentId() && N.isConnected(target)) throw new Error('bad path');
            return prevent.has(type + '@' + id) ? 1 : 0;
        },
    });
    1
"#;

fn setup() -> Env {
    let mut e = Env::new(PAGE);
    e.doc.resolve(0.0);
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    e.eval(HOOK);
    e
}

fn pointer(
    x: f32,
    y: f32,
    button: MouseEventButton,
    buttons: MouseEventButtons,
) -> BlitzPointerEvent {
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
        button,
        buttons,
        mods: Modifiers::empty(),
        details: Default::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    }
}

fn send(e: &mut Env, ev: UiEvent) {
    let doc: &mut dyn Document = &mut e.doc;
    let mut driver = EventDriver::new(doc, JsEventHandler::new(&mut e.rt));
    driver.handle_ui_event(ev);
}

fn click_at(e: &mut Env, x: f32, y: f32) {
    send(
        e,
        UiEvent::PointerMove(pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
        )),
    );
    send(
        e,
        UiEvent::PointerDown(pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::Primary,
        )),
    );
    send(
        e,
        UiEvent::PointerUp(pointer(
            x,
            y,
            MouseEventButton::Main,
            MouseEventButtons::None,
        )),
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

fn take_events(e: &mut Env) -> String {
    let s = e.eval("(() => { const ev = events.join(' '); events.length = 0; return ev; })()");
    s.trim_matches('"').to_string()
}

#[test]
fn checkbox_click_activation() {
    let mut e = setup();
    click_at(&mut e, 10.0, 10.0);
    assert_eq!(
        take_events(&mut e),
        "pointerdown@cb mousedown@cb focus@cb focusin@cb pointerup@cb mouseup@cb click@cb input@cb change@cb"
    );
    // Listeners observe the new state during click (legacy pre-activation).
    assert_eq!(e.eval("checkedDuringClick"), "true");
    assert_eq!(e.eval("N.getChecked(N.getElementById('cb'))"), "true");
    // preventDefault on click reverts the toggle and suppresses input/change.
    e.eval("prevent.add('click@cb'); 1");
    click_at(&mut e, 10.0, 10.0);
    let ev = take_events(&mut e);
    assert!(ev.ends_with("click@cb"), "{ev}");
    assert_eq!(
        e.eval("[checkedDuringClick, N.getChecked(N.getElementById('cb'))]"),
        "[false,true]"
    );
}

#[test]
fn link_click_navigates_unless_prevented() {
    let mut e = setup();
    click_at(&mut e, 20.0, 50.0);
    let ev = take_events(&mut e);
    assert!(ev.contains("click@link"), "{ev}");
    assert_eq!(e.host.navigations.borrow().len(), 1);
    assert_eq!(
        e.host.navigations.borrow()[0].url,
        "https://example.com/next"
    );
    // Prevented link
    e.eval("prevent.add('click@prevent'); 1");
    click_at(&mut e, 20.0, 90.0);
    assert_eq!(e.host.navigations.borrow().len(), 1);
}

#[test]
fn submit_button_fires_submit_event() {
    let mut e = setup();
    click_at(&mut e, 10.0, 170.0);
    let ev = take_events(&mut e);
    assert!(ev.contains("click@go submit@f"), "{ev}");
    assert_eq!(
        e.host.navigations.borrow().last().unwrap().url,
        "https://example.com/search?q="
    );
    // preventDefault on submit (SPA forms) stops the navigation
    e.eval("prevent.add('submit@f'); 1");
    click_at(&mut e, 10.0, 170.0);
    assert_eq!(e.host.navigations.borrow().len(), 1);
}

#[test]
fn typing_and_implicit_submission() {
    let mut e = setup();
    click_at(&mut e, 10.0, 130.0); // focus the text input (blitz focuses on pointerdown)
    let ev = take_events(&mut e);
    assert!(ev.contains("focus@q"), "{ev}");
    assert_eq!(
        e.eval("N.activeElement() === N.getElementById('q')"),
        "true"
    );
    key(&mut e, Key::Character("h".into()), Code::KeyH, Some("h"));
    key(&mut e, Key::Character("i".into()), Code::KeyI, Some("i"));
    let ev = take_events(&mut e);
    assert_eq!(
        ev,
        "keydown@q keypress@q input@q keyup@q keydown@q keypress@q input@q keyup@q"
    );
    assert_eq!(e.eval("N.getValue(N.getElementById('q'))"), "\"hi\"");
    // preventDefault on keydown blocks text insertion
    e.eval("prevent.add('keydown@q'); 1");
    key(&mut e, Key::Character("x".into()), Code::KeyX, Some("x"));
    assert_eq!(e.eval("N.getValue(N.getElementById('q'))"), "\"hi\"");
    e.eval("prevent.clear(); 1");
    take_events(&mut e);
    // Enter: implicit submission clicks the default button.
    key(&mut e, Key::Enter, Code::Enter, None);
    let ev = take_events(&mut e);
    assert!(
        ev.contains("keydown@q keypress@q click@go submit@f"),
        "{ev}"
    );
    assert_eq!(
        e.host.navigations.borrow().last().unwrap().url,
        "https://example.com/search?q=hi"
    );
}

#[test]
fn change_on_blur_and_tab_navigation() {
    let mut e = setup();
    click_at(&mut e, 10.0, 130.0);
    key(&mut e, Key::Character("a".into()), Code::KeyA, Some("a"));
    take_events(&mut e);
    // Tab moves focus to the next focusable element (the submit button), firing change.
    key(&mut e, Key::Tab, Code::Tab, None);
    let ev = take_events(&mut e);
    assert_eq!(
        ev,
        "keydown@q change@q blur@q focusout@q focus@go focusin@go keyup@go"
    );
    // Clicking non-focusable content blurs.
    click_at(&mut e, 10.0, 250.0);
    let ev = take_events(&mut e);
    assert!(ev.contains("blur@go"), "{ev}");
    assert_eq!(e.eval("N.activeElement()"), "0");
}

#[test]
fn label_forwards_click_to_control() {
    let mut e = setup();
    click_at(&mut e, 10.0, 210.0);
    let ev = take_events(&mut e);
    assert!(
        ev.contains("click@lbl") && ev.contains("click@cb2 input@cb2 change@cb2"),
        "{ev}"
    );
    assert_eq!(e.eval("N.getChecked(N.getElementById('cb2'))"), "true");
}

#[test]
fn synthetic_click_default_actions() {
    let mut e = setup();
    // el.click() path: JS dispatches click itself, then asks for the default action.
    assert_eq!(
        e.eval("N.runDefaultAction(N.getElementById('cb'), 'click')"),
        "true"
    );
    assert_eq!(e.eval("N.getChecked(N.getElementById('cb'))"), "true");
    assert_eq!(take_events(&mut e), "input@cb change@cb");
    // Split activation API: listeners see the toggled state, cancel reverts.
    let r = e.eval(
        r#"
        const cb = N.getElementById('cb');
        const t = N.activationBegin(cb);
        const during = N.getChecked(cb);
        N.activationEnd(t, true);
        [t > 0, during, N.getChecked(cb)]
    "#,
    );
    assert_eq!(r, "[true,false,true]");
    assert_eq!(
        e.eval("N.runDefaultAction(N.getElementById('link'), 'click')"),
        "true"
    );
    assert_eq!(
        e.host.navigations.borrow().last().unwrap().url,
        "https://example.com/next"
    );
    assert_eq!(
        e.eval("N.runDefaultAction(N.getElementById('plain'), 'click')"),
        "false"
    );
    assert_eq!(
        e.eval("N.runDefaultAction(N.getElementById('cb'), 'keydown')"),
        "false"
    );
}

#[test]
fn wheel_and_scroll_events() {
    let mut e = Env::new(
        r#"<html><body style="margin:0"><div id="tall" style="height:3000px">x</div></body></html>"#,
    );
    e.doc.resolve(0.0);
    e.eval(HOOK);
    e.eval("globalThis.scrolls = 0; const h = __native; N.setHooks({ onEvent(t, id, p, init) { events.push(t + ':' + init.deltaY); return 0; }, onScroll() { scrolls++; } }); 1");
    let wheel = blitz_traits::events::BlitzWheelEvent {
        delta: blitz_traits::events::BlitzWheelDelta::Pixels(0.0, -100.0),
        coords: PointerCoords {
            page_x: 10.0,
            page_y: 10.0,
            screen_x: 10.0,
            screen_y: 10.0,
            client_x: 10.0,
            client_y: 10.0,
        },
        buttons: MouseEventButtons::None,
        mods: Modifiers::empty(),
        element: Default::default(),
    };
    send(
        &mut e,
        UiEvent::PointerMove(pointer(
            10.0,
            10.0,
            MouseEventButton::Main,
            MouseEventButtons::None,
        )),
    );
    e.eval("events.length = 0; 1");
    send(&mut e, UiEvent::Wheel(wheel));
    assert_eq!(
        e.eval("events.filter(x => x.startsWith('wheel'))"),
        r#"["wheel:100"]"#
    );
    assert_eq!(e.eval("scrolls"), "1");
    assert_eq!(e.eval("N.viewport()[4]"), "100");
}

#[test]
fn keyboard_activation() {
    let mut e = setup();
    // Focus the checkbox with a click (toggles it on), then Space toggles it off.
    click_at(&mut e, 10.0, 10.0);
    take_events(&mut e);
    key(&mut e, Key::Character(" ".into()), Code::Space, Some(" "));
    let ev = take_events(&mut e);
    assert!(ev.ends_with("keyup@cb click@cb input@cb change@cb"), "{ev}");
    assert_eq!(e.eval("N.getChecked(N.getElementById('cb'))"), "false");
    // Tab to the link, Enter follows it.
    key(&mut e, Key::Tab, Code::Tab, None);
    assert_eq!(e.eval("N.getAttr(N.activeElement(), 'id')"), r#""link""#);
    take_events(&mut e);
    key(&mut e, Key::Enter, Code::Enter, None);
    let ev = take_events(&mut e);
    assert!(ev.starts_with("keydown@link click@link"), "{ev}");
    assert_eq!(
        e.host.navigations.borrow().last().unwrap().url,
        "https://example.com/next"
    );
    // Enter on a focused submit button submits once.
    e.eval("N.focus(N.getElementById('go')); 1");
    let before = e.host.navigations.borrow().len();
    key(&mut e, Key::Enter, Code::Enter, None);
    assert_eq!(e.host.navigations.borrow().len(), before + 1);
}

#[test]
fn microtasks_run_between_native_events() {
    let mut e = setup();
    e.eval(
        r#"
        globalThis.mt = [];
        N.setHooks({ onEvent(type) {
            if (type === 'pointerdown' || type === 'mousedown') {
                mt.push(type);
                Promise.resolve().then(() => mt.push('micro:' + type));
            }
            return 0;
        } });
        1
    "#,
    );
    let doc: &mut dyn Document = &mut e.doc;
    let mut driver = EventDriver::new(doc, JsEventHandler::new(&mut e.rt));
    driver.handle_ui_event(UiEvent::PointerDown(pointer(
        10.0,
        250.0,
        MouseEventButton::Main,
        MouseEventButtons::Primary,
    )));
    drop(driver);
    assert_eq!(
        e.eval("mt.join()"),
        r#""pointerdown,micro:pointerdown,mousedown,micro:mousedown""#
    );
}
