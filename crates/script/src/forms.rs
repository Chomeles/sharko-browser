//! Form controls: values, checkedness, `<select>` state, dirty flags, form owners,
//! form data sets, submission planning and reset.
//!
//! blitz keeps the live value of text controls in a parley editor
//! (`SpecialElementData::TextInput`) and checkbox/radio state in
//! `SpecialElementData::CheckboxInput`, both created lazily during layout. We create
//! them eagerly when script needs them (blitz keeps existing data at layout time).

use blitz_dom::node::{SpecialElementData, TextInputData};
use blitz_dom::{BaseDocument, LocalName, NodeId, local_name, ns};
use style_dom::ElementState;

use crate::cx::JsErr;
use crate::dom;
use crate::state::RuntimeState;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ValueMode {
    /// Text-like input backed by an editor.
    Text,
    /// hidden/submit/reset/button/image: value is the `value` attribute.
    Default,
    /// checkbox/radio: `value` attribute or "on".
    DefaultOn,
    /// file inputs.
    Filename,
    /// range/color/date/...: an internal value (no editor in blitz).
    Value,
}

/// The input's type keyword (lowercase, defaulting to "text").
pub(crate) fn input_type(doc: &BaseDocument, id: NodeId) -> String {
    let t = dom::get_attr(doc, id, "type")
        .unwrap_or("text")
        .trim()
        .to_ascii_lowercase();
    match t.as_str() {
        "text" | "password" | "email" | "number" | "search" | "tel" | "url" | "hidden"
        | "submit" | "reset" | "button" | "image" | "checkbox" | "radio" | "file" | "range"
        | "color" | "date" | "month" | "week" | "time" | "datetime-local" => t,
        _ => "text".to_string(),
    }
}

pub(crate) fn value_mode(ty: &str) -> ValueMode {
    match ty {
        "hidden" | "submit" | "reset" | "button" | "image" => ValueMode::Default,
        "checkbox" | "radio" => ValueMode::DefaultOn,
        "file" => ValueMode::Filename,
        "range" | "color" | "date" | "month" | "week" | "time" | "datetime-local" => {
            ValueMode::Value
        }
        _ => ValueMode::Text,
    }
}

#[inline]
fn is_input(doc: &BaseDocument, id: NodeId) -> bool {
    dom::is_html_id(doc, id, &local_name!("input"))
}

#[inline]
fn is_textarea(doc: &BaseDocument, id: NodeId) -> bool {
    dom::is_html_id(doc, id, &local_name!("textarea"))
}

/// Is this a control whose value is edited as text (text-like input or textarea)?
pub(crate) fn is_text_control(doc: &BaseDocument, id: NodeId) -> bool {
    is_textarea(doc, id)
        || (is_input(doc, id) && value_mode(&input_type(doc, id)) == ValueMode::Text)
}

fn strip_newlines(s: &str) -> String {
    s.chars().filter(|&c| c != '\n' && c != '\r').collect()
}

fn normalize_newlines(s: &str) -> String {
    if s.contains('\r') {
        s.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        s.to_string()
    }
}

fn editor_text(doc: &BaseDocument, id: NodeId) -> Option<String> {
    doc.get_node(id)?
        .element_data()?
        .text_input_data()
        .map(|t| t.editor.raw_text().to_string())
}

/// Replace the editor text of a text control (creating the editor if needed).
fn set_editor_text(doc: &mut BaseDocument, id: NodeId, text: &str, multiline: bool) {
    if let Some(el) = doc.get_node_mut(id).and_then(|n| n.element_data_mut()) {
        if !matches!(el.special_data, SpecialElementData::TextInput(_)) {
            el.special_data = SpecialElementData::TextInput(TextInputData::new(multiline));
        }
    } else {
        return;
    }
    let was_empty = editor_text(doc, id).is_none_or(|t| t.is_empty());
    doc.with_text_input(id, |mut driver| {
        driver.editor.set_text(text);
        driver.move_to_text_end();
    });
    if was_empty != text.is_empty() {
        // `:placeholder-shown` (and dependent sibling selectors) changed.
        doc.restyle_for_value_emptiness_change(id);
    }
    doc.shell_provider.request_redraw();
}

/// The textarea's default value (child text content) was changed: update the raw
/// value unless the user/script already edited it. Also creates the editor so blitz
/// doesn't initialize it from the (meaningless) `value` attribute.
pub(crate) fn sync_textarea_default(st: &RuntimeState, doc: &mut BaseDocument, id: NodeId) {
    if st.forms.borrow().dirty_value.contains(&id) {
        return;
    }
    let text = normalize_newlines(&dom::child_text(doc, id));
    if editor_text(doc, id).as_deref() == Some(text.as_str()) {
        return;
    }
    set_editor_text(doc, id, &text, true);
}

