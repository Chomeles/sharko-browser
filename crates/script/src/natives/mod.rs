//! The `__native` object: function table, installation and the call trampoline.

mod forms_natives;
mod misc;
mod tree;

use crate::cx::{Cx, JsErr, NResult};
use crate::state::RuntimeState;

pub(crate) use misc::{format_number, register_hooks};

type NativeImpl = fn(&mut Cx<'_, '_, '_>) -> NResult;

/// Common entry for every native: recovers the runtime state from the isolate data
/// slot, runs the implementation (catching panics as a last resort) and converts errors
/// into JS exceptions.
#[inline(always)]
fn dispatch<'s, 'i>(
    scope: &mut v8::PinScope<'s, 'i>,
    args: v8::FunctionCallbackArguments<'s>,
    rv: v8::ReturnValue<'s, v8::Value>,
    f: NativeImpl,
    name: &'static str,
) {
    let ptr = scope.get_data(crate::snapshot::STATE_SLOT) as *const RuntimeState;
    if ptr.is_null() {
        JsErr::dom("InvalidStateError", "the script runtime is gone").throw(scope);
        return;
    }
    // SAFETY: the slot is set to the runtime's `RuntimeState` when the isolate is
    // created; the state outlives the isolate (see `ScriptRuntime::drop`).
    let st: &RuntimeState = unsafe { &*ptr };
    if st.snapshotting.get()
        && st.snapshot_taint.get().is_none()
        && !crate::snapshot::SAFE_DURING_LOAD.contains(&name)
    {
        st.snapshot_taint.set(Some(name));
    }
    st.native_depth.set(st.native_depth.get() + 1);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut cx = Cx {
            scope: &mut *scope,
            args: &args,
            rv,
            st,
        };
        f(&mut cx)
    }));
    st.native_depth.set(st.native_depth.get() - 1);
    match result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => e.throw(scope),
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown panic".to_string());
            st.host.console(
                "error",
                &format!("internal error in native function: {msg}"),
            );
            JsErr::dom("InternalError", format!("native function panicked: {msg}")).throw(scope);
        }
    }
}

/// Create the `__native` object.
pub(crate) fn install<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    for &(name, cb) in callbacks() {
        let tmpl = v8::FunctionTemplate::builder_raw(cb)
            .constructor_behavior(v8::ConstructorBehavior::Throw)
            .build(scope);
        let key = crate::cx::v8_key(scope, name);
        tmpl.set_class_name(key);
        if let Some(func) = tmpl.get_function(scope) {
            obj.set(scope, key.into(), func.into());
        }
    }
    obj
}

macro_rules! natives_table {
    ($($name:literal => $f:path,)*) => {
        /// (name, raw V8 callback) of every native, in table order. The same pointers are
        /// used for the function templates and as the snapshot's external references.
        pub(crate) fn callbacks() -> &'static [(&'static str, v8::FunctionCallback)] {
            static TABLE: std::sync::OnceLock<Vec<(&'static str, v8::FunctionCallback)>> = std::sync::OnceLock::new();
            TABLE.get_or_init(|| vec![$(
                {
                    fn cb<'s, 'i>(
                        scope: &mut v8::PinScope<'s, 'i>,
                        args: v8::FunctionCallbackArguments<'s>,
                        rv: v8::ReturnValue<'s, v8::Value>,
                    ) {
                        dispatch(scope, args, rv, $f, $name);
                    }
                    ($name, v8::MapFnTo::<v8::FunctionCallback>::map_fn_to(cb))
                },
            )*])
        }
    };
}

