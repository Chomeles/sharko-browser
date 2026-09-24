//! Inline style (`element.style`), computed style, `CSS.supports` and `matchMedia`
//! natives, implemented with Stylo.

use blitz_dom::{BaseDocument, NodeId, QualName, local_name, ns};
use cssparser::{Parser, ParserInput};
use style::context::QuirksMode;
use style::media_queries::MediaList;
use style::parser::ParserContext;
use style::properties::{
    Importance, PropertyDeclaration, PropertyDeclarationBlock, PropertyDeclarationId, PropertyId,
    SourcePropertyDeclaration, SourcePropertyDeclarationUpdate,
};
use style::servo_arc::Arc as ServoArc;
use style::stylesheets::{CssRuleType, CustomMediaEvaluator, Origin, UrlExtraData};
use style_traits::ParsingMode;

use crate::cx::{Cx, JsErr, NResult};
use crate::dom::{self, Kind};
use crate::layout::ensure_layout;
use crate::state::RuntimeState;

fn url_data(doc: &BaseDocument) -> UrlExtraData {
    UrlExtraData(ServoArc::new(doc.url().clone()))
}

fn with_context<R>(
    doc: &BaseDocument,
    rule: CssRuleType,
    f: impl FnOnce(&ParserContext) -> R,
) -> R {
    let url = url_data(doc);
    let ctx = ParserContext::new(
        Origin::Author,
        &url,
        Some(rule),
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    );
    f(&ctx)
}

fn parse_property(doc: &BaseDocument, name: &str) -> Option<PropertyId> {
    with_context(doc, CssRuleType::Style, |ctx| {
        PropertyId::parse(name, ctx).ok()
    })
}

/// Parse `value` for `pid` into declarations; `None` if invalid.
fn parse_value(
    doc: &BaseDocument,
    pid: &PropertyId,
    value: &str,
) -> Option<SourcePropertyDeclaration> {
    with_context(doc, CssRuleType::Style, |ctx| {
        let mut decls = SourcePropertyDeclaration::default();
        let mut input = ParserInput::new(value);
        let mut parser = Parser::new(&mut input);
        match PropertyDeclaration::parse_into(&mut decls, pid.clone(), ctx, &mut parser) {
            Ok(()) if parser.is_exhausted() || parser.expect_exhausted().is_ok() => Some(decls),
            _ => None,
        }
    })
}