/// Is the `value` attribute of this control decoupled from its value (dirty flag set)?
pub(crate) fn value_attr_is_shadowed(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> bool {
    (is_input(doc, id) || is_textarea(doc, id)) && st.forms.borrow().dirty_value.contains(&id)
}

/// Option text for `option.text` / default values: strip and collapse ASCII whitespace.
fn collapsed_text(doc: &BaseDocument, id: NodeId) -> String {
    let mut s = String::new();
    dom::descendant_text(doc, id, &mut s);
    s.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn option_value(doc: &BaseDocument, opt: NodeId) -> String {
    match dom::get_attr(doc, opt, "value") {
        Some(v) => v.to_string(),
        None => collapsed_text(doc, opt),
    }
}

/// The select's list of options (option children and option children of optgroups).
pub(crate) fn select_options(doc: &BaseDocument, select: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    let Some(n) = doc.get_node(select) else {
        return out;
    };
    for &c in n.children.iter() {
        let Some(cn) = doc.get_node(c) else { continue };
        if dom::is_html(cn, &local_name!("option")) {
            out.push(c);
        } else if dom::is_html(cn, &local_name!("optgroup")) {
            for &g in cn.children.iter() {
                if dom::is_html_id(doc, g, &local_name!("option")) {
                    out.push(g);
                }
            }
        }
    }
    out
}

fn is_multiple(doc: &BaseDocument, select: NodeId) -> bool {
    dom::get_attr(doc, select, "multiple").is_some()
}

fn display_size(doc: &BaseDocument, select: NodeId) -> u32 {
    match dom::get_attr(doc, select, "size").and_then(|s| s.trim().parse::<u32>().ok()) {
        Some(n) if n > 0 => n,
        _ => {
            if is_multiple(doc, select) {
                4
            } else {
                1
            }
        }
    }
}

fn option_disabled(doc: &BaseDocument, opt: NodeId) -> bool {
    if dom::get_attr(doc, opt, "disabled").is_some() {
        return true;
    }
    doc.get_node(opt).and_then(|n| n.parent).is_some_and(|p| {
        dom::is_html_id(doc, p, &local_name!("optgroup"))
            && dom::get_attr(doc, p, "disabled").is_some()
    })
}

/// The select owning an option (parent select or grandparent through optgroup).
fn option_select(doc: &BaseDocument, opt: NodeId) -> Option<NodeId> {
    let p = doc.get_node(opt)?.parent?;
    if dom::is_html_id(doc, p, &local_name!("select")) {
        return Some(p);
    }
    if dom::is_html_id(doc, p, &local_name!("optgroup")) {
        let gp = doc.get_node(p)?.parent?;
        if dom::is_html_id(doc, gp, &local_name!("select")) {
            return Some(gp);
        }
    }
    None
}

/// Selectedness of every option of `select`, applying the single-select rules
/// (at most one selected: the last explicitly/attribute-selected; if none and the
/// display size is 1, the first non-disabled option).
fn selectedness_list(st: &RuntimeState, doc: &BaseDocument, select: NodeId) -> Vec<(NodeId, bool)> {
    let opts = select_options(doc, select);
    let forms = st.forms.borrow();
    let any_explicit = opts.iter().any(|o| forms.selectedness.contains_key(o));
    let mut list: Vec<(NodeId, bool)> = opts
        .iter()
        .map(|&o| {
            let sel = forms
                .selectedness
                .get(&o)
                .copied()
                .unwrap_or_else(|| dom::get_attr(doc, o, "selected").is_some());
            (o, sel)
        })
        .collect();
    if !is_multiple(doc, select) {
        let last = list.iter().rposition(|(_, s)| *s);
        for (i, e) in list.iter_mut().enumerate() {
            e.1 = Some(i) == last;
        }
        if last.is_none()
            && !any_explicit
            && display_size(doc, select) == 1
            && let Some(first) = list.iter_mut().find(|(o, _)| !option_disabled(doc, *o))
        {
            first.1 = true;
        }
    }
    list
}

pub(crate) fn selected_index(st: &RuntimeState, doc: &BaseDocument, select: NodeId) -> i32 {
    selectedness_list(st, doc, select)
        .iter()
        .position(|(_, s)| *s)
        .map(|i| i as i32)
        .unwrap_or(-1)
}

pub(crate) fn set_selected_index(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    select: NodeId,
    index: i32,
) {
    let opts = select_options(doc, select);
    {
        let mut forms = st.forms.borrow_mut();
        for (i, o) in opts.iter().enumerate() {
            forms.selectedness.insert(*o, i as i32 == index);
        }
    }
    select_changed(st, doc, select);
}

pub(crate) fn option_selected(st: &RuntimeState, doc: &BaseDocument, opt: NodeId) -> bool {
    match option_select(doc, opt) {
        Some(sel) => selectedness_list(st, doc, sel)
            .iter()
            .find(|(o, _)| *o == opt)
            .is_some_and(|(_, s)| *s),
        None => st
            .forms
            .borrow()
            .selectedness
            .get(&opt)
            .copied()
            .unwrap_or_else(|| dom::get_attr(doc, opt, "selected").is_some()),
    }
}

pub(crate) fn set_option_selected(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    opt: NodeId,
    selected: bool,
) {
    let select = option_select(doc, opt);
    {
        let mut forms = st.forms.borrow_mut();
        if let Some(sel) = select
            && selected
            && !is_multiple(doc, sel)
        {
            for o in select_options(doc, sel) {
                forms.selectedness.insert(o, o == opt);
            }
        }
        forms.selectedness.insert(opt, selected);
    }
    if let Some(sel) = select {
        select_changed(st, doc, sel);
    }
}

fn select_changed(st: &RuntimeState, doc: &mut BaseDocument, select: NodeId) {
    if let Some(n) = doc.get_node_mut(select) {
        n.set_restyle_hint(blitz_dom::RestyleHint::RESTYLE_DESCENDANTS);
    }
    sync_select_display(st, doc, select);
    st.invalidate_layout();
    doc.shell_provider.request_redraw();
}

/// Show the selected option(s) of `select` (the `:checked` state the UA stylesheet uses to
/// render the drop-down's current option).
pub(crate) fn sync_select_display(st: &RuntimeState, doc: &mut BaseDocument, select: NodeId) {
    let list = selectedness_list(st, doc, select);
    doc.set_select_state(select, &list, true);
}

// ---------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------

pub(crate) fn get_value(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> String {
    let Some(node) = doc.get_node(id) else {
        return String::new();
    };
    let Some(el) = node.element_data() else {
        return String::new();
    };
    if el.name.ns != ns!(html) {
        return String::new();
    }
    match &*el.name.local {
        "input" => {
            let ty = input_type(doc, id);
            match value_mode(&ty) {
                ValueMode::Text => editor_text(doc, id)
                    .unwrap_or_else(|| strip_newlines(el.attr(local_name!("value")).unwrap_or(""))),
                ValueMode::Default => el.attr(local_name!("value")).unwrap_or("").to_string(),
                ValueMode::DefaultOn => el.attr(local_name!("value")).unwrap_or("on").to_string(),
                ValueMode::Filename => String::new(),
                ValueMode::Value => {
                    if let Some(v) = st.forms.borrow().mode_value.get(&id) {
                        return v.clone();
                    }
                    let attr = el.attr(local_name!("value")).unwrap_or("");
                    match ty.as_str() {
                        "range" => sanitize_range(doc, id, attr),
                        "color" => sanitize_color(attr),
                        _ => attr.to_string(),
                    }
                }
            }
        }
        "textarea" => {
            editor_text(doc, id).unwrap_or_else(|| normalize_newlines(&dom::child_text(doc, id)))
        }
        "select" => selectedness_list(st, doc, id)
            .iter()
            .find(|(_, s)| *s)
            .map(|(o, _)| option_value(doc, *o))
            .unwrap_or_default(),
        "option" => option_value(doc, id),
        _ => el.attr(local_name!("value")).unwrap_or("").to_string(),
    }
}

fn sanitize_range(doc: &BaseDocument, id: NodeId, v: &str) -> String {
    let min = dom::get_attr(doc, id, "min")
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(0.0);
    let max = dom::get_attr(doc, id, "max")
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(100.0);
    let max = if max < min { min } else { max };
    let val = match v.trim().parse::<f64>() {
        Ok(x) if x.is_finite() => x.clamp(min, max),
        _ => min + (max - min) / 2.0,
    };
    crate::natives::format_number(val)
}

fn sanitize_color(v: &str) -> String {
    let v = v.trim();
    if v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        v.to_ascii_lowercase()
    } else {
        "#000000".to_string()
    }
}

pub(crate) fn set_value(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    value: &str,
) -> Result<(), JsErr> {
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return Err(JsErr::type_err("not an element"));
    };
    if el.name.ns != ns!(html) {
        return Ok(());
    }
    let local = el.name.local.clone();
    match &*local {
        "input" => {
            let ty = input_type(doc, id);
            match value_mode(&ty) {
                ValueMode::Text => {
                    let v = strip_newlines(value);
                    set_editor_text(doc, id, &v, false);
                    st.forms.borrow_mut().dirty_value.insert(id);
                }
                ValueMode::Default | ValueMode::DefaultOn => {
                    dom::set_attr(st, doc, id, "value", value)?;
                }
                ValueMode::Filename => {
                    if !value.is_empty() {
                        return Err(JsErr::dom(
                            "InvalidStateError",
                            "a file input's value can only be set to the empty string",
                        ));
                    }
                }
                ValueMode::Value => {
                    let v = match ty.as_str() {
                        "range" => sanitize_range(doc, id, value),
                        "color" => sanitize_color(value),
                        _ => value.to_string(),
                    };
                    let mut forms = st.forms.borrow_mut();
                    forms.mode_value.insert(id, v);
                    forms.dirty_value.insert(id);
                }
            }
        }
        "textarea" => {
            let v = normalize_newlines(value);
            set_editor_text(doc, id, &v, true);
            st.forms.borrow_mut().dirty_value.insert(id);
        }
        "select" => {
            let opts = select_options(doc, id);
            let mut found = false;
            let values: Vec<String> = opts.iter().map(|&o| option_value(doc, o)).collect();
            {
                let mut forms = st.forms.borrow_mut();
                for (o, v) in opts.iter().zip(values.iter()) {
                    let sel = !found && v == value;
                    found |= sel;
                    forms.selectedness.insert(*o, sel);
                }
            }
            select_changed(st, doc, id);
        }
        _ => {
            dom::set_attr(st, doc, id, "value", value)?;
        }
    }
    st.invalidate_layout();
    Ok(())
}

/// Record that the user edited a text control (blitz editor input).
pub(crate) fn mark_user_edit(st: &RuntimeState, id: NodeId) {
    st.forms.borrow_mut().dirty_value.insert(id);
}

// ---------------------------------------------------------------------------------
// Checkedness
// ---------------------------------------------------------------------------------

fn is_checkable(doc: &BaseDocument, id: NodeId) -> Option<bool /* radio */> {
    if !is_input(doc, id) {
        return None;
    }
    match input_type(doc, id).as_str() {
        "checkbox" => Some(false),
        "radio" => Some(true),
        _ => None,
    }
}

pub(crate) fn get_checked(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> bool {
    if dom::is_html_id(doc, id, &local_name!("option")) {
        return option_selected(st, doc, id);
    }
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return false;
    };
    if is_checkable(doc, id).is_some() {
        if let Some(b) = el.checkbox_input_checked() {
            return b;
        }
        if st.forms.borrow().dirty_checked.contains(&id) {
            return el.element_state.contains(ElementState::CHECKED);
        }
        return el.has_attr(local_name!("checked"));
    }
    st.forms
        .borrow()
        .other_checked
        .get(&id)
        .copied()
        .unwrap_or_else(|| el.has_attr(local_name!("checked")))
}

/// Set checkedness. `dirty` marks the change as user/script-initiated (the `checked`
/// attribute then no longer affects it). Checking a radio unchecks its group.
pub(crate) fn set_checked(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    checked: bool,
    dirty: bool,
) {
    if dom::is_html_id(doc, id, &local_name!("option")) {
        set_option_selected(st, doc, id, checked);
        return;
    }
    match is_checkable(doc, id) {
        Some(is_radio) => {
            write_checkbox_state(doc, id, checked);
            if is_radio && checked {
                for other in radio_group(doc, id) {
                    write_checkbox_state(doc, other, false);
                }
            }
        }
        None => {
            st.forms.borrow_mut().other_checked.insert(id, checked);
        }
    }
    if dirty {
        st.forms.borrow_mut().dirty_checked.insert(id);
    }
    st.invalidate_layout();
    doc.shell_provider.request_redraw();
}

fn write_checkbox_state(doc: &mut BaseDocument, id: NodeId, checked: bool) {
    if let Some(el) = doc.get_node_mut(id).and_then(|n| n.element_data_mut()) {
        if !matches!(el.special_data, SpecialElementData::CheckboxInput(_)) {
            el.special_data = SpecialElementData::CheckboxInput(!checked);
        }
    } else {
        return;
    }
    doc.snapshot_node_and(id, ElementState::CHECKED, |node| {
        if let Some(el) = node.element_data_mut() {
            el.set_checkbox_input_checked(checked);
        }
        node.mark_ancestors_dirty();
    });
}

/// An input's `type` changed: checkedness is independent of the type in HTML, but blitz
/// keeps it in type-specific data, so carry it across.
fn type_changed(st: &RuntimeState, doc: &mut BaseDocument, id: NodeId) {
    let checkable = is_checkable(doc, id).is_some();
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return;
    };
    let special = el.checkbox_input_checked();
    let attr_checked = el.has_attr(local_name!("checked"));
    match (checkable, special) {
        (true, None) => {
            let c = st
                .forms
                .borrow_mut()
                .other_checked
                .remove(&id)
                .unwrap_or(attr_checked);
            write_checkbox_state(doc, id, c);
        }
        (false, Some(c)) => {
            st.forms.borrow_mut().other_checked.insert(id, c);
            doc.snapshot_node_and(id, ElementState::CHECKED, |node| {
                if let Some(el) = node.element_data_mut() {
                    el.special_data = SpecialElementData::None;
                    el.element_state.remove(ElementState::CHECKED);
                }
            });
        }
        _ => {}
    }
}

