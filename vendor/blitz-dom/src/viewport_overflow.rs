//! PATCH: overflow propagation to the viewport (CSS Overflow 3 §3.3).
//!
//! The viewport takes its `overflow` from the root element or, when the root is an `<html>`
//! element with `overflow: visible` in both axes, from its first `<body>` child. The element
//! the values come from has a *used* `overflow` of `visible`: it is not a scroll container, it
//! does not clip, and it has no scrollbars of its own; the viewport does all of that.

use blitz_traits::node_id::NodeId;
use style::values::computed::Overflow;
use style::values::specified::box_::{Contain, Display};

use crate::layout::damage::ONLY_RELAYOUT;
use crate::node::NodeFlags;
use crate::util::Point;
use crate::{BaseDocument, Node, local_name, ns};

/// The `overflow` values which apply to the viewport. `visible` counts as `auto` and `clip` as
/// `hidden` there, so only `hidden`, `scroll` and `auto` occur.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ViewportOverflow {
    pub x: Overflow,
    pub y: Overflow,
}

impl ViewportOverflow {
    pub(crate) const INITIAL: Self = Self {
        x: Overflow::Auto,
        y: Overflow::Auto,
    };

    /// Whether the user can scroll the viewport along each axis. A `hidden` viewport still
    /// scrolls programmatically (`scrollTo`, `scrollIntoView`, focus).
    pub fn user_scrollable(&self) -> (bool, bool) {
        let scrolls = |overflow| matches!(overflow, Overflow::Scroll | Overflow::Auto);
        (scrolls(self.x), scrolls(self.y))
    }
}

impl BaseDocument {
    /// The element whose `overflow` the viewport uses, if the root element or its `<body>`
    /// sets one (as of the last [`resolve`](BaseDocument::resolve)).
    pub fn viewport_overflow_source(&self) -> Option<NodeId> {
        self.viewport_overflow_source
    }

    /// The `overflow` values which apply to the viewport (as of the last
    /// [`resolve`](BaseDocument::resolve)).
    pub fn viewport_overflow(&self) -> ViewportOverflow {
        self.viewport_overflow
    }

    /// The element which supplies the viewport's `overflow`, with the values, from the
    /// current styles.
    fn find_viewport_overflow_source(&self) -> Option<(NodeId, ViewportOverflow)> {
        let root = self.try_root_element()?;
        let (display, contain, x, y) = {
            let style = root.primary_styles()?;
            (
                style.clone_display(),
                style.clone_contain(),
                style.clone_overflow_x(),
                style.clone_overflow_y(),
            )
        };
        if display == Display::None {
            return None;
        }
        let propagated = |x: Overflow, y: Overflow| ViewportOverflow {
            x: x.to_scrollable(),
            y: y.to_scrollable(),
        };
        if (x, y) != (Overflow::Visible, Overflow::Visible) {
            return Some((root.id, propagated(x, y)));
        }

        // Only an HTML document's `<body>` takes part, and containment on either element
        // stops the propagation (as in Blink and Gecko).
        let is_html_element = |node: &Node, name| {
            node.data
                .downcast_element()
                .is_some_and(|el| el.name.ns == ns!(html) && el.name.local == name)
        };
        if contain != Contain::NONE || !is_html_element(root, local_name!("html")) {
            return None;
        }
        let body = root
            .children
            .iter()
            .filter_map(|&id| self.nodes.get(id))
            .find(|child| is_html_element(child, local_name!("body")))?;
        let style = body.primary_styles()?;
        // A body without a box has nothing to propagate.
        if matches!(style.clone_display(), Display::None | Display::Contents)
            || style.clone_contain() != Contain::NONE
        {
            return None;
        }
        let (x, y) = (style.clone_overflow_x(), style.clone_overflow_y());
        if (x, y) == (Overflow::Visible, Overflow::Visible) {
            return None;
        }
        Some((body.id, propagated(x, y)))
    }

