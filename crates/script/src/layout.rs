//! Layout-reading natives (geometry, scrolling, hit testing) and forced layout.

use std::hash::{Hash, Hasher};

use blitz_dom::{BaseDocument, NodeId, ScrollBehavior, ScrollLogicalPosition};

use crate::cx::{Cx, JsErr, NResult};
use crate::dom::{self, Kind};
use crate::state::{InternalTask, RuntimeState};

/// Make style and layout current if they may be stale. Cheap when nothing changed:
/// blitz's dirty/damage flags on the document node, the stylesheet set and the
/// viewport are checked before running an (incremental) `resolve`.
pub(crate) fn ensure_layout(st: &RuntimeState, doc: &mut BaseDocument) {
    if st.layout_clean.get() {
        return;
    }
    doc.handle_messages();
    let sig = layout_signature(doc);
    let root = doc.root_node();
    let dirty = root.has_dirty_descendants()
        || root.has_damaged_descendants()
        || sig != st.layout_sig.get();
    if dirty && doc.try_root_element().is_some() {
        doc.resolve(crate::animation_time());
    }
    st.layout_sig.set(layout_signature(doc));
    st.layout_clean.set(true);
}

fn layout_signature(doc: &BaseDocument) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for s in doc.author_stylesheets() {
        (&*s.0 as *const style::stylesheets::Stylesheet as usize).hash(&mut h);
    }
    doc.useragent_stylesheets().count().hash(&mut h);
    let vp = doc.viewport();
    vp.window_size.hash(&mut h);
    vp.scale().to_bits().hash(&mut h);
    (vp.color_scheme == blitz_traits::shell::ColorScheme::Dark).hash(&mut h);
    1u8.hash(&mut h);
    h.finish()
}

/// Does the element currently generate boxes?
fn has_boxes(doc: &BaseDocument, id: NodeId) -> bool {
    let Some(node) = doc.get_node(id) else {
        return false;
    };
    node.is_element() && node.primary_styles().is_some() && node.has_boxes()
}

fn root_element_id(doc: &BaseDocument) -> Option<NodeId> {
    doc.try_root_element().map(|n| n.id)
}

/// Viewport size in CSS px.
pub(crate) fn viewport_size(doc: &BaseDocument) -> (f64, f64) {
    let vp = doc.viewport();
    let scale = vp.scale_f64();
    if scale <= 0.0 {
        return (0.0, 0.0);
    }
    (
        vp.window_size.0 as f64 / scale,
        vp.window_size.1 as f64 / scale,
    )
}

/// Scrollable size of the document (scrollWidth/Height of the scrolling element).
fn document_scroll_size(doc: &BaseDocument) -> (f64, f64) {
    let (vw, vh) = viewport_size(doc);
    match doc.try_root_element() {
        Some(root) => {
            let l = root.final_layout();
            (
                vw.max(l.size.width.max(l.scrollable_overflow_rect.right) as f64),
                vh.max(l.size.height.max(l.scrollable_overflow_rect.bottom) as f64),
            )
        }
        None => (vw, vh),
    }
}

pub(crate) fn n_get_bounding_client_rect(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    ensure_layout(cx.st, doc);
    let r = if has_boxes(doc, id) {
        doc.get_client_bounding_rect(id)
    } else {
        None
    };
    let v = match r {
        Some(r) => [r.x, r.y, r.width, r.height],
        None => [0.0; 4],
    };
    cx.ret_f64s(&v);
    Ok(())
}

pub(crate) fn n_get_client_rects(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    ensure_layout(cx.st, doc);
    let mut out = Vec::new();
    if has_boxes(doc, id) {
        for r in doc.node_client_rects(id) {
            out.extend_from_slice(&[r.x, r.y, r.width, r.height]);
        }
    }
    cx.ret_f64s(&out);
    Ok(())
}