/// Other radio buttons in the same group as `id` (same name, form owner and tree).
pub(crate) fn radio_group(doc: &BaseDocument, id: NodeId) -> Vec<NodeId> {
    let Some(name) = dom::get_attr(doc, id, "name").filter(|n| !n.is_empty()) else {
        return Vec::new();
    };
    let owner = form_owner(doc, id);
    let root = *dom::inclusive_ancestors(doc, id).last().unwrap();
    dom::subtree(doc, root)
        .into_iter()
        .filter(|&o| {
            o != id
                && is_input(doc, o)
                && input_type(doc, o) == "radio"
                && dom::get_attr(doc, o, "name") == Some(name)
                && form_owner(doc, o) == owner
        })
        .collect()
}

/// Attribute changed on an element: apply HTML semantics blitz lacks.
pub(crate) fn after_attr_change(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    qname: &str,
    set: bool,
) {
    if (qname == "type" || qname == "value") && is_input(doc, id) {
        if qname == "type" {
            type_changed(st, doc, id);
        }
        dom::sync_input_label(doc, id);
    }
    if qname == "checked"
        && is_checkable(doc, id).is_some()
        && !st.forms.borrow().dirty_checked.contains(&id)
    {
        write_checkbox_state(doc, id, set);
        if set && is_checkable(doc, id) == Some(true) {
            for other in radio_group(doc, id) {
                if !st.forms.borrow().dirty_checked.contains(&other) {
                    write_checkbox_state(doc, other, false);
                }
            }
        }
    }
}