    /// Re-resolve the propagation of `overflow` to the viewport from the current styles. Runs
    /// after style resolution and before damage propagation: when the source element changes
    /// (a scroll lock toggling `overflow` on `<html>` while `<body>` has its own, say), the
    /// styles of both elements are flushed to layout again.
    pub(crate) fn update_viewport_overflow(&mut self) {
        let (source, overflow) = match self.find_viewport_overflow_source() {
            Some((id, overflow)) => (Some(id), overflow),
            None => (None, ViewportOverflow::INITIAL),
        };
        self.viewport_overflow = overflow;
        if source == self.viewport_overflow_source {
            return;
        }
        for (id, propagated) in [(self.viewport_overflow_source, false), (source, true)] {
            let Some(node) = id.and_then(|id| self.nodes.get_mut(id)) else {
                continue;
            };
            node.flags
                .set(NodeFlags::OVERFLOW_PROPAGATED_TO_VIEWPORT, propagated);
            if propagated {
                // A box that stops being a scroll container has nothing to be scrolled by.
                *node.scroll_offset_mut() = Point::ZERO;
            }
            node.insert_damage(ONLY_RELAYOUT);
        }
        self.viewport_overflow_source = source;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Attribute, DocumentConfig, qual_name};
    use blitz_traits::shell::{ColorScheme, Viewport};

    struct Page {
        doc: BaseDocument,
        html: NodeId,
        body: NodeId,
        tall: NodeId,
    }

