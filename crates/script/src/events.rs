//! Native (user) events from blitz's `EventDriver` -> JS dispatch via hook `onEvent`,
//! plus default actions blitz lacks or implements without DOM events.

use std::time::{Duration, Instant};

use blitz_dom::{BaseDocument, Document, EventHandler, NodeId, local_name};
use blitz_traits::events::{
    BlitzImeEvent, BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta,
    BlitzWheelEvent, DomEvent, DomEventData, EventState, MouseEventButton,
};
use keyboard_types::{Code, Key, Location, Modifiers};

use crate::ScriptRuntime;
use crate::activation::{self, CANCELED, ClickInfo, dispatch, simple_init};
use crate::cx::{id_value, set_prop, v8_str};
use crate::dom;
use crate::forms;
use crate::runtime::call_hook;
use crate::state::{Hook, RuntimeState};

/// Plugs the script runtime into blitz's [`blitz_dom::EventDriver`]:
///
/// ```ignore
/// let mut driver = EventDriver::new(&mut html_document, JsEventHandler { runtime: &mut rt });
/// driver.handle_ui_event(ui_event);
/// ```
///
/// Every DOM event blitz generates is dispatched to JS before blitz runs its default
/// action; `preventDefault()` in JS suppresses blitz's default action.
pub struct JsEventHandler<'a> {
    pub runtime: &'a mut ScriptRuntime,
}

impl EventHandler for JsEventHandler<'_> {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        event_state: &mut EventState,
    ) {
        let mut guard = doc.inner_mut();
        let base: &mut BaseDocument = &mut guard;
        self.runtime.handle_event(base, chain, event, event_state);
    }
}

const FLAG_CANCELED: u32 = CANCELED;
/// Returned by the JS layer when it already performed the event's default action
/// (implicit form submission on Enter).
const FLAG_DEFAULT_HANDLED: u32 = 4;
const FLAG_STOPPED: u32 = 2;

fn apply_flags(flags: u32, state: &mut EventState) {
    if flags & FLAG_CANCELED != 0 {
        state.prevent_default();
    }
    if flags & FLAG_STOPPED != 0 {
        state.stop_propagation();
    }
}

/// Events target elements: retarget text nodes (and other non-elements) to their
/// parent element.
fn retarget(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> Option<NodeId> {
    let mut cur = Some(id);
    while let Some(c) = cur {
        let n = doc.get_node(c)?;
        match dom::kind(st, n) {
            dom::Kind::Element | dom::Kind::Document => return Some(c),
            dom::Kind::Anonymous => {
                cur = doc
                    .nearest_non_anonymous_ancestor(c)
                    .filter(|&a| a != c)
                    .or(n.parent)
            }
            _ => cur = n.parent,
        }
    }
    None
}

fn mods_of(m: Modifiers) -> (bool, bool, bool, bool) {
    (
        m.contains(Modifiers::CONTROL),
        m.contains(Modifiers::SHIFT),
        m.contains(Modifiers::ALT),
        m.contains(Modifiers::META) || m.contains(Modifiers::SUPER),
    )
}

fn set_bool<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    k: &str,
    v: bool,
) {
    let v = v8::Boolean::new(scope, v).into();
    set_prop(scope, obj, k, v);
}

fn set_num<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>, k: &str, v: f64) {
    let v = v8::Number::new(scope, v).into();
    set_prop(scope, obj, k, v);
}

fn set_str<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>, k: &str, v: &str) {
    let v = v8_str(scope, v).into();
    set_prop(scope, obj, k, v);
}

fn set_mods<'s>(scope: &mut v8::PinScope<'s, '_>, obj: v8::Local<'s, v8::Object>, m: Modifiers) {
    let (c, s, a, me) = mods_of(m);
    set_bool(scope, obj, "ctrlKey", c);
    set_bool(scope, obj, "shiftKey", s);
    set_bool(scope, obj, "altKey", a);
    set_bool(scope, obj, "metaKey", me);
}

