//! Dispatching synthesized events to JS and the HTML activation behaviors / focus
//! handling that blitz doesn't implement (or implements without DOM events).
//!
//! All functions here may call into JS: they acquire the document through
//! `RuntimeState::doc()` only in short, non-overlapping sections (see `state.rs`).

use blitz_dom::{BaseDocument, NodeId, local_name};

use crate::cx::{self, id_value, set_prop, v8_str};
use crate::dom;
use crate::forms;
use crate::runtime::call_hook;
use crate::state::{Hook, InternalTask, RuntimeState};

pub(crate) const CANCELED: u32 = 1;

/// `{bubbles, cancelable}` event init object.
pub(crate) fn simple_init<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bubbles: bool,
    cancelable: bool,
) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    let b = v8::Boolean::new(scope, bubbles).into();
    set_prop(scope, obj, "bubbles", b);
    let c = v8::Boolean::new(scope, cancelable).into();
    set_prop(scope, obj, "cancelable", c);
    obj
}

/// Dispatch event `ty` at `target` through the `onEvent` hook. The path is the target
/// and its ancestors up to the root (the document when connected). Returns the hook's
/// flags (1 = default prevented, 2 = propagation stopped).
pub(crate) fn dispatch<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    ty: &str,
    target: NodeId,
    init: v8::Local<'s, v8::Object>,
) -> u32 {
    if st.hooks.borrow().get(Hook::Event).is_none() {
        return 0;
    }
    let path: Vec<NodeId> = match st.doc() {
        Ok(doc) => {
            if doc.get_node(target).is_none() {
                return 0;
            }
            let p = dom::inclusive_ancestors(doc, target);
            for &id in &p {
                dom::expose(doc, id);
            }
            p.to_vec()
        }
        Err(_) => return 0,
    };
    let ty = v8_str(scope, ty).into();
    let t = id_value(scope, target);
    let path = cx::ids_array(scope, &path).into();
    match call_hook(scope, st, Hook::Event, &[ty, t, path, init.into()]) {
        Some(r) => {
            let n = cx::plain_number(r);
            if n.is_nan() { 0 } else { n as u32 }
        }
        None => 0,
    }
}

// ---------------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------------

/// The focused element, if any (blitz reports the root element when nothing is).
pub(crate) fn focused(doc: &BaseDocument) -> Option<NodeId> {
    let id = doc.get_focussed_node_id()?;
    doc.get_node(id).filter(|n| n.is_focussed()).map(|n| n.id)
}

/// Can `id` receive focus programmatically (`el.focus()`)?
pub(crate) fn is_focusable(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    let Some(el) = node.element_data() else {
        return false;
    };
    if !node.flags.is_in_document() || forms::is_disabled(doc, id) {
        return false;
    }
    if let Some(styles) = node.primary_styles()
        && styles.clone_display().is_none()
    {
        return false;
    }
    let tabindex = el
        .attr(local_name!("tabindex"))
        .and_then(|t| t.trim().parse::<i32>().ok());
    tabindex.is_some()
        || node.is_focussable()
        || el
            .attr(blitz_dom::LocalName::from("contenteditable"))
            .is_some_and(|v| !v.eq_ignore_ascii_case("false"))
}

fn focus_init<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bubbles: bool,
    related: Option<NodeId>,
) -> v8::Local<'s, v8::Object> {
    let init = simple_init(scope, bubbles, false);
    let composed = v8::Boolean::new(scope, true).into();
    set_prop(scope, init, "composed", composed);
    let rel = match related {
        Some(r) => id_value(scope, r),
        None => v8::Integer::new(scope, 0).into(),
    };
    set_prop(scope, init, "relatedTargetId", rel);
    init
}

/// Fire `change` at a text control that lost focus if its value changed since it was
/// focused.
pub(crate) fn maybe_fire_change(scope: &mut v8::PinScope, st: &RuntimeState, id: NodeId) {
    let changed = {
        let Ok(doc) = st.doc() else { return };
        let forms_state = st.forms.borrow();
        match &forms_state.focus_value {
            Some((n, v)) if *n == id && forms::is_text_control(doc, id) => {
                let cur = forms::get_value(st, doc, id);
                (cur != *v).then_some(cur)
            }
            _ => None,
        }
    };
    if let Some(cur) = changed {
        st.forms.borrow_mut().focus_value = Some((id, cur));
        let init = simple_init(scope, true, false);
        dispatch(scope, st, "change", id, init);
    }
}

