//! Form control, focus and default-action natives.

use crate::activation::{self, ClickInfo};
use crate::cx::{Cx, JsErr, NResult};
use crate::forms;

pub(crate) fn n_get_value(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let v = forms::get_value(cx.st, doc, id);
    cx.ret_str(&v);
    Ok(())
}

pub(crate) fn n_set_value(cx: &mut Cx) -> NResult {
    let value = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    forms::set_value(cx.st, doc, id, &value)?;
    // Keep the "value at focus" in sync so script changes don't fire `change`.
    let focused_here = cx
        .st
        .forms
        .borrow()
        .focus_value
        .as_ref()
        .is_some_and(|(n, _)| *n == id);
    if focused_here {
        let v = forms::get_value(cx.st, doc, id);
        cx.st.forms.borrow_mut().focus_value = Some((id, v));
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_get_checked(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let c = forms::get_checked(cx.st, doc, id);
    cx.ret_bool(c);
    Ok(())
}

pub(crate) fn n_set_checked(cx: &mut Cx) -> NResult {
    let checked = cx.bool(1);
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    forms::set_checked(cx.st, doc, id, checked, true);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.setIndeterminate(id, bool)`: a checkbox's IDL `indeterminate` flag (for
/// `:indeterminate` matching).
pub(crate) fn n_set_indeterminate(cx: &mut Cx) -> NResult {
    let on = cx.bool(1);
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    {
        let mut forms = cx.st.forms.borrow_mut();
        if on {
            forms.indeterminate.insert(id);
        } else {
            forms.indeterminate.remove(&id);
        }
    }
    doc.snapshot_node_and(id, style_dom::ElementState::INDETERMINATE, |node| {
        if let Some(el) = node.element_data_mut() {
            el.element_state
                .set(style_dom::ElementState::INDETERMINATE, on);
        }
    });
    cx.st.invalidate_layout();
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_get_selected_index(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let i = forms::selected_index(cx.st, doc, id);
    cx.ret_i32(i);
    Ok(())
}

pub(crate) fn n_set_selected_index(cx: &mut Cx) -> NResult {
    let i = cx.num(1);
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let i = if i.is_finite() { i as i32 } else { -1 };
    forms::set_selected_index(cx.st, doc, id, i);
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_focus(cx: &mut Cx) -> NResult {
    let id = {
        let doc = cx.st.doc()?;
        let id = cx.node(doc, 0)?;
        crate::layout::ensure_layout(cx.st, doc);
        if !activation::is_focusable(doc, id) {
            cx.ret_undefined();
            return Ok(());
        }
        id
    };
    activation::change_focus(cx.scope, cx.st, Some(id));
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_blur(cx: &mut Cx) -> NResult {
    let is_focused = {
        let doc = cx.st.doc()?;
        let id = cx.node(doc, 0)?;
        activation::focused(doc) == Some(id)
    };
    if is_focused {
        activation::change_focus(cx.scope, cx.st, None);
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_active_element(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let f = activation::focused(doc);
    cx.ret_node(doc, f);
    Ok(())
}

pub(crate) fn n_run_default_action(cx: &mut Cx) -> NResult {
    let ty = cx.string(1)?;
    let id = {
        let doc = cx.st.doc()?;
        cx.node(doc, 0)?
    };
    let r = activation::run_default_action(cx.scope, cx.st, id, &ty);
    cx.ret_bool(r);
    Ok(())
}

/// Addition: legacy-pre-activation for a synthetic click (`el.click()`), so listeners
/// observe the toggled checkbox state. Returns a token for `activationEnd` (0 = the
/// click has no activation behavior or hits a disabled control).
pub(crate) fn n_activation_begin(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let target = cx.node(doc, 0)?;
    if activation::hits_disabled_control(doc, target) {
        cx.ret_i32(0);
        return Ok(());
    }
    let Some(at) = activation::activation_target(cx.st, doc, target) else {
        cx.ret_i32(0);
        return Ok(());
    };
    let pre = activation::pre_activate(cx.st, doc, at);
    let token = {
        let mut acts = cx.st.activations.borrow_mut();
        acts.1 += 1;
        let t = acts.1;
        acts.0.insert(t, (at, target, pre));
        t
    };
    cx.ret_f64(token as f64);
    Ok(())
}

/// Addition: finish a synthetic click started with `activationBegin(token)`. With
/// `canceled` the pre-activation is reverted; otherwise activation behavior runs.
pub(crate) fn n_activation_end(cx: &mut Cx) -> NResult {
    let token = cx.num(0);
    let canceled = cx.bool(1);
    let entry = if token >= 1.0 {
        cx.st.activations.borrow_mut().0.remove(&(token as u64))
    } else {
        None
    };
    let Some((at, target, pre)) = entry else {
        cx.ret_undefined();
        return Ok(());
    };
    if canceled {
        let doc = cx.st.doc()?;
        activation::cancel_activation(cx.st, doc, pre);
    } else {
        activation::run_activation(cx.scope, cx.st, at, target, pre, ClickInfo::default());
    }
    cx.ret_undefined();
    Ok(())
}

fn form_and_submitter(cx: &Cx) -> Result<(blitz_dom::NodeId, Option<blitz_dom::NodeId>), JsErr> {
    let doc = cx.st.doc()?;
    let form = cx.node(doc, 0)?;
    let submitter = cx.opt_node(doc, 1)?;
    Ok((form, submitter))
}

/// `form.submit()`: navigate with the form data, no events, no validation.
pub(crate) fn n_submit_form(cx: &mut Cx) -> NResult {
    let (form, submitter) = form_and_submitter(cx)?;
    activation::navigate_form(cx.st, form, submitter);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `form.requestSubmit(submitter)`: validation, `submit` event, navigation.
pub(crate) fn n_request_submit(cx: &mut Cx) -> NResult {
    let (form, submitter) = form_and_submitter(cx)?;
    activation::submit_with_events(cx.scope, cx.st, form, submitter);
    cx.ret_undefined();
    Ok(())
}

/// Addition: `form.reset()`: `reset` event, then reset controls.
pub(crate) fn n_reset_form(cx: &mut Cx) -> NResult {
    let form = {
        let doc = cx.st.doc()?;
        cx.node(doc, 0)?
    };
    activation::reset_with_events(cx.scope, cx.st, form);
    cx.ret_undefined();
    Ok(())
}