fn set_related<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    rel: Option<NodeId>,
) {
    let v = match rel {
        Some(r) => id_value(scope, r),
        None => v8::Integer::new(scope, 0).into(),
    };
    set_prop(scope, obj, "relatedTargetId", v);
}

fn pointer_id(p: &BlitzPointerEvent) -> (f64, &'static str) {
    match p.id {
        BlitzPointerId::Mouse => (1.0, "mouse"),
        BlitzPointerId::Pen => (2.0, "pen"),
        BlitzPointerId::Finger(n) => (n as f64 + 10.0, "touch"),
    }
}

fn button_num(b: MouseEventButton) -> f64 {
    b as i32 as f64
}

/// Init object for mouse/pointer events.
fn mouse_init<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    p: &BlitzPointerEvent,
    bubbles: bool,
    cancelable: bool,
    detail: u32,
    related: Option<NodeId>,
    pointer: bool,
) -> v8::Local<'s, v8::Object> {
    let init = simple_init(scope, bubbles, cancelable);
    set_bool(scope, init, "composed", true);
    set_num(scope, init, "clientX", p.coords.client_x as f64);
    set_num(scope, init, "clientY", p.coords.client_y as f64);
    set_num(scope, init, "screenX", p.coords.screen_x as f64);
    set_num(scope, init, "screenY", p.coords.screen_y as f64);
    set_num(scope, init, "pageX", p.coords.page_x as f64);
    set_num(scope, init, "pageY", p.coords.page_y as f64);
    set_num(scope, init, "offsetX", p.element.x as f64);
    set_num(scope, init, "offsetY", p.element.y as f64);
    set_num(scope, init, "button", button_num(p.button));
    set_num(scope, init, "buttons", p.buttons.bits() as f64);
    set_num(scope, init, "detail", detail as f64);
    set_mods(scope, init, p.mods);
    set_related(scope, init, related);
    if pointer {
        let (id, ty) = pointer_id(p);
        set_num(scope, init, "pointerId", id);
        set_str(scope, init, "pointerType", ty);
        set_bool(scope, init, "isPrimary", p.is_primary);
        set_num(scope, init, "width", 1.0);
        set_num(scope, init, "height", 1.0);
        let pressure = if p.buttons.bits() != 0 { 0.5 } else { 0.0 };
        set_num(scope, init, "pressure", pressure);
    }
    init
}

fn touch_init<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    p: &BlitzPointerEvent,
    target: NodeId,
    cancelable: bool,
) -> v8::Local<'s, v8::Object> {
    let init = mouse_init(scope, p, true, cancelable, 0, None, false);
    let point = |scope: &mut v8::PinScope<'s, '_>, e: &BlitzPointerEvent| {
        let o = v8::Object::new(scope);
        let (id, _) = pointer_id(e);
        set_num(scope, o, "identifier", id);
        set_num(scope, o, "clientX", e.coords.client_x as f64);
        set_num(scope, o, "clientY", e.coords.client_y as f64);
        set_num(scope, o, "pageX", e.coords.page_x as f64);
        set_num(scope, o, "pageY", e.coords.page_y as f64);
        set_num(scope, o, "screenX", e.coords.screen_x as f64);
        set_num(scope, o, "screenY", e.coords.screen_y as f64);
        let t = id_value(scope, target);
        set_prop(scope, o, "targetId", t);
        o
    };
    let changed = point(scope, p);
    let changed_arr = v8::Array::new_with_elements(scope, &[changed.into()]).into();
    set_prop(scope, init, "changedTouches", changed_arr);
    let active: Vec<BlitzPointerEvent> = p.active_pointers.borrow().clone();
    let mut touches: Vec<v8::Local<v8::Value>> = Vec::new();
    for a in &active {
        touches.push(point(scope, a).into());
    }
    let touches = v8::Array::new_with_elements(scope, &touches).into();
    set_prop(scope, init, "touches", touches);
    init
}