/// Remember the value of a newly focused text control (for `change` on blur).
pub(crate) fn record_focus_value(st: &RuntimeState, doc: &BaseDocument, id: NodeId) {
    let v = forms::is_text_control(doc, id).then(|| (id, forms::get_value(st, doc, id)));
    st.forms.borrow_mut().focus_value = v;
}

/// Move focus to `new` (or clear it), firing blur/focusout/focus/focusin (and `change`
/// on the control losing focus).
pub(crate) fn change_focus(scope: &mut v8::PinScope, st: &RuntimeState, new: Option<NodeId>) {
    let old = match st.doc() {
        Ok(doc) => focused(doc),
        Err(_) => return,
    };
    if old == new {
        return;
    }
    if let Some(o) = old {
        maybe_fire_change(scope, st, o);
    }
    {
        let Ok(doc) = st.doc() else { return };
        match new {
            Some(n) if doc.get_node(n).is_some() => {
                doc.set_focus_to(n);
                record_focus_value(st, doc, n);
            }
            _ => {
                doc.clear_focus();
                st.forms.borrow_mut().focus_value = None;
            }
        }
        st.invalidate_layout();
        st.host.request_redraw();
    }
    if let Some(o) = old {
        let init = focus_init(scope, false, new);
        dispatch(scope, st, "blur", o, init);
        let init = focus_init(scope, true, new);
        dispatch(scope, st, "focusout", o, init);
    }
    if let Some(n) = new {
        let init = focus_init(scope, false, old);
        dispatch(scope, st, "focus", n, init);
        let init = focus_init(scope, true, old);
        dispatch(scope, st, "focusin", n, init);
    }
}

/// Focus change caused by pressing the mouse on `target`: focus the nearest focusable
/// inclusive ancestor, or clear focus. Text controls are left to blitz (which focuses
/// them and places the caret in its pointerdown default action).
pub(crate) fn focus_for_pointer(scope: &mut v8::PinScope, st: &RuntimeState, target: NodeId) {
    let new = {
        let Ok(doc) = st.doc() else { return };
        let mut found = None;
        for id in dom::inclusive_ancestors(doc, target) {
            if doc.get_node(id).is_some_and(|n| n.is_element()) && is_focusable(doc, id) {
                found = Some(id);
                break;
            }
        }
        if let Some(f) = found
            && forms::is_text_control(doc, f)
        {
            return;
        }
        found
    };
    change_focus(scope, st, new);
}

// ---------------------------------------------------------------------------------
// Activation behavior
// ---------------------------------------------------------------------------------

/// State saved by legacy-pre-activation behavior (restored if the click is canceled).
#[derive(Clone, Copy, Debug)]
pub(crate) enum PreActivation {
    None,
    Checkbox {
        id: NodeId,
        was: bool,
    },
    Radio {
        id: NodeId,
        was: bool,
        previous: Option<NodeId>,
    },
}

/// Modifier/button state of the activating click.
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct ClickInfo {
    pub(crate) ctrl: bool,
    pub(crate) meta: bool,
    pub(crate) shift: bool,
    pub(crate) middle: bool,
}

fn has_activation_behavior(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    let Some(el) = node.element_data() else {
        return false;
    };
    if el.name.ns != blitz_dom::ns!(html) {
        // SVG <a> elements are links too.
        return &*el.name.local == "a"
            && (el.has_attr(local_name!("href"))
                || dom::get_attr(doc, id, "xlink:href").is_some());
    }
    let _ = st;
    match &*el.name.local {
        "a" | "area" => el.has_attr(local_name!("href")),
        "button" => true,
        "input" => matches!(
            forms::input_type(doc, id).as_str(),
            "checkbox" | "radio" | "submit" | "image" | "reset" | "button"
        ),
        "summary" => is_details_summary(doc, id),
        "label" => true,
        _ => false,
    }
}

fn is_details_summary(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(p) = doc.get_node(id).and_then(|n| n.parent) else {
        return false;
    };
    dom::is_html_id(doc, p, &local_name!("details"))
        && doc.get_node(p).and_then(|pn| {
            pn.children
                .iter()
                .copied()
                .find(|&c| dom::is_html_id(doc, c, &local_name!("summary")))
        }) == Some(id)
}

