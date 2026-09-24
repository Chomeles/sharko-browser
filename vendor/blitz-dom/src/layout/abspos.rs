//! PATCH: containing blocks of absolutely positioned and fixed boxes.
//!
//! Taffy lays out an out-of-flow child against its layout parent. In CSS the containing
//! block of a `position: absolute` box is the padding box of its nearest *positioned* (or
//! transformed) ancestor, and that of a `position: fixed` box is the viewport (unless an
//! ancestor has a transform). Pages rely on this everywhere: dropdowns, overlays, headers
//! (`left: 50%` inside static wrappers, a fixed masthead inside an offset container).
//!
//! After the regular layout pass, this pass re-resolves such boxes against their real
//! containing block, mirroring taffy's absolute layout (insets, percentage sizes, auto
//! margins), re-lays out their subtree and stores the position relative to the layout
//! parent. Axes whose insets are both `auto` keep taffy's static position.

use crate::BaseDocument;
use crate::node::NodeData;
use blitz_traits::node_id::NodeId;
use style::computed_values::position::T as Position;
use taffy::{
    AvailableSpace, BoxSizing, CoreStyle, Layout, LayoutInput, LayoutPartialTree, Line,
    MaybeMath, MaybeResolve, Point, Rect, RequestedAxis, ResolveOrZero, RunMode, Size,
    SizingMode,
};

fn child_input(
    run_mode: RunMode,
    known_dimensions: Size<Option<f32>>,
    parent_size: Size<Option<f32>>,
    available_space: Size<AvailableSpace>,
) -> LayoutInput {
    LayoutInput {
        run_mode,
        sizing_mode: SizingMode::ContentSize,
        axis: RequestedAxis::Both,
        known_dimensions,
        known_dimensions_are_definite: Size { width: true, height: true },
        parent_size,
        available_space,
        vertical_margins_are_collapsible: Line::FALSE,
    }
}

pub(crate) fn fixup_out_of_flow_boxes(doc: &mut BaseDocument, viewport: Size<f32>) {
    let Some(root) = doc.try_root_element().map(|n| n.id) else {
        return;
    };
    // Pre-order: containing blocks and parents are final before their descendants.
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if !is_boxed_element(doc, id) {
            continue;
        }
        fix_node(doc, id, viewport);
        let children = doc.nodes[id].layout_children.borrow().clone();
        if let Some(children) = children {
            stack.extend(children.iter().rev().copied());
        }
    }
}

fn is_boxed_element(doc: &BaseDocument, id: NodeId) -> bool {
    let node = &doc.nodes[id];
    matches!(node.data, NodeData::Element(_) | NodeData::AnonymousBlock(_))
        && !node
            .display_style()
            .is_some_and(|d| d.inside() == style::values::specified::box_::DisplayInside::None)
}

/// Whether `id` establishes the containing block for a box with position `pos`.
fn establishes_containing_block(doc: &BaseDocument, id: NodeId, pos: Position) -> bool {
    let Some(styles) = doc.nodes[id].primary_styles() else {
        return false;
    };
    let transformed = !styles.get_box().transform.0.is_empty();
    match pos {
        Position::Fixed => transformed,
        _ => transformed || styles.clone_position() != Position::Static,
    }
}