pub(crate) fn n_offset_metrics(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    ensure_layout(cx.st, doc);
    if !has_boxes(doc, id) {
        cx.ret_f64s(&[0.0; 5]);
        return Ok(());
    }
    let node = doc.get_node(id).unwrap();
    let is_root_or_body =
        root_element_id(doc) == Some(id) || dom::is_html(node, &blitz_dom::local_name!("body"));
    let fixed = node
        .primary_styles()
        .is_some_and(|s| s.clone_position() == style::computed_values::position::T::Fixed);
    let parent = if is_root_or_body || fixed {
        None
    } else {
        node.offset_parent()
            .and_then(|p| doc.nearest_non_anonymous_ancestor(p.id))
    };
    let (w, h, left, top) = match doc.inline_fragment_rects(id) {
        Some(rects) if !rects.is_empty() => {
            let bounds = doc.get_client_bounding_rect(id).unwrap();
            // Offsets of inline boxes: first fragment relative to the offset parent.
            let origin = parent
                .and_then(|p| doc.get_client_bounding_rect(p))
                .map(|r| (r.x, r.y))
                .unwrap_or((-doc.viewport_scroll().x, -doc.viewport_scroll().y));
            let border = parent
                .and_then(|p| doc.get_node(p))
                .map(|p| {
                    (
                        p.final_layout().border.left as f64,
                        p.final_layout().border.top as f64,
                    )
                })
                .unwrap_or((0.0, 0.0));
            (
                bounds.width,
                bounds.height,
                rects[0].x - origin.0 - border.0,
                rects[0].y - origin.1 - border.1,
            )
        }
        _ => {
            let pos = node.offset_top_left();
            let l = node.final_layout();
            (
                l.size.width as f64,
                l.size.height as f64,
                pos.x as f64,
                pos.y as f64,
            )
        }
    };
    if let Some(p) = parent {
        dom::expose(doc, p);
    }
    let pid = parent.and_then(crate::cx::node_id_to_js).unwrap_or(0.0);
    cx.ret_f64s(&[left.round(), top.round(), w.round(), h.round(), pid]);
    Ok(())
}

pub(crate) fn n_client_metrics(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    ensure_layout(cx.st, doc);
    if root_element_id(doc) == Some(id) {
        let (w, h) = viewport_size(doc);
        cx.ret_f64s(&[0.0, 0.0, w.floor(), h.floor()]);
        return Ok(());
    }
    if !has_boxes(doc, id) || doc.inline_fragment_rects(id).is_some() {
        cx.ret_f64s(&[0.0; 4]);
        return Ok(());
    }
    let node = doc.get_node(id).unwrap();
    let l = node.final_layout();
    cx.ret_f64s(&[
        l.border.left as f64,
        l.border.top as f64,
        node.client_width().max(0.0) as f64,
        node.client_height().max(0.0) as f64,
    ]);
    Ok(())
}

pub(crate) fn n_scroll_metrics(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    ensure_layout(cx.st, doc);
    let kind = dom::kind_of(cx.st, doc, id);
    if root_element_id(doc) == Some(id) || kind == Kind::Document {
        let s = doc.viewport_scroll();
        let (w, h) = document_scroll_size(doc);
        cx.ret_f64s(&[s.x, s.y, w.round(), h.round()]);
        return Ok(());
    }
    if !has_boxes(doc, id) {
        cx.ret_f64s(&[0.0; 4]);
        return Ok(());
    }
    let node = doc.get_node(id).unwrap();
    let s = node.scroll_offset();
    cx.ret_f64s(&[
        s.x,
        s.y,
        node.scroll_width().round() as f64,
        node.scroll_height().round() as f64,
    ]);
    Ok(())
}

fn finite_or(v: f64, fallback: f64) -> f64 {
    if v.is_finite() { v } else { fallback }
}

/// Scroll the viewport to (x, y); queues a `scroll` event if it moved.
fn scroll_viewport(st: &RuntimeState, doc: &mut BaseDocument, x: f64, y: f64) {
    let before = doc.viewport_scroll();
    let x = finite_or(x, before.x);
    let y = finite_or(y, before.y);
    match root_element_id(doc) {
        Some(root) => doc.scroll_to(root, x, y, ScrollBehavior::Instant),
        None => doc.set_viewport_scroll(blitz_dom::Point {
            x: x.max(0.0),
            y: y.max(0.0),
        }),
    }
    if doc.viewport_scroll() != before {
        st.queue_task(InternalTask::ViewportScroll);
        st.host.request_redraw();
    }
}

pub(crate) fn n_set_scroll(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let (x, y) = (cx.num(1), cx.num(2));
    ensure_layout(cx.st, doc);
    let kind = dom::kind_of(cx.st, doc, id);
    if root_element_id(doc) == Some(id) || kind == Kind::Document {
        scroll_viewport(cx.st, doc, x, y);
        return Ok(());
    }
    let Some(node) = doc.get_node(id) else {
        return Err(JsErr::invalid_node());
    };
    let before = *node.scroll_offset();
    doc.scroll_to(
        id,
        finite_or(x, before.x),
        finite_or(y, before.y),
        ScrollBehavior::Instant,
    );
    if doc
        .get_node(id)
        .is_some_and(|n| *n.scroll_offset() != before)
    {
        cx.st.queue_task(InternalTask::ElementScroll(id));
        cx.st.host.request_redraw();
    }
    Ok(())
}