fn legacy_key_code(key: &Key, code: &Code) -> u32 {
    match key {
        Key::Enter => 13,
        Key::Tab => 9,
        Key::Backspace => 8,
        Key::Escape => 27,
        Key::Delete => 46,
        Key::Insert => 45,
        Key::Home => 36,
        Key::End => 35,
        Key::PageUp => 33,
        Key::PageDown => 34,
        Key::ArrowLeft => 37,
        Key::ArrowUp => 38,
        Key::ArrowRight => 39,
        Key::ArrowDown => 40,
        Key::Shift => 16,
        Key::Control => 17,
        Key::Alt => 18,
        Key::Meta | Key::Super => 91,
        Key::CapsLock => 20,
        Key::F1 => 112,
        Key::F2 => 113,
        Key::F3 => 114,
        Key::F4 => 115,
        Key::F5 => 116,
        Key::F6 => 117,
        Key::F7 => 118,
        Key::F8 => 119,
        Key::F9 => 120,
        Key::F10 => 121,
        Key::F11 => 122,
        Key::F12 => 123,
        Key::Character(s) => {
            let c = s.chars().next().unwrap_or('\0');
            if c.is_ascii_alphabetic() {
                return c.to_ascii_uppercase() as u32;
            }
            if c.is_ascii_digit() {
                return c as u32;
            }
            if c == ' ' {
                return 32;
            }
            match code {
                Code::Semicolon => 186,
                Code::Equal => 187,
                Code::Comma => 188,
                Code::Minus => 189,
                Code::Period => 190,
                Code::Slash => 191,
                Code::Backquote => 192,
                Code::BracketLeft => 219,
                Code::Backslash => 220,
                Code::BracketRight => 221,
                Code::Quote => 222,
                Code::Space => 32,
                Code::KeyA
                | Code::KeyB
                | Code::KeyC
                | Code::KeyD
                | Code::KeyE
                | Code::KeyF
                | Code::KeyG
                | Code::KeyH
                | Code::KeyI
                | Code::KeyJ
                | Code::KeyK
                | Code::KeyL
                | Code::KeyM
                | Code::KeyN
                | Code::KeyO
                | Code::KeyP
                | Code::KeyQ
                | Code::KeyR
                | Code::KeyS
                | Code::KeyT
                | Code::KeyU
                | Code::KeyV
                | Code::KeyW
                | Code::KeyX
                | Code::KeyY
                | Code::KeyZ => {
                    let name = code.to_string();
                    name.as_bytes().get(3).copied().unwrap_or(0) as u32
                }
                _ => 0,
            }
        }
        _ => 0,
    }
}

fn key_init<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    k: &BlitzKeyEvent,
    char_code: u32,
) -> v8::Local<'s, v8::Object> {
    let init = simple_init(scope, true, true);
    set_bool(scope, init, "composed", true);
    let key = k.key.to_string();
    set_str(scope, init, "key", &key);
    set_str(scope, init, "code", &k.code.to_string());
    let loc = match k.location {
        Location::Standard => 0.0,
        Location::Left => 1.0,
        Location::Right => 2.0,
        Location::Numpad => 3.0,
    };
    set_num(scope, init, "location", loc);
    set_bool(scope, init, "repeat", k.is_auto_repeating);
    set_bool(scope, init, "isComposing", k.is_composing);
    set_mods(scope, init, k.modifiers);
    let kc = if char_code != 0 {
        char_code
    } else {
        legacy_key_code(&k.key, &k.code)
    };
    set_num(scope, init, "keyCode", kc as f64);
    set_num(scope, init, "which", kc as f64);
    set_num(scope, init, "charCode", char_code as f64);
    init
}

/// Text a keydown produces (drives `keypress`), if any.
fn produced_char(k: &BlitzKeyEvent) -> Option<u32> {
    let (ctrl, _, _, meta) = mods_of(k.modifiers);
    if ctrl || meta {
        return None;
    }
    match &k.key {
        Key::Enter => Some(13),
        Key::Character(s) => {
            let c = s.chars().next()?;
            if c.is_control() { None } else { Some(c as u32) }
        }
        _ => None,
    }
}