/// The activation target for a click at `target`: the nearest inclusive ancestor with
/// activation behavior.
pub(crate) fn activation_target(
    st: &RuntimeState,
    doc: &BaseDocument,
    target: NodeId,
) -> Option<NodeId> {
    dom::inclusive_ancestors(doc, target)
        .into_iter()
        .find(|&id| has_activation_behavior(st, doc, id))
}

/// Is a click at `target` suppressed because it hits a disabled form control?
pub(crate) fn hits_disabled_control(doc: &BaseDocument, target: NodeId) -> bool {
    dom::inclusive_ancestors(doc, target).into_iter().any(|id| {
        doc.get_node(id)
            .and_then(|n| n.element_data())
            .is_some_and(|el| {
                el.name.ns == blitz_dom::ns!(html)
                    && matches!(&*el.name.local, "button" | "input" | "select" | "textarea")
            })
            && forms::is_disabled(doc, id)
    })
}

/// Legacy-pre-activation behavior (checkbox/radio state flips before dispatch).
pub(crate) fn pre_activate(st: &RuntimeState, doc: &mut BaseDocument, at: NodeId) -> PreActivation {
    if !dom::is_html_id(doc, at, &local_name!("input")) {
        return PreActivation::None;
    }
    match forms::input_type(doc, at).as_str() {
        "checkbox" => {
            let was = forms::get_checked(st, doc, at);
            forms::set_checked(st, doc, at, !was, true);
            PreActivation::Checkbox { id: at, was }
        }
        "radio" => {
            let was = forms::get_checked(st, doc, at);
            let previous = forms::radio_group(doc, at)
                .into_iter()
                .find(|&o| forms::get_checked(st, doc, o));
            forms::set_checked(st, doc, at, true, true);
            PreActivation::Radio {
                id: at,
                was,
                previous,
            }
        }
        _ => PreActivation::None,
    }
}

/// Legacy-canceled-activation behavior.
pub(crate) fn cancel_activation(st: &RuntimeState, doc: &mut BaseDocument, pre: PreActivation) {
    match pre {
        PreActivation::None => {}
        PreActivation::Checkbox { id, was } => forms::set_checked(st, doc, id, was, true),
        PreActivation::Radio { id, was, previous } => {
            if let Some(p) = previous {
                forms::set_checked(st, doc, p, true, true);
            } else {
                forms::set_checked(st, doc, id, was, true);
            }
        }
    }
}

/// Run the activation behavior of `at` after a click that was not canceled.
/// `target` is the original click target (for label forwarding).
pub(crate) fn run_activation(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    at: NodeId,
    target: NodeId,
    pre: PreActivation,
    info: ClickInfo,
) {
    // Checkbox / radio: input + change if the state changed.
    let changed = match pre {
        PreActivation::Checkbox { .. } => true,
        PreActivation::Radio { was, .. } => !was,
        PreActivation::None => false,
    };
    if changed {
        let init = simple_init(scope, true, false);
        let composed = v8::Boolean::new(scope, true).into();
        set_prop(scope, init, "composed", composed);
        dispatch(scope, st, "input", at, init);
        let init = simple_init(scope, true, false);
        dispatch(scope, st, "change", at, init);
        return;
    }
    enum What {
        Nothing,
        Submit(NodeId),
        Reset(NodeId),
        Link,
        Summary(NodeId),
        Label(NodeId),
    }
    let what = {
        let Ok(doc) = st.doc() else { return };
        let Some(el) = doc.get_node(at).and_then(|n| n.element_data()) else {
            return;
        };
        let local = el.name.local.clone();
        if forms::is_disabled(doc, at) {
            What::Nothing
        } else if forms::is_submit_button(doc, at) {
            match forms::form_owner(doc, at) {
                Some(f) => What::Submit(f),
                None => What::Nothing,
            }
        } else if forms::is_reset_button(doc, at) {
            match forms::form_owner(doc, at) {
                Some(f) => What::Reset(f),
                None => What::Nothing,
            }
        } else if &*local == "a" || &*local == "area" {
            What::Link
        } else if &*local == "summary" {
            match doc.get_node(at).and_then(|n| n.parent) {
                Some(d) => What::Summary(d),
                None => What::Nothing,
            }
        } else if &*local == "label" {
            match forms::label_control(doc, at) {
                Some(c) if !dom::is_inclusive_ancestor(doc, c, target) => What::Label(c),
                _ => What::Nothing,
            }
        } else {
            What::Nothing
        }
    };
    match what {
        What::Nothing => {}
        What::Submit(form) => submit_with_events(scope, st, form, Some(at)),
        What::Reset(form) => reset_with_events(scope, st, form),
        What::Link => follow_hyperlink(scope, st, at, info),
        What::Summary(details) => {
            if let Ok(doc) = st.doc() {
                doc.toggle_details_open(details);
                st.invalidate_layout();
            }
            let init = simple_init(scope, false, false);
            dispatch(scope, st, "toggle", details, init);
        }
        What::Label(control) => {
            let focusable = st.doc().is_ok_and(|doc| is_focusable(doc, control));
            if focusable {
                change_focus(scope, st, Some(control));
            }
            synthetic_click(scope, st, control, info);
        }
    }
}