pub(crate) fn n_scroll_into_view(cx: &mut Cx) -> NResult {
    // Read the (optional) `block` argument first: converting it may run user code, and
    // the document must not be borrowed across that.
    let block = if cx.len() > 1 {
        cx.with_str(1, |s| match s {
            "center" => ScrollLogicalPosition::Center,
            "end" => ScrollLogicalPosition::End,
            "nearest" => ScrollLogicalPosition::Nearest,
            _ => ScrollLogicalPosition::Start,
        })?
    } else {
        ScrollLogicalPosition::Start
    };
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    ensure_layout(cx.st, doc);
    if !has_boxes(doc, id) {
        return Ok(());
    }
    let before = doc.viewport_scroll();
    doc.scroll_into_view(
        id,
        ScrollBehavior::Instant,
        block,
        ScrollLogicalPosition::Nearest,
    );
    if doc.viewport_scroll() != before {
        cx.st.queue_task(InternalTask::ViewportScroll);
        cx.st.host.request_redraw();
    }
    Ok(())
}

/// Addition: `N.imageSize(id)` -> `[naturalWidth, naturalHeight]` of a decoded `<img>`
/// (raster or SVG), else `null`.
pub(crate) fn n_image_size(cx: &mut Cx) -> NResult {
    use blitz_dom::node::ImageData;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let size = doc
        .get_node(id)
        .and_then(|n| n.element_data())
        .and_then(|el| match el.image_data()? {
            ImageData::Raster(r) => Some((r.width as f64, r.height as f64)),
            ImageData::Svg(s) => {
                let size = s.tree.size();
                Some((size.width().round() as f64, size.height().round() as f64))
            }
            ImageData::None => None,
        });
    match size {
        Some((w, h)) => cx.ret_f64s(&[w, h]),
        None => cx.ret_null(),
    }
    Ok(())
}

/// Topmost element at viewport coordinates (x, y).
pub(crate) fn element_from_point(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    x: f64,
    y: f64,
) -> Option<NodeId> {
    ensure_layout(st, doc);
    let (vw, vh) = viewport_size(doc);
    if !(x >= 0.0 && y >= 0.0 && x <= vw && y <= vh) {
        return None;
    }
    let scroll = doc.viewport_scroll();
    let Some(hit) = doc.hit((x + scroll.x) as f32, (y + scroll.y) as f32) else {
        return root_element_id(doc);
    };
    let mut id = doc.nearest_non_anonymous_ancestor(hit.node_id)?;
    loop {
        let node = doc.get_node(id)?;
        if node.is_element() && dom::kind(st, node) == Kind::Element {
            return Some(id);
        }
        id = node.parent?;
    }
}

pub(crate) fn n_element_from_point(cx: &mut Cx) -> NResult {
    let (x, y) = (cx.num(0), cx.num(1));
    let doc = cx.st.doc()?;
    let id = element_from_point(cx.st, doc, x, y);
    cx.ret_node(doc, id);
    Ok(())
}

pub(crate) fn n_elements_from_point(cx: &mut Cx) -> NResult {
    let (x, y) = (cx.num(0), cx.num(1));
    let doc = cx.st.doc()?;
    let mut out = Vec::new();
    let mut cur = element_from_point(cx.st, doc, x, y);
    while let Some(id) = cur {
        out.push(id);
        cur = doc
            .get_node(id)
            .and_then(|n| n.parent)
            .filter(|&p| doc.get_node(p).is_some_and(|n| n.is_element()));
    }
    cx.ret_nodes(doc, &out);
    Ok(())
}

pub(crate) fn n_viewport(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let (w, h) = viewport_size(doc);
    let scale = doc.viewport().scale_f64();
    let s = doc.viewport_scroll();
    cx.ret_f64s(&[w, h, scale, s.x, s.y, w, h]);
    Ok(())
}

pub(crate) fn n_scroll_to(cx: &mut Cx) -> NResult {
    let (x, y) = (cx.num(0), cx.num(1));
    let doc = cx.st.doc()?;
    ensure_layout(cx.st, doc);
    scroll_viewport(cx.st, doc, x, y);
    Ok(())
}