fn fix_node(doc: &mut BaseDocument, id: NodeId, viewport: Size<f32>) {
    let pos = match doc.nodes[id].primary_styles() {
        Some(s) => s.clone_position(),
        None => return,
    };
    if !matches!(pos, Position::Absolute | Position::Fixed) {
        return;
    }
    let Some(parent) = doc.nodes[id].layout_parent.get() else {
        return;
    };

    // The containing block (None = the viewport-sized initial containing block) and the
    // chain of layout ancestors from the parent up to it.
    let mut containing_block = None;
    let mut chain = Vec::new();
    let mut cur = Some(parent);
    while let Some(a) = cur {
        if !matches!(doc.nodes[a].data, NodeData::Element(_) | NodeData::AnonymousBlock(_)) {
            break;
        }
        if establishes_containing_block(doc, a, pos) {
            containing_block = Some(a);
            break;
        }
        chain.push(a);
        cur = doc.nodes[a].layout_parent.get();
    }
    if containing_block == Some(parent) {
        return;
    }

    // Position of the parent's border box relative to the containing block's border box
    // (or to the initial containing block).
    let mut offset = Point { x: 0.0f32, y: 0.0f32 };
    for &a in &chain {
        let l = doc.nodes[a].unrounded_layout();
        offset.x += l.location.x;
        offset.y += l.location.y;
    }

    // The containing block's padding box.
    let (area_offset, area_size) = match containing_block {
        Some(cb) => {
            let l = doc.nodes[cb].unrounded_layout();
            (
                Point { x: l.border.left, y: l.border.top },
                Size {
                    width: (l.size.width - l.border.left - l.border.right).max(0.0),
                    height: (l.size.height - l.border.top - l.border.bottom).max(0.0),
                },
            )
        }
        None => (Point { x: 0.0, y: 0.0 }, viewport),
    };

    let current = *doc.nodes[id].unrounded_layout();
    let static_position = Point {
        x: current.location.x + offset.x,
        y: current.location.y + offset.y,
    };

    let style = doc.nodes[id].style().clone();
    let calc = |val, basis| super::resolve_calc_value(val, basis);
    let area_width = area_size.width;
    let area_height = area_size.height;
    let aspect_ratio = style.aspect_ratio();
    let margin = style.margin().map(|m| m.resolve_to_option(area_width, calc));
    let padding = style.padding().resolve_or_zero(Some(area_width), calc);
    let border = style.border().resolve_or_zero(Some(area_width), calc);
    let padding_border_sum = (padding + border).sum_axes();
    let box_sizing_adjustment = if style.box_sizing() == BoxSizing::ContentBox {
        padding_border_sum
    } else {
        Size::ZERO
    };
    let inset = style.inset();
    let left = inset.left.maybe_resolve(area_width, calc);
    let right = inset.right.maybe_resolve(area_width, calc);
    let top = inset.top.maybe_resolve(area_height, calc);
    let bottom = inset.bottom.maybe_resolve(area_height, calc);

    let style_size = style
        .size()
        .maybe_resolve(area_size, calc)
        .maybe_apply_aspect_ratio(aspect_ratio)
        .maybe_add(box_sizing_adjustment);
    let min_size = style
        .min_size()
        .maybe_resolve(area_size, calc)
        .maybe_apply_aspect_ratio(aspect_ratio)
        .maybe_add(box_sizing_adjustment)
        .or(padding_border_sum.map(Some))
        .maybe_max(padding_border_sum);
    let max_size = style
        .max_size()
        .maybe_resolve(area_size, calc)
        .maybe_apply_aspect_ratio(aspect_ratio)
        .maybe_add(box_sizing_adjustment);
    let mut known = style_size.maybe_clamp(min_size, max_size);
    if let (None, Some(l), Some(r)) = (known.width, left, right) {
        let w = area_width.maybe_sub(margin.left).maybe_sub(margin.right) - l - r;
        known.width = Some(w.max(0.0));
        known = known.maybe_apply_aspect_ratio(aspect_ratio).maybe_clamp(min_size, max_size);
    }
    if let (None, Some(t), Some(b)) = (known.height, top, bottom) {
        let h = area_height.maybe_sub(margin.top).maybe_sub(margin.bottom) - t - b;
        known.height = Some(h.max(0.0));
        known = known.maybe_apply_aspect_ratio(aspect_ratio).maybe_clamp(min_size, max_size);
    }
    let available = Size {
        width: AvailableSpace::Definite(area_width.maybe_clamp(min_size.width, max_size.width)),
        height: AvailableSpace::Definite(area_height.maybe_clamp(min_size.height, max_size.height)),
    };
    let node_id = crate::taffy_node_id(id);
    let final_size = match (known.width, known.height) {
        (Some(width), Some(height)) => Size { width, height },
        _ => {
            let measured = doc
                .compute_child_layout(
                    node_id,
                    child_input(RunMode::ComputeSize, known, area_size.map(Some), available),
                )
                .size;
            known.unwrap_or(measured)
        }
    }
    .maybe_clamp(min_size, max_size);

    let output = doc.compute_child_layout(
        node_id,
        child_input(
            RunMode::PerformLayout,
            final_size.map(Some),
            area_size.map(Some),
            available,
        ),
    );

    // Auto margins (CSS2 §10.3.7 / §10.6.4), as taffy does for block containers.
    let non_auto = Rect {
        left: if left.is_some() { margin.left.unwrap_or(0.0) } else { 0.0 },
        right: if right.is_some() { margin.right.unwrap_or(0.0) } else { 0.0 },
        top: if top.is_some() { margin.top.unwrap_or(0.0) } else { 0.0 },
        bottom: if bottom.is_some() { margin.bottom.unwrap_or(0.0) } else { 0.0 },
    };
    let space = Point {
        x: right
            .map(|r| area_width - r - left.unwrap_or(0.0))
            .unwrap_or(final_size.width),
        y: bottom
            .map(|b| area_height - b - top.unwrap_or(0.0))
            .unwrap_or(final_size.height),
    };
    let free = Size {
        width: space.x - final_size.width - non_auto.left - non_auto.right,
        height: space.y - final_size.height - non_auto.top - non_auto.bottom,
    };
    let auto_margin = |a: Option<f32>, b: Option<f32>, free: f32| {
        let count = a.is_none() as u8 + b.is_none() as u8;
        if count == 2 && free <= 0.0 {
            0.0
        } else if count > 0 {
            free / count as f32
        } else {
            0.0
        }
    };
    let auto_w = auto_margin(margin.left, margin.right, free.width);
    let auto_h = auto_margin(margin.top, margin.bottom, free.height);
    let resolved_margin = Rect {
        left: margin.left.unwrap_or(auto_w),
        right: margin.right.unwrap_or(auto_w),
        top: margin.top.unwrap_or(auto_h),
        bottom: margin.bottom.unwrap_or(auto_h),
    };

    let x_in_cb = match (left, right) {
        (Some(l), _) => area_offset.x + l + resolved_margin.left,
        (None, Some(r)) => {
            area_offset.x + area_width - final_size.width - r - resolved_margin.right
        }
        (None, None) => static_position.x,
    };
    let y_in_cb = match (top, bottom) {
        (Some(t), _) => area_offset.y + t + resolved_margin.top,
        (None, Some(b)) => {
            area_offset.y + area_height - final_size.height - b - resolved_margin.bottom
        }
        (None, None) => static_position.y,
    };

    doc.set_unrounded_layout(
        node_id,
        &Layout {
            order: current.order,
            location: Point {
                x: x_in_cb - offset.x,
                y: y_in_cb - offset.y,
            },
            size: final_size,
            scrollable_overflow_rect: output.scrollable_overflow_rect,
            scrollbar_size: current.scrollbar_size,
            padding,
            border,
            margin: resolved_margin,
        },
    );
}