/// Returned by the JS layer's dispatch when it performed the click's activation
/// behavior itself (NATIVE_API "default action split").
pub(crate) const DEFAULT_HANDLED: u32 = 4;

/// Dispatch a trusted `click` at `target` (native pointer click, keyboard activation,
/// label forwarding, implicit submission) and run its activation behavior. With the JS
/// layer loaded, the layer's dispatch performs activation behavior (checkboxes, radios,
/// form submission and reset, labels, `<summary>`) and reports it with flag 4; Rust only
/// follows hyperlinks it leaves alone. Without it (natives-only runtimes) Rust does
/// everything: legacy-pre-activation before dispatch, then activation or its cancelation.
/// Clicks on disabled form controls are not dispatched. Returns the dispatch flags.
pub(crate) fn click_with_activation<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    st: &RuntimeState,
    target: NodeId,
    init: v8::Local<'s, v8::Object>,
    info: ClickInfo,
) -> u32 {
    let layer = st.layer_loaded.get();
    let (at, pre) = {
        let Ok(doc) = st.doc() else { return 0 };
        if hits_disabled_control(doc, target) {
            return 0;
        }
        if layer {
            (layer_activation_element(doc, target), PreActivation::None)
        } else {
            let at = activation_target(st, doc, target);
            let pre = match at {
                Some(a) => pre_activate(st, doc, a),
                None => PreActivation::None,
            };
            (at, pre)
        }
    };
    let flags = dispatch(scope, st, "click", target, init);
    if layer {
        if flags & (CANCELED | DEFAULT_HANDLED) == 0 {
            let link = at.filter(|&a| st.doc().is_ok_and(|doc| is_hyperlink(doc, a)));
            if let Some(a) = link {
                follow_hyperlink(scope, st, a, info);
            }
        }
    } else if flags & CANCELED != 0 {
        if let Ok(doc) = st.doc() {
            cancel_activation(st, doc, pre);
        }
    } else if let Some(at) = at {
        run_activation(scope, st, at, target, pre, info);
    }
    flags
}

/// The element whose activation behavior a click at `target` triggers, as the JS layer
/// chooses it (nearest `a`, `area`, `button`, `input`, `label`, details `summary`).
fn layer_activation_element(doc: &BaseDocument, target: NodeId) -> Option<NodeId> {
    dom::inclusive_ancestors(doc, target)
        .into_iter()
        .find(|&id| {
            let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
                return false;
            };
            if el.name.ns != blitz_dom::ns!(html) {
                return &*el.name.local == "a";
            }
            match &*el.name.local {
                "a" | "area" | "button" | "input" | "label" => true,
                "summary" => is_details_summary(doc, id),
                _ => false,
            }
        })
}

/// `<a>` / `<area>` (or SVG `<a>`) with an `href`.
fn is_hyperlink(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return false;
    };
    let local = &*el.name.local;
    let html = el.name.ns == blitz_dom::ns!(html);
    (local == "a" || (html && local == "area"))
        && (el.has_attr(local_name!("href")) || dom::get_attr(doc, id, "xlink:href").is_some())
}

/// Fire a synthetic trusted `click` at `target` (keyboard activation, label forwarding,
/// implicit submission's default button) with activation behavior.
pub(crate) fn synthetic_click(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    target: NodeId,
    info: ClickInfo,
) {
    let init = simple_init(scope, true, true);
    let composed = v8::Boolean::new(scope, true).into();
    set_prop(scope, init, "composed", composed);
    let zero = v8::Integer::new(scope, 0).into();
    set_prop(scope, init, "detail", zero);
    let pointer_type = crate::cx::v8_str(scope, "").into();
    set_prop(scope, init, "pointerType", pointer_type);
    click_with_activation(scope, st, target, init, info);
}