/// Copy form state for `cloneNode` (value, checkedness, selectedness and dirty flags).
pub(crate) fn copy_clone_state(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    src: NodeId,
    dst: NodeId,
) {
    let is_text = is_text_control(doc, src);
    if is_text && st.forms.borrow().dirty_value.contains(&src) {
        let v = get_value(st, doc, src);
        let multiline = is_textarea(doc, src);
        set_editor_text(doc, dst, &v, multiline);
        st.forms.borrow_mut().dirty_value.insert(dst);
    }
    if is_checkable(doc, src).is_some() {
        let checked = get_checked(st, doc, src);
        let dirty = st.forms.borrow().dirty_checked.contains(&src);
        if dirty || checked != dom::get_attr(doc, src, "checked").is_some() {
            write_checkbox_state(doc, dst, checked);
            st.forms.borrow_mut().dirty_checked.insert(dst);
        }
    }
    let mut forms = st.forms.borrow_mut();
    if let Some(v) = forms.mode_value.get(&src).cloned() {
        forms.mode_value.insert(dst, v);
    }
    if let Some(s) = forms.selectedness.get(&src).copied() {
        forms.selectedness.insert(dst, s);
    }
}

// ---------------------------------------------------------------------------------
// Form owner, disabled state, labels
// ---------------------------------------------------------------------------------

