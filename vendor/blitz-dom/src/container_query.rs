//! PATCH 80 (container queries): CSS Conditional 5 / Containment 3 size container queries.
//!
//! Stylo evaluates `@container` conditions and `cq*` units through
//! `TElement::query_container_size`, which answers with the container's content-box size from
//! its last layout. Layout in turn depends on style, so, like Blink's "container query style
//! recalc during layout" and Gecko's post-reflow restyle, `resolve` runs style and layout in a
//! loop: after each layout every container whose size differs from the size style saw
//! (`Node::cq_used`) gets its descendants restyled, up to `MAX_PASSES` extra passes (nested
//! containers need one pass per level; a cycle stops there and keeps the last result).

use std::sync::atomic::{AtomicBool, Ordering};

use app_units::Au;
use euclid::default::Size2D;
use style::invalidation::element::restyle_hints::RestyleHint;
use style::values::computed::ContainerType;
use style::values::specified::Display;

use crate::node::Node;
use crate::BaseDocument;

/// Extra style+layout passes after the first one.
pub(crate) const MAX_PASSES: usize = 4;
pub(crate) const NEVER_QUERIED: u64 = u64::MAX;

/// Set once any element was queried as a container; documents without container queries
/// never pay for the scan after layout.
static ANY_QUERIED: AtomicBool = AtomicBool::new(false);

fn pack(w: Au, h: Au) -> u64 {
    ((w.0 as u32 as u64) << 32) | (h.0 as u32 as u64)
}

fn content_size(node: &Node) -> (Au, Au) {
    let l = node.final_layout();
    (
        Au::from_f32_px(l.content_box_width().max(0.0)),
        Au::from_f32_px(l.content_box_height().max(0.0)),
    )
}

pub(crate) fn query_size(node: &Node, display: &Display) -> Size2D<Option<Au>> {
    // Containers need a principal box, and inline-level boxes cannot establish size containment.
    if display.is_none() || display.is_contents() || display.is_inline_flow() {
        return Size2D::default();
    }
    let (w, h) = content_size(node);
    ANY_QUERIED.store(true, Ordering::Relaxed);
    node.cq_used.store(pack(w, h), Ordering::Relaxed);
    Size2D::new(Some(w), Some(h))
}

impl BaseDocument {
    /// Restyles the descendants of containers that were resized since style queried them.
    /// Returns whether anything was invalidated (style and layout must run again).
    pub(crate) fn invalidate_container_queries(&mut self, root: usize) -> bool {
        let _ = root;
        if !ANY_QUERIED.load(Ordering::Relaxed) {
            return false;
        }
        let mut stale = Vec::new();
        for (id, node) in self.nodes.iter() {
            let used = node.cq_used.load(Ordering::Relaxed);
            if used == NEVER_QUERIED || !node.is_element() {
                continue;
            }
            let is_container = node.primary_styles().is_some_and(|s| {
                s.get_box()
                    .clone_container_type()
                    .intersects(ContainerType::SIZE | ContainerType::INLINE_SIZE)
            });
            let (w, h) = content_size(node);
            let now = pack(w, h);
            if is_container && used != now {
                stale.push((id, now));
            } else if !is_container {
                node.cq_used.store(NEVER_QUERIED, Ordering::Relaxed);
            }
        }
        for &(id, now) in &stale {
            self.nodes[id].cq_used.store(now, Ordering::Relaxed);
            let children = self.nodes[id].children.clone();
            for child in children {
                if self.nodes[child].is_element() {
                    self.nodes[child]
                        .set_restyle_hint(RestyleHint::RESTYLE_SELF | RestyleHint::RESTYLE_DESCENDANTS);
                }
            }
        }
        !stale.is_empty()
    }
}