/// Submit `form` as if by `submitter` (or `form.requestSubmit()`): constraint
/// validation (required fields), `submit` event, then navigation.
pub(crate) fn submit_with_events(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    form: NodeId,
    submitter: Option<NodeId>,
) {
    let invalid = {
        let Ok(doc) = st.doc() else { return };
        if !dom::is_connected(doc, form) {
            return;
        }
        let novalidate = dom::get_attr(doc, form, "novalidate").is_some()
            || submitter.is_some_and(|s| dom::get_attr(doc, s, "formnovalidate").is_some());
        if novalidate {
            None
        } else {
            forms::first_invalid_control(st, doc, form)
        }
    };
    if let Some(ctrl) = invalid {
        let init = simple_init(scope, false, true);
        let flags = dispatch(scope, st, "invalid", ctrl, init);
        if flags & CANCELED == 0 {
            let focusable = st.doc().is_ok_and(|doc| is_focusable(doc, ctrl));
            if focusable {
                change_focus(scope, st, Some(ctrl));
            }
            st.host
                .console("warn", "form submission blocked: a required field is empty");
        }
        return;
    }
    let init = simple_init(scope, true, true);
    let sub = match submitter {
        Some(s) => id_value(scope, s),
        None => v8::Integer::new(scope, 0).into(),
    };
    set_prop(scope, init, "submitterId", sub);
    let flags = dispatch(scope, st, "submit", form, init);
    if flags & CANCELED != 0 {
        return;
    }
    navigate_form(st, form, submitter);
}

/// Navigate with the form data set (no events). Used by `N.submitForm`.
pub(crate) fn navigate_form(st: &RuntimeState, form: NodeId, submitter: Option<NodeId>) {
    let plan = {
        let Ok(doc) = st.doc() else { return };
        forms::plan_submission(st, doc, form, submitter)
    };
    let Some(s) = plan else { return };
    if s.new_tab {
        st.host.open_new_tab(&s.url);
    } else {
        st.host
            .navigate(&s.url, false, s.method, s.body, s.content_type);
    }
}

pub(crate) fn reset_with_events(scope: &mut v8::PinScope, st: &RuntimeState, form: NodeId) {
    let init = simple_init(scope, true, true);
    let flags = dispatch(scope, st, "reset", form, init);
    if flags & CANCELED == 0
        && let Ok(doc) = st.doc()
    {
        forms::reset_form(st, doc, form);
    }
}

/// Follow the hyperlink of an `<a>`/`<area>` element.
pub(crate) fn follow_hyperlink(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    anchor: NodeId,
    info: ClickInfo,
) {
    let (url, new_tab) = {
        let Ok(doc) = st.doc() else { return };
        let href = dom::get_attr(doc, anchor, "href")
            .or_else(|| dom::get_attr(doc, anchor, "xlink:href"))
            .unwrap_or("")
            .to_string();
        let doc_url = st.url.borrow().clone();
        let base = dom::base_url(doc, &doc_url);
        let Ok(url) = base.join(href.trim()) else {
            return;
        };
        let target = dom::get_attr(doc, anchor, "target")
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let new_tab = info.ctrl
            || info.meta
            || info.shift
            || info.middle
            || (!target.is_empty() && !matches!(target.as_str(), "_self" | "_top" | "_parent"));
        (url, new_tab)
    };
    navigate_to(scope, st, url, false, new_tab);
}

/// Begin navigating to `url`: `javascript:` URLs run in the page, same-document
/// fragment changes scroll and fire `hashchange`, everything else goes to the host.
/// Returns true if handled within the document.
pub(crate) fn navigate_to(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    url: url::Url,
    replace: bool,
    new_tab: bool,
) -> bool {
    if url.scheme() == "javascript" {
        let code = &url.as_str()["javascript:".len()..];
        let code = percent_decode(code);
        if let Err(e) = crate::runtime::run_classic(scope, &code, "javascript:")
            && let Some(exc) = e.exception
        {
            crate::runtime::report_exception(scope, st, exc, None);
        }
        return true;
    }
    if new_tab {
        st.host.open_new_tab(url.as_str());
        return false;
    }
    let same_doc = {
        let cur = st.url.borrow();
        url.fragment().is_some()
            && cur[..url::Position::AfterQuery] == url[..url::Position::AfterQuery]
    };
    if same_doc {
        fragment_navigate(scope, st, url, replace);
        return true;
    }
    st.host.navigate(url.as_str(), replace, "GET", None, None);
    false
}