fn element_ok(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> Result<(), JsErr> {
    match dom::kind_of(st, doc, id) {
        Kind::Element => Ok(()),
        _ => Err(JsErr::type_err("not an element")),
    }
}

/// Read access to the element's inline declaration block.
fn with_block<R>(
    doc: &BaseDocument,
    id: NodeId,
    f: impl FnOnce(&PropertyDeclarationBlock) -> R,
) -> Option<R> {
    let el = doc.get_node(id)?.element_data()?;
    let block = el.style_attribute.as_ref()?;
    let guard = doc.guard().read();
    Some(f(block.read_with(&guard)))
}

/// Mutate the inline declaration block (creating it if needed), then write the
/// serialization back to the `style` attribute and invalidate style.
fn mutate_block(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    f: impl FnOnce(&mut PropertyDeclarationBlock) -> bool,
) {
    let guard = doc.guard().clone();
    let css = {
        let Some(el) = doc.get_node_mut(id).and_then(|n| n.element_data_mut()) else {
            return;
        };
        let block = el
            .style_attribute
            .get_or_insert_with(|| ServoArc::new(guard.wrap(PropertyDeclarationBlock::new())))
            .clone();
        let mut w = guard.write();
        let b = block.write_with(&mut w);
        if !f(b) {
            return;
        }
        let mut css = String::new();
        let _ = b.to_css(&mut css);
        css
    };
    let name = QualName::new(None, ns!(), local_name!("style"));
    dom::raw_set_attr(doc, id, name, &css);
    if let Some(node) = doc.get_node_mut(id) {
        node.set_restyle_hint(blitz_dom::RestyleHint::RESTYLE_STYLE_ATTRIBUTE);
        node.set_dirty_descendants();
    }
    st.invalidate_layout();
    st.host.request_redraw();
}

pub(crate) fn n_style_get(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let Some(pid) = parse_property(doc, &name) else {
        cx.ret_str("");
        return Ok(());
    };
    let v = with_block(doc, id, |b| {
        let mut s = String::new();
        let _ = b.property_value_to_css(&pid, &mut s);
        s
    })
    .unwrap_or_default();
    cx.ret_str(&v);
    Ok(())
}

pub(crate) fn n_style_get_priority(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let important = parse_property(doc, &name)
        .and_then(|pid| with_block(doc, id, |b| b.property_priority(&pid).important()))
        .unwrap_or(false);
    cx.ret_str(if important { "important" } else { "" });
    Ok(())
}

fn remove_property(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    pid: &PropertyId,
) -> String {
    let old = with_block(doc, id, |b| {
        let mut s = String::new();
        let _ = b.property_value_to_css(pid, &mut s);
        s
    })
    .unwrap_or_default();
    let present =
        with_block(doc, id, |b| b.first_declaration_to_remove(pid).is_some()).unwrap_or(false);
    if present {
        mutate_block(st, doc, id, |b| match b.first_declaration_to_remove(pid) {
            Some(i) => {
                b.remove_property(pid, i);
                true
            }
            None => false,
        });
    }
    old
}

pub(crate) fn n_style_set(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let value = cx.string(2)?;
    let priority = cx.opt_string(3)?.unwrap_or_default();
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let Some(pid) = parse_property(doc, &name) else {
        return Ok(());
    };
    if value.is_empty() {
        remove_property(cx.st, doc, id, &pid);
        return Ok(());
    }
    let importance = match priority.to_ascii_lowercase().as_str() {
        "" => Importance::Normal,
        "important" => Importance::Important,
        _ => return Ok(()),
    };
    let Some(mut decls) = parse_value(doc, &pid, &value) else {
        return Ok(());
    };
    mutate_block(cx.st, doc, id, |b| {
        let mut updates = SourcePropertyDeclarationUpdate::default();
        if !b.prepare_for_update(&decls, importance, &mut updates) {
            return false;
        }
        b.update(decls.drain(), importance, &mut updates);
        true
    });
    Ok(())
}

pub(crate) fn n_style_remove(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let old = match parse_property(doc, &name) {
        Some(pid) => remove_property(cx.st, doc, id, &pid),
        None => String::new(),
    };
    cx.ret_str(&old);
    Ok(())
}

pub(crate) fn n_style_css_text(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let css = with_block(doc, id, |b| {
        let mut s = String::new();
        let _ = b.to_css(&mut s);
        s
    })
    .unwrap_or_default();
    cx.ret_str(&css);
    Ok(())
}

pub(crate) fn n_style_set_css_text(cx: &mut Cx) -> NResult {
    let text = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    dom::set_attr(cx.st, doc, id, "style", &text)?;
    // Normalize the attribute to the serialization of the parsed block (CSSOM).
    let css = with_block(doc, id, |b| {
        let mut s = String::new();
        let _ = b.to_css(&mut s);
        s
    });
    if let Some(css) = css {
        dom::raw_set_attr(
            doc,
            id,
            QualName::new(None, ns!(), local_name!("style")),
            &css,
        );
    }
    Ok(())
}

pub(crate) fn n_style_length(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let n = with_block(doc, id, |b| b.declarations().len()).unwrap_or(0);
    cx.ret_f64(n as f64);
    Ok(())
}

pub(crate) fn n_style_item(cx: &mut Cx) -> NResult {
    let i = cx.num(1);
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    element_ok(cx.st, doc, id)?;
    let name = with_block(doc, id, |b| {
        if i >= 0.0 && (i as usize) < b.declarations().len() {
            b.declarations()[i as usize].id().name().into_owned()
        } else {
            String::new()
        }
    })
    .unwrap_or_default();
    cx.ret_str(&name);
    Ok(())
}

// ---------------------------------------------------------------------------------
// Computed style
// ---------------------------------------------------------------------------------

pub(crate) fn format_px(v: f64) -> String {
    format!(
        "{}px",
        crate::natives::format_number((v * 1000.0).round() / 1000.0)
    )
}

/// Resolved value of `name` for `id` (optionally a `::before`/`::after` pseudo).
pub(crate) fn computed_value(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    name: &str,
    pseudo: &str,
) -> String {
    if dom::kind_of(st, doc, id) != Kind::Element || !dom::is_connected(doc, id) {
        return String::new();
    }
    ensure_layout(st, doc);
    let target = match pseudo.trim_start_matches(':') {
        "" => Some(id),
        "before" => doc.get_node(id).and_then(|n| n.before()),
        "after" => doc.get_node(id).and_then(|n| n.after()),
        _ => None,
    };
    let Some(target) = target else {
        return String::new();
    };
    let Some(node) = doc.get_node(target) else {
        return String::new();
    };
    let pid = match PropertyId::parse_enabled_for_all_content(name) {
        Ok(p) => p,
        Err(()) => return String::new(),
    };
    let Some(styles) = node.primary_styles() else {
        // Not styled (e.g. inside a display:none subtree).
        if name == "display" && ancestor_display_none(doc, id) {
            return "none".to_string();
        }
        return String::new();
    };
    let cv: &style::properties::ComputedValues = &styles;

    // Layout-dependent resolved values (CSSOM "resolved value" special cases).
    if target == id
        && let Some(v) = used_value(doc, target, name, cv)
    {
        return v;
    }

    match pid.as_shorthand() {
        Err(decl_id) => match decl_id {
            PropertyDeclarationId::Longhand(_) | PropertyDeclarationId::Custom(_) => {
                cv.computed_value_to_string(decl_id)
            }
        },
        Ok(shorthand) => {
            let mut block = PropertyDeclarationBlock::new();
            for longhand in shorthand.longhands() {
                let mut ctx = style::values::resolved::Context {
                    style: cv,
                    for_property: pid.clone(),
                    current_longhand: None,
                };
                let decl = cv.computed_or_resolved_declaration(longhand, Some(&mut ctx));
                block.push(decl, Importance::Normal);
            }
            let mut s = String::new();
            let _ = block.shorthand_to_css(shorthand, &mut s);
            s
        }
    }
}

fn ancestor_display_none(doc: &BaseDocument, id: NodeId) -> bool {
    dom::inclusive_ancestors(doc, id).into_iter().any(|a| {
        doc.get_node(a)
            .and_then(|n| n.primary_styles())
            .is_some_and(|s| s.clone_display().is_none())
    })
}

/// Used values for box-model properties of elements with a box.
fn used_value(
    doc: &BaseDocument,
    id: NodeId,
    name: &str,
    cv: &style::properties::ComputedValues,
) -> Option<String> {
    let node = doc.get_node(id)?;
    let display = cv.clone_display();
    if display.is_none() || !node.has_boxes() {
        return None;
    }
    let inline = doc.inline_fragment_rects(id).is_some();
    let l = node.final_layout();
    let border_box = cv.clone_box_sizing() == style::computed_values::box_sizing::T::BorderBox;
    let v = match name {
        "width" | "inline-size" if !inline => {
            if border_box {
                l.size.width
            } else {
                l.size.width - l.padding.left - l.padding.right - l.border.left - l.border.right
            }
        }
        "height" | "block-size" if !inline => {
            if border_box {
                l.size.height
            } else {
                l.size.height - l.padding.top - l.padding.bottom - l.border.top - l.border.bottom
            }
        }
        "padding-top" => l.padding.top,
        "padding-right" => l.padding.right,
        "padding-bottom" => l.padding.bottom,
        "padding-left" => l.padding.left,
        "margin-top" if !inline => l.margin.top,
        "margin-right" if !inline => l.margin.right,
        "margin-bottom" if !inline => l.margin.bottom,
        "margin-left" if !inline => l.margin.left,
        _ => return None,
    };
    Some(format_px(v.max(if name.starts_with("margin") {
        f32::MIN
    } else {
        0.0
    }) as f64))
}

pub(crate) fn n_computed_style(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let pseudo = cx.opt_string(2)?.unwrap_or_default();
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let v = computed_value(cx.st, doc, id, &name, &pseudo);
    cx.ret_str(&v);
    Ok(())
}

// ---------------------------------------------------------------------------------
// CSS.supports / matchMedia
// ---------------------------------------------------------------------------------

pub(crate) fn supports(doc: &BaseDocument, prop: &str, value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            let Some(pid) = parse_property(doc, prop.trim()) else {
                return false;
            };
            parse_value(doc, &pid, value).is_some()
        }
        None => with_context(doc, CssRuleType::Style, |ctx| {
            let mut input = ParserInput::new(prop);
            let mut parser = Parser::new(&mut input);
            match parser
                .parse_entirely(style::stylesheets::supports_rule::parse_condition_or_declaration)
            {
                Ok(cond) => cond.eval(ctx),
                Err(_) => false,
            }
        }),
    }
}