/// Update click counting on mousedown; returns the click count (`detail`).
fn count_click(st: &RuntimeState, p: &BlitzPointerEvent) -> u32 {
    let mut input = st.input.borrow_mut();
    let now = Instant::now();
    let (x, y) = (p.coords.client_x, p.coords.client_y);
    let count = match input.last_down {
        Some((t, lx, ly))
            if now.duration_since(t) < Duration::from_millis(500)
                && (x - lx).abs() <= 4.0
                && (y - ly).abs() <= 4.0 =>
        {
            input.click_count + 1
        }
        _ => 1,
    };
    input.last_down = Some((now, x, y));
    input.click_count = count;
    count
}

fn current_click_count(st: &RuntimeState) -> u32 {
    st.input.borrow().click_count.max(1)
}

/// Entry point from `ScriptRuntime::handle_event`.
pub(crate) fn handle_dom_event(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    event: &mut DomEvent,
    state: &mut EventState,
) {
    let target = {
        let Ok(doc) = st.doc() else { return };
        match retarget(st, doc, event.target) {
            Some(t) => t,
            None => return,
        }
    };
    let data = event.data.clone();
    match &data {
        DomEventData::PointerMove(p) => {
            pointer(scope, st, "pointermove", target, p, true, true, state)
        }
        DomEventData::PointerDown(p) => {
            pointer(scope, st, "pointerdown", target, p, true, true, state)
        }
        DomEventData::PointerUp(p) => pointer(scope, st, "pointerup", target, p, true, true, state),
        DomEventData::PointerCancel(p) => {
            pointer(scope, st, "pointercancel", target, p, true, false, state)
        }
        DomEventData::PointerEnter(p) => {
            pointer(scope, st, "pointerenter", target, p, false, false, state)
        }
        DomEventData::PointerLeave(p) => {
            pointer(scope, st, "pointerleave", target, p, false, false, state)
        }
        DomEventData::PointerOver(p) => {
            pointer(scope, st, "pointerover", target, p, true, true, state)
        }
        DomEventData::PointerOut(p) => {
            pointer(scope, st, "pointerout", target, p, true, true, state)
        }
        DomEventData::MouseMove(p) => mouse(scope, st, "mousemove", target, p, true, true, state),
        DomEventData::MouseDown(p) => {
            let detail = count_click(st, p);
            let init = mouse_init(scope, p, true, true, detail, None, false);
            let flags = dispatch(scope, st, "mousedown", target, init);
            apply_flags(flags, state);
            if flags & FLAG_CANCELED == 0 && p.button == MouseEventButton::Main {
                activation::focus_for_pointer(scope, st, target);
            }
        }
        DomEventData::MouseUp(p) => {
            let detail = current_click_count(st);
            let init = mouse_init(scope, p, true, true, detail, None, false);
            let flags = dispatch(scope, st, "mouseup", target, init);
            apply_flags(flags, state);
            if flags & FLAG_CANCELED == 0 && p.button == MouseEventButton::Auxiliary {
                auxclick(scope, st, target, p);
            }
        }
        DomEventData::MouseEnter(p) => {
            mouse(scope, st, "mouseenter", target, p, false, false, state)
        }
        DomEventData::MouseLeave(p) => {
            mouse(scope, st, "mouseleave", target, p, false, false, state)
        }
        DomEventData::MouseOver(p) => mouse(scope, st, "mouseover", target, p, true, true, state),
        DomEventData::MouseOut(p) => mouse(scope, st, "mouseout", target, p, true, true, state),
        DomEventData::TouchStart(p) => touch(scope, st, "touchstart", target, p, true, state),
        DomEventData::TouchMove(p) => touch(scope, st, "touchmove", target, p, true, state),
        DomEventData::TouchEnd(p) => touch(scope, st, "touchend", target, p, true, state),
        DomEventData::TouchCancel(p) => touch(scope, st, "touchcancel", target, p, false, state),
        DomEventData::Click(p) => click(scope, st, target, p, state),
        DomEventData::ContextMenu(p) => {
            let init = mouse_init(scope, p, true, true, 0, None, false);
            let flags = dispatch(scope, st, "contextmenu", target, init);
            apply_flags(flags, state);
        }
        DomEventData::DoubleClick(p) => {
            let init = mouse_init(scope, p, true, true, 2, None, false);
            let flags = dispatch(scope, st, "dblclick", target, init);
            apply_flags(flags, state);
        }
        DomEventData::KeyDown(k) => keydown(scope, st, target, k, state),
        DomEventData::KeyUp(k) => {
            let init = key_init(scope, k, 0);
            let flags = dispatch(scope, st, "keyup", target, init);
            apply_flags(flags, state);
            let (ctrl, _, alt, meta) = mods_of(k.modifiers);
            let space = k.code == Code::Space || k.key == Key::Character(" ".into());
            if space
                && flags & FLAG_CANCELED == 0
                && !ctrl
                && !alt
                && !meta
                && keyboard_activates(st, target, true)
            {
                // Space activates buttons, checkboxes and radios on release.
                activation::synthetic_click(scope, st, target, ClickInfo::default());
            }
        }
        DomEventData::KeyPress(k) => {
            let c = produced_char(k).unwrap_or(0);
            let init = key_init(scope, k, c);
            let flags = dispatch(scope, st, "keypress", target, init);
            apply_flags(flags, state);
        }
        DomEventData::Input(_) => {
            let is_text = st
                .doc()
                .is_ok_and(|doc| forms::is_text_control(doc, target));
            if is_text {
                forms::mark_user_edit(st, target);
            }
            let init = simple_init(scope, true, false);
            set_bool(scope, init, "composed", true);
            set_str(scope, init, "inputType", "insertText");
            let null = v8::null(scope).into();
            set_prop(scope, init, "data", null);
            st.invalidate_layout();
            let flags = dispatch(scope, st, "input", target, init);
            apply_flags(flags, state);
        }
        DomEventData::Ime(ime) => ime_event(scope, st, target, ime, state),
        DomEventData::Wheel(w) => wheel(scope, st, target, w, state),
        DomEventData::Scroll(_) => {
            let is_root = st
                .doc()
                .is_ok_and(|doc| doc.try_root_element().is_some_and(|r| r.id == target));
            st.invalidate_layout();
            if is_root {
                call_hook(scope, st, Hook::Scroll, &[]);
            } else {
                let init = simple_init(scope, false, false);
                dispatch(scope, st, "scroll", target, init);
            }
        }
        DomEventData::Focus(_) => {
            let ok = st
                .doc()
                .is_ok_and(|doc| doc.get_node(target).is_some_and(|n| n.is_focussed()));
            if ok {
                if let Ok(doc) = st.doc() {
                    activation::record_focus_value(st, doc, target);
                }
                let rel = st.input.borrow().last_blur;
                let init = simple_init(scope, false, false);
                set_related(scope, init, rel);
                dispatch(scope, st, "focus", target, init);
            }
        }
        DomEventData::FocusIn(_) => {
            let ok = st
                .doc()
                .is_ok_and(|doc| doc.get_node(target).is_some_and(|n| n.is_focussed()));
            if ok {
                let rel = st.input.borrow().last_blur;
                let init = simple_init(scope, true, false);
                set_related(scope, init, rel);
                dispatch(scope, st, "focusin", target, init);
            }
        }
        DomEventData::Blur(_) => {
            let (ok, now_focused) = match st.doc() {
                Ok(doc) => {
                    let was_root = doc.try_root_element().is_some_and(|r| r.id == target);
                    let rootish = was_root && !activation::is_focusable(doc, target);
                    (!rootish, activation::focused(doc))
                }
                Err(_) => (false, None),
            };
            if ok {
                activation::maybe_fire_change(scope, st, target);
                st.input.borrow_mut().last_blur = Some(target);
                let init = simple_init(scope, false, false);
                set_related(scope, init, now_focused);
                dispatch(scope, st, "blur", target, init);
            }
        }
        DomEventData::FocusOut(_) => {
            let (ok, now_focused) = match st.doc() {
                Ok(doc) => {
                    let was_root = doc.try_root_element().is_some_and(|r| r.id == target);
                    (
                        !was_root || activation::is_focusable(doc, target),
                        activation::focused(doc),
                    )
                }
                Err(_) => (false, None),
            };
            if ok {
                let init = simple_init(scope, true, false);
                set_related(scope, init, now_focused);
                dispatch(scope, st, "focusout", target, init);
            }
        }
        DomEventData::AppleStandardKeybinding(_) => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn pointer(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    ty: &str,
    target: NodeId,
    p: &BlitzPointerEvent,
    bubbles: bool,
    cancelable: bool,
    state: &mut EventState,
) {
    let related = related_for(st, ty, target);
    let init = mouse_init(scope, p, bubbles, cancelable, 0, related, true);
    let flags = dispatch(scope, st, ty, target, init);
    apply_flags(flags, state);
}

#[allow(clippy::too_many_arguments)]
fn mouse(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    ty: &str,
    target: NodeId,
    p: &BlitzPointerEvent,
    bubbles: bool,
    cancelable: bool,
    state: &mut EventState,
) {
    let related = related_for(st, ty, target);
    let init = mouse_init(scope, p, bubbles, cancelable, 0, related, false);
    let flags = dispatch(scope, st, ty, target, init);
    apply_flags(flags, state);
}

/// relatedTarget for over/out/enter/leave: blitz updates the hover node before
/// dispatching, so `out`/`leave` relate to the new hover node and `over`/`enter` to the
/// target of the preceding `out`.
fn related_for(st: &RuntimeState, ty: &str, target: NodeId) -> Option<NodeId> {
    match ty {
        "pointerout" | "mouseout" | "pointerleave" | "mouseleave" => {
            if ty == "mouseout" || ty == "pointerout" {
                st.input.borrow_mut().last_out = Some(target);
            }
            st.doc()
                .ok()
                .and_then(|d| d.get_hover_node_id())
                .and_then(|h| st.doc().ok().and_then(|d| retarget(st, d, h)))
        }
        "pointerover" | "mouseover" | "pointerenter" | "mouseenter" => st.input.borrow().last_out,
        _ => None,
    }
}

fn touch(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    ty: &str,
    target: NodeId,
    p: &BlitzPointerEvent,
    cancelable: bool,
    state: &mut EventState,
) {
    let init = touch_init(scope, p, target, cancelable);
    let flags = dispatch(scope, st, ty, target, init);
    apply_flags(flags, state);
}

fn click_info(p: &BlitzPointerEvent) -> ClickInfo {
    let (ctrl, shift, _alt, meta) = mods_of(p.mods);
    ClickInfo {
        ctrl,
        meta,
        shift,
        middle: p.button == MouseEventButton::Auxiliary,
    }
}

/// Native click: legacy pre-activation, dispatch, then activation behavior. Blitz's
/// own click default action is always suppressed (we implement it with events).
fn click(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    target: NodeId,
    p: &BlitzPointerEvent,
    state: &mut EventState,
) {
    // blitz's own default actions are replaced by ours.
    state.prevent_default();
    let detail = current_click_count(st);
    let init = mouse_init(scope, p, true, true, detail, None, false);
    let flags = activation::click_with_activation(scope, st, target, init, click_info(p));
    if flags & FLAG_STOPPED != 0 {
        state.stop_propagation();
    }
    if detail == 2 {
        let alive = st.doc().is_ok_and(|d| d.get_node(target).is_some());
        if alive {
            let init = mouse_init(scope, p, true, true, 2, None, false);
            dispatch(scope, st, "dblclick", target, init);
        }
    }
}

fn auxclick(scope: &mut v8::PinScope, st: &RuntimeState, target: NodeId, p: &BlitzPointerEvent) {
    let init = mouse_init(scope, p, true, true, 1, None, false);
    let flags = dispatch(scope, st, "auxclick", target, init);
    if flags & FLAG_CANCELED != 0 {
        return;
    }
    let link = st.doc().ok().and_then(|doc| {
        dom::inclusive_ancestors(doc, target)
            .into_iter()
            .find(|&id| {
                (dom::is_html_id(doc, id, &local_name!("a"))
                    || dom::is_html_id(doc, id, &local_name!("area")))
                    && dom::get_attr(doc, id, "href").is_some()
            })
    });
    if let Some(a) = link {
        activation::follow_hyperlink(scope, st, a, click_info(p));
    }
}

fn keydown(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    target: NodeId,
    k: &BlitzKeyEvent,
    state: &mut EventState,
) {
    let init = key_init(scope, k, 0);
    let flags = dispatch(scope, st, "keydown", target, init);
    apply_flags(flags, state);
    if flags & FLAG_CANCELED != 0 {
        return;
    }
    let js_handled_default = flags & FLAG_DEFAULT_HANDLED != 0;
    let (ctrl0, _, alt0, meta0) = mods_of(k.modifiers);
    if k.key == Key::Enter
        && !ctrl0
        && !alt0
        && !meta0
        && !k.is_composing
        && keyboard_activates(st, target, false)
    {
        // Enter activates links and buttons (a trusted click).
        state.prevent_default();
        activation::synthetic_click(scope, st, target, ClickInfo::default());
        return;
    }
    if let Some(c) = produced_char(k) {
        let init = key_init(scope, k, c);
        let flags = dispatch(scope, st, "keypress", target, init);
        if flags & FLAG_CANCELED != 0 {
            state.prevent_default();
            return;
        }
    }
    let (ctrl, shift, alt, meta) = mods_of(k.modifiers);
    if k.key == Key::Tab && !ctrl && !alt && !meta {
        state.prevent_default();
        tab_navigation(scope, st, shift);
        return;
    }
    if k.key == Key::Enter && !ctrl && !alt && !meta {
        let single_line_text = st.doc().is_ok_and(|doc| {
            dom::is_html_id(doc, target, &local_name!("input"))
                && forms::is_text_control(doc, target)
        });
        if single_line_text {
            // Suppress blitz's own implicit submission in any case.
            state.prevent_default();
            if !js_handled_default {
                activation::implicit_submission(scope, st, target);
            }
        }
    }
    st.invalidate_layout();
}

/// Does a key activate the focused `target` with a synthetic click? Enter: links and
/// buttons; Space (on release): buttons, checkboxes and radios.
fn keyboard_activates(st: &RuntimeState, target: NodeId, space: bool) -> bool {
    let Ok(doc) = st.doc() else { return false };
    if activation::focused(doc) != Some(target) {
        return false;
    }
    let Some(el) = doc.get_node(target).and_then(|n| n.element_data()) else {
        return false;
    };
    if el.name.ns != blitz_dom::ns!(html) {
        return !space
            && &*el.name.local == "a"
            && dom::get_attr(doc, target, "xlink:href").is_some();
    }
    match &*el.name.local {
        "a" | "area" => !space && el.has_attr(local_name!("href")),
        "button" => true,
        "summary" => true,
        "input" => match forms::input_type(doc, target).as_str() {
            "submit" | "reset" | "button" | "image" => true,
            "checkbox" | "radio" => space,
            _ => false,
        },
        _ => false,
    }
}

/// Sequential focus navigation (tabindex order, then tree order).
fn tab_navigation(scope: &mut v8::PinScope, st: &RuntimeState, backward: bool) {
    let next = {
        let Ok(doc) = st.doc() else { return };
        let current = activation::focused(doc);
        let root = doc.root_node().id;
        let mut positive: Vec<(i32, usize, NodeId)> = Vec::new();
        let mut zero: Vec<NodeId> = Vec::new();
        for (i, id) in dom::subtree(doc, root).into_iter().enumerate() {
            let Some(node) = doc.get_node(id) else {
                continue;
            };
            let Some(el) = node.element_data() else {
                continue;
            };
            if !activation::is_focusable(doc, id) {
                continue;
            }
            let ti = el
                .attr(local_name!("tabindex"))
                .and_then(|t| t.trim().parse::<i32>().ok());
            match ti {
                Some(t) if t < 0 => continue,
                Some(t) if t > 0 => positive.push((t, i, id)),
                _ => {
                    if node.is_focussable() || ti == Some(0) {
                        zero.push(id);
                    }
                }
            }
        }
        positive.sort();
        let order: Vec<NodeId> = positive
            .into_iter()
            .map(|(_, _, id)| id)
            .chain(zero)
            .collect();
        if order.is_empty() {
            return;
        }
        let pos = current.and_then(|c| order.iter().position(|&o| o == c));
        let idx = match (pos, backward) {
            (Some(p), false) => (p + 1) % order.len(),
            (Some(p), true) => (p + order.len() - 1) % order.len(),
            (None, false) => 0,
            (None, true) => order.len() - 1,
        };
        order[idx]
    };
    activation::change_focus(scope, st, Some(next));
    if let Ok(doc) = st.doc() {
        doc.scroll_into_view(
            next,
            blitz_dom::ScrollBehavior::Instant,
            blitz_dom::ScrollLogicalPosition::Nearest,
            blitz_dom::ScrollLogicalPosition::Nearest,
        );
    }
}

fn ime_event(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    target: NodeId,
    ime: &BlitzImeEvent,
    state: &mut EventState,
) {
    let (ty, data) = match ime {
        BlitzImeEvent::Preedit(text, _) => {
            let starting = !st.input.borrow().composing;
            if starting {
                st.input.borrow_mut().composing = true;
                let init = simple_init(scope, true, true);
                set_str(scope, init, "data", "");
                let flags = dispatch(scope, st, "compositionstart", target, init);
                apply_flags(flags, state);
            }
            ("compositionupdate", text.clone())
        }
        BlitzImeEvent::Commit(text) => {
            st.input.borrow_mut().composing = false;
            ("compositionend", text.clone())
        }
        _ => return,
    };
    let init = simple_init(scope, true, true);
    set_str(scope, init, "data", &data);
    let flags = dispatch(scope, st, ty, target, init);
    apply_flags(flags, state);
}

fn wheel(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    target: NodeId,
    w: &BlitzWheelEvent,
    state: &mut EventState,
) {
    let init = simple_init(scope, true, true);
    set_bool(scope, init, "composed", true);
    // blitz deltas are "content movement" (positive = scroll up/left); DOM deltas are
    // scroll amounts (positive = down/right).
    let (dx, dy, mode) = match w.delta {
        BlitzWheelDelta::Lines(x, y) => (-x, -y, 1.0),
        BlitzWheelDelta::Pixels(x, y) => (-x, -y, 0.0),
    };
    set_num(scope, init, "deltaX", dx);
    set_num(scope, init, "deltaY", dy);
    set_num(scope, init, "deltaZ", 0.0);
    set_num(scope, init, "deltaMode", mode);
    set_num(scope, init, "clientX", w.coords.client_x as f64);
    set_num(scope, init, "clientY", w.coords.client_y as f64);
    set_num(scope, init, "screenX", w.coords.screen_x as f64);
    set_num(scope, init, "screenY", w.coords.screen_y as f64);
    set_num(scope, init, "pageX", w.coords.page_x as f64);
    set_num(scope, init, "pageY", w.coords.page_y as f64);
    set_num(scope, init, "offsetX", w.element.x as f64);
    set_num(scope, init, "offsetY", w.element.y as f64);
    set_num(scope, init, "buttons", w.buttons.bits() as f64);
    set_mods(scope, init, w.mods);
    let flags = dispatch(scope, st, "wheel", target, init);
    apply_flags(flags, state);
    st.invalidate_layout();
}