/// Same-document navigation to a fragment: new session history entry, scroll to the
/// target, then `popstate` (and `hashchange`) through hook `onPopState`.
pub(crate) fn fragment_navigate(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    url: url::Url,
    replace: bool,
) {
    let unchanged = *st.url.borrow() == url;
    if !unchanged {
        st.same_document_navigation(&url, replace);
    }
    scroll_to_url_fragment(st, &url);
    st.host.request_redraw();
    if !unchanged {
        fire_popstate(scope, st, url.as_str());
    }
}

/// Scroll to the element indicated by `url`'s fragment ("indicated part"), if any.
pub(crate) fn scroll_to_url_fragment(st: &RuntimeState, url: &url::Url) {
    let Some(frag) = url.fragment() else { return };
    if let Ok(doc) = st.doc()
        && doc.try_root_element().is_some()
    {
        let before = doc.viewport_scroll();
        doc.scroll_to_fragment(&percent_decode(frag));
        if doc.viewport_scroll() != before {
            st.queue_task(InternalTask::ViewportScroll);
        }
    }
}

/// Hook `onPopState(url, index)`: the document URL changed through a same-document
/// navigation or history traversal; the JS layer fires `popstate` (with the state stored
/// for `index`) and, if only the fragment changed, `hashchange`.
pub(crate) fn fire_popstate(scope: &mut v8::PinScope, st: &RuntimeState, url: &str) {
    let (index, _) = st.history_position();
    let url = crate::cx::v8_str(scope, url);
    let index = v8::Integer::new_from_unsigned(scope, index);
    crate::runtime::call_hook(
        scope,
        st,
        crate::state::Hook::PopState,
        &[url.into(), index.into()],
    );
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |c: &u8| (*c as char).to_digit(16);
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(a), Some(b)) = (
                bytes.get(i + 1).and_then(hex),
                bytes.get(i + 2).and_then(hex),
            )
        {
            out.push((a * 16 + b) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Implicit submission (Enter in a text field) for the form owning `field`.
pub(crate) fn implicit_submission(scope: &mut v8::PinScope, st: &RuntimeState, field: NodeId) {
    enum Plan {
        Click(NodeId),
        Submit(NodeId),
        Nothing,
    }
    let plan = {
        let Ok(doc) = st.doc() else { return };
        let Some(form) = forms::form_owner(doc, field) else {
            return;
        };
        match forms::default_button(doc, form) {
            Some(b) if forms::is_disabled(doc, b) => Plan::Nothing,
            Some(b) => Plan::Click(b),
            None => {
                if forms::implicit_submission_blockers(doc, form) > 1 {
                    Plan::Nothing
                } else {
                    Plan::Submit(form)
                }
            }
        }
    };
    match plan {
        Plan::Click(b) => synthetic_click(scope, st, b, ClickInfo::default()),
        Plan::Submit(form) => submit_with_events(scope, st, form, None),
        Plan::Nothing => {}
    }
}

/// Default action for a synthetic (script-dispatched, not canceled) event.
/// Only `click` has one. Returns true if something happened.
pub(crate) fn run_default_action(
    scope: &mut v8::PinScope,
    st: &RuntimeState,
    target: NodeId,
    ty: &str,
) -> bool {
    if ty != "click" {
        return false;
    }
    let (at, pre) = {
        let Ok(doc) = st.doc() else { return false };
        if hits_disabled_control(doc, target) {
            return false;
        }
        let Some(at) = activation_target(st, doc, target) else {
            return false;
        };
        (at, pre_activate(st, doc, at))
    };
    run_activation(scope, st, at, target, pre, ClickInfo::default());
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn percent() {
        assert_eq!(super::percent_decode("void(0)%3B%20x"), "void(0); x");
        assert_eq!(super::percent_decode("a%2"), "a%2");
        assert_eq!(super::percent_decode("%zz"), "%zz");
    }
}