const LISTED: [&str; 7] = [
    "button", "fieldset", "input", "object", "output", "select", "textarea",
];

pub(crate) fn is_listed(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id)
        .and_then(|n| n.element_data())
        .is_some_and(|el| el.name.ns == ns!(html) && LISTED.contains(&&*el.name.local))
}

/// HTML "form owner" of a listed element.
pub(crate) fn form_owner(doc: &BaseDocument, id: NodeId) -> Option<NodeId> {
    let node = doc.get_node(id)?;
    if let Some(form_attr) = node.element_data()?.attr(local_name!("form")) {
        if !dom::is_connected(doc, id) {
            return None;
        }
        return doc
            .get_element_by_id(form_attr)
            .filter(|&f| dom::is_html_id(doc, f, &local_name!("form")));
    }
    let mut cur = node.parent;
    while let Some(p) = cur {
        let pn = doc.get_node(p)?;
        if dom::is_html(pn, &local_name!("form")) {
            return Some(p);
        }
        cur = pn.parent;
    }
    None
}

/// Disabled form control: `disabled` attribute or inside a disabled fieldset (but not
/// in its first legend).
pub(crate) fn is_disabled(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    let Some(el) = node.element_data() else {
        return false;
    };
    if el.name.ns != ns!(html) {
        return false;
    }
    let can_be_disabled = matches!(
        &*el.name.local,
        "button" | "input" | "select" | "textarea" | "fieldset" | "optgroup" | "option"
    );
    if !can_be_disabled {
        return false;
    }
    if el.has_attr(local_name!("disabled")) {
        return true;
    }
    if &*el.name.local == "option" {
        return option_disabled(doc, id);
    }
    let mut child = id;
    let mut cur = node.parent;
    while let Some(p) = cur {
        let Some(pn) = doc.get_node(p) else { break };
        if dom::is_html(pn, &local_name!("fieldset")) && dom::get_attr(doc, p, "disabled").is_some()
        {
            let first_legend = pn
                .children
                .iter()
                .copied()
                .find(|&c| dom::is_html_id(doc, c, &local_name!("legend")));
            if first_legend != Some(child) {
                return true;
            }
        }
        child = p;
        cur = pn.parent;
    }
    false
}

