//! PATCH: self-checks for the incremental layout passes (style flush, out-of-flow fixup,
//! rounding), enabled with the `BLITZ_VERIFY_INCREMENTAL` environment variable. Each check
//! redoes a pass over the whole tree and reports nodes whose result differs from the
//! incremental one.

use crate::BaseDocument;
use crate::node::NodeData;
use blitz_traits::node_id::NodeId;

pub(crate) fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("BLITZ_VERIFY_INCREMENTAL").is_some())
}

fn describe(doc: &BaseDocument, id: NodeId) -> String {
    doc.nodes[id]
        .element_data()
        .map(|e| {
            let class = e.attr(markup5ever::local_name!("class")).unwrap_or("");
            format!("{id:?} <{}> .{class}", e.name.local)
        })
        .unwrap_or_else(|| format!("{id:?} (anonymous)"))
}

fn layout_tree(doc: &BaseDocument, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        out.push(id);
        if let Some(children) = doc.nodes[id].layout_children.borrow().as_ref() {
            stack.extend(children.iter().copied());
        }
    }
    out
}

fn has_layout(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(doc.nodes[id].data, NodeData::Element(_) | NodeData::AnonymousBlock(_))
}

/// Every box in the layout tree carries the taffy style of its current computed style.
pub(crate) fn flushed_styles(doc: &BaseDocument, root: NodeId) {
    let mut bad = 0;
    for id in layout_tree(doc, root) {
        let node = &doc.nodes[id];
        let Some(style) = node.primary_styles() else {
            continue;
        };
        let mut expected = stylo_taffy::to_taffy_style(&style);
        use style::computed_values::position::T as Position;
        if matches!(style.clone_position(), Position::Static | Position::Sticky) {
            expected.inset = taffy::Rect {
                left: taffy::LengthPercentageAuto::auto(),
                right: taffy::LengthPercentageAuto::auto(),
                top: taffy::LengthPercentageAuto::auto(),
                bottom: taffy::LengthPercentageAuto::auto(),
            };
        }
        expected.item_is_replaced = node.style().item_is_replaced;
        if *node.style() != expected {
            bad += 1;
            if bad <= 3 {
                eprintln!("[verify] flush: stale taffy style on {}", describe(doc, id));
            }
        }
    }
    if bad > 0 {
        eprintln!("[verify] flush: {bad} stale taffy styles");
    }
}

/// A full out-of-flow pass changes nothing after the incremental one.
pub(crate) fn out_of_flow(doc: &mut BaseDocument, viewport: taffy::Size<f32>) {
    let snapshot: Vec<(NodeId, taffy::Layout)> = doc
        .nodes
        .iter()
        .filter(|(id, _)| has_layout(doc, *id))
        .map(|(id, n)| (id, *n.unrounded_layout()))
        .collect();
    doc.abspos_viewport = None;
    super::abspos::fixup_out_of_flow_boxes(doc, viewport);
    for (id, layout) in snapshot {
        if *doc.nodes[id].unrounded_layout() != layout {
            eprintln!("[verify] abspos: {} moved on a full pass", describe(doc, id));
        }
    }
}

/// A full rounding pass gives the same final layouts as the incremental one.
pub(crate) fn rounding(doc: &mut BaseDocument, root: taffy::NodeId) {
    let incremental: Vec<(NodeId, taffy::Layout)> = doc
        .nodes
        .iter()
        .filter(|(id, _)| has_layout(doc, *id))
        .map(|(id, n)| (id, *n.final_layout()))
        .collect();
    taffy::round_layout(doc, root);
    let mut bad = 0;
    for (id, layout) in incremental {
        if *doc.nodes[id].final_layout() != layout {
            bad += 1;
            if bad <= 3 {
                eprintln!("[verify] rounding: stale final layout on {}", describe(doc, id));
            }
        }
    }
    if bad > 0 {
        eprintln!("[verify] rounding: {bad} stale final layouts");
    }
}