    /// `<html style=html_style><body style="margin:0;height:100%;<body_style>">` around a 1000px
    /// tall block, in a 400x300 viewport (the HTML parser lives in blitz-html, which would be a
    /// circular dev-dependency).
    fn page(html_style: &str, body_style: &str) -> Page {
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(400, 300, 1.0, ColorScheme::Light)),
            ..Default::default()
        });
        let root_id = doc.root_node().id;
        let style = |value: String| Attribute {
            name: qual_name!("style"),
            value,
        };

        let mut mutator = doc.mutate();
        let html = mutator.create_element(
            qual_name!("html", html),
            vec![style(format!("height:100%;{html_style}"))],
        );
        let body = mutator.create_element(
            qual_name!("body", html),
            vec![style(format!("margin:0;height:100%;{body_style}"))],
        );
        let tall =
            mutator.create_element(qual_name!("div", html), vec![style("height:1000px".into())]);
        mutator.append_children(body, &[tall]);
        mutator.append_children(html, &[body]);
        mutator.append_children(root_id, &[html]);
        drop(mutator);

        doc.resolve(0.0);
        Page {
            doc,
            html,
            body,
            tall,
        }
    }

    fn set_style(page: &mut Page, node: NodeId, value: &str) {
        page.doc
            .mutate()
            .set_attribute(node, qual_name!("style"), value);
        page.doc.resolve(0.0);
    }

    /// Scroll as the wheel does over the tall block (positive: further down).
    fn wheel(page: &mut Page, dy: f64) -> bool {
        let tall = page.tall;
        page.doc.scroll_node_by_has_changed(tall, 0.0, -dy, |_| {})
    }

    fn scroll_y(page: &Page) -> f64 {
        page.doc.viewport_scroll().y
    }

    #[test]
    fn body_overflow_scrolls_the_viewport() {
        for overflow in ["overflow:auto", "overflow:scroll", "overflow-y:scroll"] {
            let mut p = page("", overflow);
            assert_eq!(p.doc.viewport_overflow_source(), Some(p.body), "{overflow}");
            assert_eq!(p.doc.viewport_overflow().user_scrollable(), (true, true));

            // The overflow of the body is the overflow of the document: <html> is 300px tall
            // and its content 1000px.
            assert_eq!(p.doc.nodes[p.html].scroll_height(), 1000.0, "{overflow}");
            assert_eq!(
                p.doc.nodes[p.body].final_layout().size.height,
                300.0,
                "{overflow}"
            );

            // The wheel scrolls the viewport up to the end of the content, never the body.
            assert!(wheel(&mut p, 500.0), "{overflow}");
            assert_eq!(scroll_y(&p), 500.0, "{overflow}");
            assert!(wheel(&mut p, 1e6), "{overflow}");
            assert_eq!(scroll_y(&p), 700.0, "{overflow}");
            assert_eq!(
                *p.doc.nodes[p.body].scroll_offset(),
                Point::ZERO,
                "{overflow}"
            );
        }
    }

    #[test]
    fn body_scroll_lock_blocks_the_user_but_not_scripts() {
        let mut p = page("", "overflow:hidden");
        assert_eq!(p.doc.viewport_overflow_source(), Some(p.body));
        assert_eq!(p.doc.viewport_overflow().user_scrollable(), (false, false));
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 1000.0);

        assert!(!wheel(&mut p, 200.0));
        assert!(!p.doc.scroll_viewport_by_has_changed(0.0, -200.0));
        assert_eq!(scroll_y(&p), 0.0);

        let html = p.html;
        p.doc
            .scroll_to(html, 0.0, 400.0, crate::ScrollBehavior::Instant);
        assert_eq!(scroll_y(&p), 400.0);
        // A lock which is set while the page is scrolled keeps the position.
        assert!(!wheel(&mut p, -100.0));
        assert_eq!(scroll_y(&p), 400.0);
        // The body itself is not scrolled by scripts (`body.scrollTop` stays 0).
        let body = p.body;
        p.doc
            .scroll_to(body, 0.0, 100.0, crate::ScrollBehavior::Instant);
        assert_eq!(*p.doc.nodes[p.body].scroll_offset(), Point::ZERO);
    }

    #[test]
    fn root_overflow_hidden_blocks_the_user() {
        let mut p = page("overflow:hidden", "");
        assert_eq!(p.doc.viewport_overflow_source(), Some(p.html));
        assert_eq!(p.doc.viewport_overflow().user_scrollable(), (false, false));
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 1000.0);
        assert!(!wheel(&mut p, 200.0));
        assert_eq!(scroll_y(&p), 0.0);
        let html = p.html;
        p.doc
            .scroll_to(html, 0.0, 200.0, crate::ScrollBehavior::Instant);
        assert_eq!(scroll_y(&p), 200.0);

        // Only one axis hidden: the viewport still scrolls along the other.
        let mut p = page("overflow-x:hidden", "");
        assert_eq!(p.doc.viewport_overflow().user_scrollable(), (false, true));
        assert!(wheel(&mut p, 200.0));
        assert_eq!(scroll_y(&p), 200.0);
    }

    #[test]
    fn root_overflow_wins_over_the_body() {
        // The body then keeps its own overflow: it is a scroll container.
        let mut p = page("overflow:hidden", "overflow:auto");
        assert_eq!(p.doc.viewport_overflow_source(), Some(p.html));
        assert!(wheel(&mut p, 200.0));
        assert_eq!(scroll_y(&p), 0.0);
        assert_eq!(p.doc.nodes[p.body].scroll_offset().y, 200.0);
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 300.0);
    }

    #[test]
    fn visible_overflow_propagates_nothing() {
        let mut p = page("", "");
        assert_eq!(p.doc.viewport_overflow_source(), None);
        assert_eq!(p.doc.viewport_overflow(), ViewportOverflow::INITIAL);
        assert!(wheel(&mut p, 200.0));
        assert_eq!(scroll_y(&p), 200.0);

        // Containment on the body (or the root) keeps its overflow to itself.
        let mut p = page("", "overflow:auto;contain:paint");
        assert_eq!(p.doc.viewport_overflow_source(), None);
        assert!(wheel(&mut p, 200.0));
        assert_eq!(scroll_y(&p), 0.0);
        assert_eq!(p.doc.nodes[p.body].scroll_offset().y, 200.0);
        // `display: none` has no box to take the overflow from.
        let p = page("", "overflow:hidden;display:none");
        assert_eq!(p.doc.viewport_overflow_source(), None);
    }

    #[test]
    fn a_change_of_the_source_is_laid_out_again() {
        let mut p = page("", "overflow:auto");
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 1000.0);
        assert!(wheel(&mut p, 200.0));
        assert_eq!(scroll_y(&p), 200.0);

        // A scroll lock on <html> takes the viewport's overflow: the body becomes a scroll
        // container of its own (and starts scrolled to the top).
        let html = p.html;
        set_style(&mut p, html, "height:100%;overflow:hidden");
        assert_eq!(p.doc.viewport_overflow_source(), Some(html));
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 300.0);
        assert!(wheel(&mut p, 100.0));
        assert_eq!(p.doc.nodes[p.body].scroll_offset().y, 100.0);
        assert_eq!(scroll_y(&p), 200.0);

        // ... and back: the body is no scroll container again.
        set_style(&mut p, html, "height:100%");
        assert_eq!(p.doc.viewport_overflow_source(), Some(p.body));
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 1000.0);
        assert_eq!(*p.doc.nodes[p.body].scroll_offset(), Point::ZERO);
        assert!(wheel(&mut p, 100.0));
        assert_eq!(scroll_y(&p), 300.0);

        // The body's own value changes: the viewport follows.
        let body = p.body;
        set_style(&mut p, body, "margin:0;height:100%;overflow:hidden");
        assert_eq!(p.doc.viewport_overflow().user_scrollable(), (false, false));
        assert!(!wheel(&mut p, 100.0));
        set_style(&mut p, body, "margin:0;height:100%");
        assert_eq!(p.doc.viewport_overflow_source(), None);
        assert_eq!(p.doc.viewport_overflow().user_scrollable(), (true, true));
        assert_eq!(p.doc.nodes[p.html].scroll_height(), 1000.0);
    }
}