/// The labeled control of a `<label>`.
pub(crate) fn label_control(doc: &BaseDocument, label: NodeId) -> Option<NodeId> {
    const LABELABLE: [&str; 7] = [
        "button", "input", "meter", "output", "progress", "select", "textarea",
    ];
    let is_labelable = |id: NodeId| {
        doc.get_node(id)
            .and_then(|n| n.element_data())
            .is_some_and(|el| {
                el.name.ns == ns!(html)
                    && LABELABLE.contains(&&*el.name.local)
                    && !(&*el.name.local == "input"
                        && el
                            .attr(local_name!("type"))
                            .is_some_and(|t| t.eq_ignore_ascii_case("hidden")))
            })
    };
    if let Some(for_id) = dom::get_attr(doc, label, "for") {
        return doc.get_element_by_id(for_id).filter(|&c| is_labelable(c));
    }
    dom::subtree(doc, label)
        .into_iter()
        .skip(1)
        .find(|&c| is_labelable(c))
}

// ---------------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------------

pub(crate) struct Submission {
    pub(crate) url: String,
    pub(crate) method: &'static str,
    pub(crate) body: Option<Vec<u8>>,
    pub(crate) content_type: Option<String>,
    pub(crate) new_tab: bool,
}

pub(crate) fn is_submit_button(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return false;
    };
    if el.name.ns != ns!(html) {
        return false;
    }
    match &*el.name.local {
        // Missing and invalid values default to the Submit Button state.
        "button" => !el
            .attr(local_name!("type"))
            .is_some_and(|t| t.eq_ignore_ascii_case("reset") || t.eq_ignore_ascii_case("button")),
        "input" => matches!(input_type(doc, id).as_str(), "submit" | "image"),
        _ => false,
    }
}

pub(crate) fn is_reset_button(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return false;
    };
    if el.name.ns != ns!(html) {
        return false;
    }
    match &*el.name.local {
        "button" => el
            .attr(local_name!("type"))
            .is_some_and(|t| t.trim().eq_ignore_ascii_case("reset")),
        "input" => input_type(doc, id) == "reset",
        _ => false,
    }
}

/// The form's default button (first submit button in tree order owned by the form).
pub(crate) fn default_button(doc: &BaseDocument, form: NodeId) -> Option<NodeId> {
    let root = *dom::inclusive_ancestors(doc, form).last().unwrap();
    dom::subtree(doc, root)
        .into_iter()
        .find(|&id| is_submit_button(doc, id) && form_owner(doc, id) == Some(form))
}

/// Number of fields owned by the form that block implicit submission.
pub(crate) fn implicit_submission_blockers(doc: &BaseDocument, form: NodeId) -> usize {
    let root = *dom::inclusive_ancestors(doc, form).last().unwrap();
    dom::subtree(doc, root)
        .into_iter()
        .filter(|&id| {
            is_input(doc, id)
                && form_owner(doc, id) == Some(form)
                && matches!(
                    input_type(doc, id).as_str(),
                    "text"
                        | "search"
                        | "url"
                        | "tel"
                        | "email"
                        | "password"
                        | "date"
                        | "month"
                        | "week"
                        | "time"
                        | "datetime-local"
                        | "number"
                )
        })
        .count()
}

enum Entry {
    Text(String, String),
    EmptyFile(String),
}

fn has_datalist_ancestor(doc: &BaseDocument, id: NodeId) -> bool {
    dom::inclusive_ancestors(doc, id)
        .iter()
        .any(|&a| dom::is_html_id(doc, a, &local_name!("datalist")))
}