natives_table! {
    // Tree / identity
    "documentId" => tree::n_document_id,
    "nodeType" => tree::n_node_type,
    "localName" => tree::n_local_name,
    "qualifiedName" => tree::n_qualified_name,
    "namespaceURI" => tree::n_namespace_uri,
    "parent" => tree::n_parent,
    "firstChild" => tree::n_first_child,
    "lastChild" => tree::n_last_child,
    "nextSibling" => tree::n_next_sibling,
    "prevSibling" => tree::n_prev_sibling,
    "childIds" => tree::n_child_ids,
    "childElementIds" => tree::n_child_element_ids,
    "isConnected" => tree::n_is_connected,
    "contains" => tree::n_contains,
    "compareDocumentPosition" => tree::n_compare_document_position,
    // Creation
    "createElement" => tree::n_create_element,
    "createText" => tree::n_create_text,
    "createComment" => tree::n_create_comment,
    "createFragment" => tree::n_create_fragment,
    "cloneNode" => tree::n_clone_node,
    "templateContent" => tree::n_template_content,
    "setShadowHost" => tree::n_set_shadow_host,
    "setDefined" => tree::n_set_defined,
    "releaseNode" => tree::n_release_node,
    // Mutation
    "appendChild" => tree::n_append_child,
    "insertBefore" => tree::n_insert_before,
    "removeChild" => tree::n_remove_child,
    "replaceChild" => tree::n_replace_child,
    // Attributes
    "getAttr" => tree::n_get_attr,
    "setAttr" => tree::n_set_attr,
    "removeAttr" => tree::n_remove_attr,
    "hasAttr" => tree::n_has_attr,
    "attrNames" => tree::n_attr_names,
    // Character data / content
    "getText" => tree::n_get_text,
    "setText" => tree::n_set_text,
    "textContent" => tree::n_text_content,
    "setTextContent" => tree::n_set_text_content,
    "innerHTML" => tree::n_inner_html,
    "setInnerHTML" => tree::n_set_inner_html,
    "outerHTML" => tree::n_outer_html,
    "parseHTMLFragment" => tree::n_parse_html_fragment,
    "parseHTMLDocument" => tree::n_parse_html_document,
    // Selectors
    "querySelector" => tree::n_query_selector,
    "querySelectorAll" => tree::n_query_selector_all,
    "matches" => tree::n_matches,
    "closest" => tree::n_closest,
    "getElementById" => tree::n_get_element_by_id,
    // Layout / geometry
    "getBoundingClientRect" => crate::layout::n_get_bounding_client_rect,
    "getClientRects" => crate::layout::n_get_client_rects,
    "offsetMetrics" => crate::layout::n_offset_metrics,
    "clientMetrics" => crate::layout::n_client_metrics,
    "scrollMetrics" => crate::layout::n_scroll_metrics,
    "setScroll" => crate::layout::n_set_scroll,
    "scrollIntoView" => crate::layout::n_scroll_into_view,
    "elementFromPoint" => crate::layout::n_element_from_point,
    "elementsFromPoint" => crate::layout::n_elements_from_point,
    "viewport" => crate::layout::n_viewport,
    "scrollTo" => crate::layout::n_scroll_to,
    "imageSize" => crate::layout::n_image_size,
    // Style
    "styleGet" => crate::style::n_style_get,
    "styleGetPriority" => crate::style::n_style_get_priority,
    "styleSet" => crate::style::n_style_set,
    "styleRemove" => crate::style::n_style_remove,
    "styleCssText" => crate::style::n_style_css_text,
    "styleSetCssText" => crate::style::n_style_set_css_text,
    "styleLength" => crate::style::n_style_length,
    "styleItem" => crate::style::n_style_item,
    "computedStyle" => crate::style::n_computed_style,
    "cssSupports" => crate::style::n_css_supports,
    "matchMedia" => crate::style::n_match_media,
    // Forms / focus / interaction
    "getValue" => forms_natives::n_get_value,
    "setValue" => forms_natives::n_set_value,
    "getChecked" => forms_natives::n_get_checked,
    "setChecked" => forms_natives::n_set_checked,
    "setIndeterminate" => forms_natives::n_set_indeterminate,
    "getSelectedIndex" => forms_natives::n_get_selected_index,
    "setSelectedIndex" => forms_natives::n_set_selected_index,
    "focus" => forms_natives::n_focus,
    "blur" => forms_natives::n_blur,
    "activeElement" => forms_natives::n_active_element,
    "runDefaultAction" => forms_natives::n_run_default_action,
    "activationBegin" => forms_natives::n_activation_begin,
    "activationEnd" => forms_natives::n_activation_end,
    "submitForm" => forms_natives::n_submit_form,
    "requestSubmit" => forms_natives::n_request_submit,
    "resetForm" => forms_natives::n_reset_form,
    // Scripts & modules
    "evalScript" => misc::n_eval_script,
    "runModule" => misc::n_run_module,
    "compileFunction" => misc::n_compile_function,
    // Networking
    "fetch" => misc::n_fetch,
    "fetchSync" => misc::n_fetch_sync,
    "abortFetch" => misc::n_abort_fetch,
    "wsOpen" => misc::n_ws_open,
    "wsSend" => misc::n_ws_send,
    "wsClose" => misc::n_ws_close,
    "registerBlobURL" => misc::n_register_blob_url,
    "revokeBlobURL" => misc::n_revoke_blob_url,
    "getCookie" => misc::n_get_cookie,
    "setCookie" => misc::n_set_cookie,
    // Storage
    "storageGet" => misc::n_storage_get,
    "storageSet" => misc::n_storage_set,
    "storageRemove" => misc::n_storage_remove,
    "storageClear" => misc::n_storage_clear,
    "storageKeys" => misc::n_storage_keys,
    // Timers / frames
    "setTimer" => misc::n_set_timer,
    "clearTimer" => misc::n_clear_timer,
    "requestFrame" => misc::n_request_frame,
    "now" => misc::n_now,
    "timeOrigin" => misc::n_time_origin,
    // Location / history / navigation
    "location" => misc::n_location,
    "navigate" => misc::n_navigate,
    "reload" => misc::n_reload,
    "historyPush" => misc::n_history_push,
    "historyGo" => misc::n_history_go,
    "historyIndex" => misc::n_history_index,
    "historyLength" => misc::n_history_length,
    "referrer" => misc::n_referrer,
    "doctype" => misc::n_doctype,
    "openWindow" => misc::n_open_window,
    "clipboardWrite" => misc::n_clipboard_write,
    "setTitle" => misc::n_set_title,
    // Misc
    "log" => misc::n_log,
    "urlParse" => misc::n_url_parse,
    "urlSet" => misc::n_url_set,
    "randomBytes" => misc::n_random_bytes,
    "textEncode" => misc::n_text_encode,
    "textDecode" => misc::n_text_decode,
    "userAgent" => misc::n_user_agent,
    "structuredClone" => misc::n_structured_clone,
    "pendingResourceCount" => misc::n_pending_resource_count,
    "setHooks" => misc::n_set_hooks,
}