pub(crate) fn n_css_supports(cx: &mut Cx) -> NResult {
    let prop = cx.string(0)?;
    let value = cx.opt_string(1)?;
    let doc = cx.st.doc()?;
    let r = supports(doc, &prop, value.as_deref());
    cx.ret_bool(r);
    Ok(())
}

/// Evaluate a media query list against the document's current device.
pub(crate) fn match_media(doc: &mut BaseDocument, query: &str) -> bool {
    let url = url_data(doc);
    let mut ctx = ParserContext::new(
        Origin::Author,
        &url,
        Some(CssRuleType::Media),
        ParsingMode::DEFAULT,
        QuirksMode::NoQuirks,
        Default::default(),
        None,
        None,
        Default::default(),
    );
    let mut input = ParserInput::new(query);
    let mut parser = Parser::new(&mut input);
    let list = MediaList::parse(&mut ctx, &mut parser);
    let device = doc.stylist_device();
    list.evaluate(
        device,
        QuirksMode::NoQuirks,
        &mut CustomMediaEvaluator::none(),
    )
}

pub(crate) fn n_match_media(cx: &mut Cx) -> NResult {
    let q = cx.string(0)?;
    let doc = cx.st.doc()?;
    let r = match_media(doc, &q);
    cx.ret_bool(r);
    Ok(())
}