/// Constructing the entry list (HTML "constructing the entry list").
fn entry_list(
    st: &RuntimeState,
    doc: &BaseDocument,
    form: NodeId,
    submitter: Option<NodeId>,
) -> Vec<Entry> {
    let mut entries = Vec::new();
    let root = *dom::inclusive_ancestors(doc, form).last().unwrap();
    for id in dom::subtree(doc, root) {
        let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
            continue;
        };
        if el.name.ns != ns!(html) {
            continue;
        }
        let local: &str = &el.name.local;
        if !matches!(local, "button" | "input" | "select" | "textarea") {
            continue;
        }
        if form_owner(doc, id) != Some(form)
            || has_datalist_ancestor(doc, id)
            || is_disabled(doc, id)
        {
            continue;
        }
        let ty = if local == "input" {
            input_type(doc, id)
        } else {
            String::new()
        };
        let is_button =
            local == "button" || matches!(ty.as_str(), "submit" | "image" | "reset" | "button");
        if is_button && Some(id) != submitter {
            continue;
        }
        if matches!(ty.as_str(), "checkbox" | "radio") && !get_checked(st, doc, id) {
            continue;
        }
        let name = el.attr(local_name!("name")).unwrap_or("");
        if ty == "image" {
            let prefix = if name.is_empty() {
                String::new()
            } else {
                format!("{name}.")
            };
            entries.push(Entry::Text(format!("{prefix}x"), "0".into()));
            entries.push(Entry::Text(format!("{prefix}y"), "0".into()));
            continue;
        }
        if name.is_empty() {
            continue;
        }
        match local {
            "select" => {
                for (o, sel) in selectedness_list(st, doc, id) {
                    if sel && !option_disabled(doc, o) {
                        entries.push(Entry::Text(name.to_string(), option_value(doc, o)));
                    }
                }
            }
            "input" if matches!(ty.as_str(), "checkbox" | "radio") => {
                let v = el.attr(local_name!("value")).unwrap_or("on");
                entries.push(Entry::Text(name.to_string(), v.to_string()));
            }
            "input" if ty == "file" => entries.push(Entry::EmptyFile(name.to_string())),
            "input" if ty == "hidden" && name.eq_ignore_ascii_case("_charset_") => {
                entries.push(Entry::Text(name.to_string(), "UTF-8".into()));
            }
            _ => {
                entries.push(Entry::Text(name.to_string(), get_value(st, doc, id)));
            }
        }
        if let Some(dirname) = el.attr(local_name!("dirname")).filter(|d| !d.is_empty())
            && (local == "textarea" || matches!(ty.as_str(), "text" | "search"))
        {
            entries.push(Entry::Text(dirname.to_string(), "ltr".into()));
        }
    }
    entries
}

fn crlf(s: &str) -> String {
    let n = normalize_newlines(s);
    if n.contains('\n') {
        n.replace('\n', "\r\n")
    } else {
        n
    }
}

fn submitter_attr<'a>(
    doc: &'a BaseDocument,
    submitter: Option<NodeId>,
    name: &str,
) -> Option<&'a str> {
    let s = submitter?;
    if !is_submit_button(doc, s) {
        return None;
    }
    dom::get_attr(doc, s, name)
}

/// Build the navigation for submitting `form` (HTML "form submission algorithm",
/// without events). Returns `None` when nothing should be navigated.
pub(crate) fn plan_submission(
    st: &RuntimeState,
    doc: &BaseDocument,
    form: NodeId,
    submitter: Option<NodeId>,
) -> Option<Submission> {
    let doc_url = st.url.borrow().clone();
    let base = dom::base_url(doc, &doc_url);
    let action = submitter_attr(doc, submitter, "formaction")
        .or_else(|| dom::get_attr(doc, form, "action"))
        .unwrap_or("")
        .trim()
        .to_string();
    let mut url = if action.is_empty() {
        doc_url.clone()
    } else {
        base.join(&action).ok()?
    };
    let method = submitter_attr(doc, submitter, "formmethod")
        .or_else(|| dom::get_attr(doc, form, "method"))
        .unwrap_or("get")
        .trim()
        .to_ascii_lowercase();
    let method = match method.as_str() {
        "post" => "POST",
        "dialog" => return None,
        _ => "GET",
    };
    let enctype = submitter_attr(doc, submitter, "formenctype")
        .or_else(|| dom::get_attr(doc, form, "enctype"))
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let target = submitter_attr(doc, submitter, "formtarget")
        .or_else(|| dom::get_attr(doc, form, "target"))
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let new_tab = !target.is_empty() && !matches!(target.as_str(), "_self" | "_top" | "_parent");

    let entries = entry_list(st, doc, form, submitter);
    let pairs: Vec<(String, String)> = entries
        .iter()
        .map(|e| match e {
            Entry::Text(n, v) => (crlf(n), crlf(v)),
            Entry::EmptyFile(n) => (crlf(n), String::new()),
        })
        .collect();

    let scheme = url.scheme().to_string();
    match (scheme.as_str(), method) {
        // Not supported: a `javascript:` action (would run the URL's script).
        ("javascript", _) => None,
        (_, "GET") => {
            let mut query = String::new();
            url::form_urlencoded::Serializer::new(&mut query).extend_pairs(pairs.iter());
            url.set_query(Some(&query));
            Some(Submission {
                url: url.to_string(),
                method: "GET",
                body: None,
                content_type: None,
                new_tab,
            })
        }
        (_, _) => {
            let (body, ct) = match enctype.as_str() {
                "multipart/form-data" => {
                    let boundary = multipart_boundary();
                    let mut body = Vec::new();
                    for e in &entries {
                        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
                        match e {
                            Entry::Text(n, v) => {
                                body.extend_from_slice(
                                    format!(
                                        "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                                        escape_mp(&crlf(n))
                                    )
                                    .as_bytes(),
                                );
                                body.extend_from_slice(crlf(v).as_bytes());
                            }
                            Entry::EmptyFile(n) => {
                                body.extend_from_slice(
                                    format!(
                                        "Content-Disposition: form-data; name=\"{}\"; filename=\"\"\r\nContent-Type: application/octet-stream\r\n\r\n",
                                        escape_mp(&crlf(n))
                                    )
                                    .as_bytes(),
                                );
                            }
                        }
                        body.extend_from_slice(b"\r\n");
                    }
                    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
                    (body, format!("multipart/form-data; boundary={boundary}"))
                }
                "text/plain" => {
                    let mut s = String::new();
                    for (n, v) in &pairs {
                        s.push_str(n);
                        s.push('=');
                        s.push_str(v);
                        s.push_str("\r\n");
                    }
                    (s.into_bytes(), "text/plain".to_string())
                }
                _ => {
                    let mut s = String::new();
                    url::form_urlencoded::Serializer::new(&mut s).extend_pairs(pairs.iter());
                    (
                        s.into_bytes(),
                        "application/x-www-form-urlencoded".to_string(),
                    )
                }
            };
            Some(Submission {
                url: url.to_string(),
                method: "POST",
                body: Some(body),
                content_type: Some(ct),
                new_tab,
            })
        }
    }
}

fn escape_mp(s: &str) -> String {
    s.replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

fn multipart_boundary() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 16];
    let _ = getrandom::fill(&mut bytes);
    let tail: String = bytes
        .iter()
        .map(|b| CHARS[(*b as usize) % CHARS.len()] as char)
        .collect();
    format!("----WebKitFormBoundary{tail}")
}

/// Reset every control owned by `form` to its default state.
pub(crate) fn reset_form(st: &RuntimeState, doc: &mut BaseDocument, form: NodeId) {
    let root = *dom::inclusive_ancestors(doc, form).last().unwrap();
    let controls: Vec<NodeId> = dom::subtree(doc, root)
        .into_iter()
        .filter(|&id| is_listed(doc, id) && form_owner(doc, id) == Some(form))
        .collect();
    for id in controls {
        let local: LocalName = match doc.get_node(id).and_then(|n| n.element_data()) {
            Some(el) => el.name.local.clone(),
            None => continue,
        };
        match &*local {
            "input" => {
                let ty = input_type(doc, id);
                {
                    let mut forms = st.forms.borrow_mut();
                    forms.dirty_value.remove(&id);
                    forms.mode_value.remove(&id);
                    forms.dirty_checked.remove(&id);
                }
                match value_mode(&ty) {
                    ValueMode::Text => {
                        let v = strip_newlines(dom::get_attr(doc, id, "value").unwrap_or(""));
                        if editor_text(doc, id).is_some() {
                            set_editor_text(doc, id, &v, false);
                        }
                    }
                    ValueMode::DefaultOn => {
                        let checked = dom::get_attr(doc, id, "checked").is_some();
                        write_checkbox_state(doc, id, checked);
                    }
                    _ => {}
                }
            }
            "textarea" => {
                st.forms.borrow_mut().dirty_value.remove(&id);
                sync_textarea_default(st, doc, id);
            }
            "select" => {
                let opts = select_options(doc, id);
                {
                    let mut forms = st.forms.borrow_mut();
                    for o in opts {
                        forms.selectedness.remove(&o);
                    }
                }
                select_changed(st, doc, id);
            }
            _ => {}
        }
    }
    st.invalidate_layout();
    doc.shell_provider.request_redraw();
}

/// Minimal constraint validation for submission: required fields must be filled.
/// Returns the first invalid control.
pub(crate) fn first_invalid_control(
    st: &RuntimeState,
    doc: &BaseDocument,
    form: NodeId,
) -> Option<NodeId> {
    let root = *dom::inclusive_ancestors(doc, form).last().unwrap();
    dom::subtree(doc, root)
        .into_iter()
        .find(|&id| suffers_value_missing(st, doc, id) && form_owner(doc, id) == Some(form))
}

/// A `required` control that is a candidate for constraint validation (not disabled,
/// not read-only) and has no value ("valueMissing").
pub(crate) fn suffers_value_missing(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> bool {
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return false;
    };
    if el.name.ns != ns!(html) || !el.has_attr(local_name!("required")) {
        return false;
    }
    if !matches!(&*el.name.local, "input" | "select" | "textarea") {
        return false;
    }
    if is_disabled(doc, id) || el.has_attr(local_name!("readonly")) {
        return false;
    }
    match &*el.name.local {
        "input" => match input_type(doc, id).as_str() {
            "checkbox" => !get_checked(st, doc, id),
            "radio" => {
                !get_checked(st, doc, id)
                    && !radio_group(doc, id)
                        .iter()
                        .any(|&o| get_checked(st, doc, o))
            }
            "hidden" | "submit" | "reset" | "button" | "image" | "range" | "color" => false,
            _ => get_value(st, doc, id).is_empty(),
        },
        _ => get_value(st, doc, id).is_empty(),
    }
}
