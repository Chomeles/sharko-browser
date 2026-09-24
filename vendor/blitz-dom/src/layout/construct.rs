use blitz_traits::node_id::NodeId;
use core::str;
use std::sync::Arc;

use markup5ever::{QualName, local_name, ns};
use parley::{
    FontContext, InlineBox, InlineBoxKind, LayoutContext, StyleProperty, TreeBuilder,
    WhiteSpaceCollapse,
};
use style::{
    computed_values::position::T as PositionProperty,
    data::ElementData as StyloElementData,
    shared_lock::StylesheetGuards,
    values::{
        computed::{Content, ContentItem, Display, Float, TextTransform},
        specified::box_::{DisplayInside, DisplayOutside},
    },
};
use thin_vec::ThinVec;

use crate::{
    BaseDocument, ElementData, Node, NodeData,
    layout::damage::{CONSTRUCT_BOX, CONSTRUCT_DESCENDENT, CONSTRUCT_FC},
    node::{
        ListItemLayout, ListItemLayoutPosition, Marker, NodeFlags, NodeKind, SpecialElementData,
        TextBrush, TextInputData, TextLayout,
    },
    qual_name, stylo_to_parley,
    traversal::{iter_children, iter_children_and_pseudos},
};

use super::{
    damage::ALL_DAMAGE,
    list::{BULLET_FONT_FAMILY, collect_list_item_children},
    replaced::is_replaced_element,
    table::build_table_context,
};

const DUMMY_NAME: QualName = qual_name!("div", html);

#[derive(Clone)]
pub(crate) struct ConstructionTask {
    pub(crate) node_id: NodeId,
    pub(crate) data: ConstructionTaskData,
}

pub(crate) struct ConstructionTaskResult {
    pub(crate) node_id: NodeId,
    pub(crate) data: ConstructionTaskResultData,
}

#[derive(Clone)]
pub(crate) enum ConstructionTaskData {
    InlineLayout(Box<TextLayout>),
}

pub(crate) enum ConstructionTaskResultData {
    InlineLayout(Box<TextLayout>),
}

/// Accumulator threaded through layout-child collection.
///
/// `children` is the list of layout children being built up, and
/// `anonymous_block_id` is the currently-open anonymous block container (if
/// any) that wrapping children are being appended to.
#[derive(Default)]
pub(crate) struct LayoutChildren {
    pub(crate) children: ThinVec<NodeId>,
    pub(crate) anonymous_block_id: Option<NodeId>,
    /// All anonymous blocks created while collecting these layout children.
    ///
    /// These are recorded on the container node so they can be deallocated the
    /// next time it is reconstructed.
    pub(crate) anonymous_blocks: ThinVec<NodeId>,
}

impl LayoutChildren {
    /// Append a single layout child.
    fn push(&mut self, child_id: NodeId, doc: &mut BaseDocument) {
        self.maybe_push_anon_block(doc);
        self.children.push(child_id);
    }

    /// Append all layout children in `slice`.
    fn extend(&mut self, slice: &[NodeId], doc: &mut BaseDocument) {
        self.maybe_push_anon_block(doc);
        self.children.extend_from_slice(slice);
    }

    fn maybe_push_anon_block(&mut self, doc: &mut BaseDocument) {
        fn block_is_only_whitespace(doc: &BaseDocument, node_id: NodeId) -> bool {
            for child_id in doc.nodes[node_id].children.iter().copied() {
                let child = &doc.nodes[child_id];
                if !child.is_whitespace_node() {
                    return false;
                }
            }

            true
        }

        // If anonymous block node only contains whitespace then delete it
        if let Some(anon_id) = self.anonymous_block_id {
            if block_is_only_whitespace(doc, anon_id) {
                // Remove by identity, not pop(): hoisted display:contents
                // children may have been pushed after the anon block.
                if let Some(pos) = self.children.iter().rposition(|id| *id == anon_id) {
                    self.children.remove(pos);
                }
                self.anonymous_blocks.retain(|id| *id != anon_id);
                doc.remove_node_from_tree(anon_id);
            }
        }

        self.anonymous_block_id = None;
    }

    fn push_wrapped(
        &mut self,
        container_node_id: NodeId,
        child_id: NodeId,
        doc: &mut BaseDocument,
    ) {
        if self.anonymous_block_id.is_none() {
            self.create_anonymous_block(container_node_id, doc);
        }
        doc.nodes[self.anonymous_block_id.unwrap()]
            .children
            .push(child_id);
    }

    fn create_anonymous_block(&mut self, container_node_id: NodeId, doc: &mut BaseDocument) {
        use style::selector_parser::PseudoElement;

        const NAME: QualName = QualName {
            prefix: None,
            ns: ns!(html),
            local: local_name!("div"),
        };
        let node_id = doc.create_node(NodeData::AnonymousBlock(Box::new(ElementData::new(
            NAME,
            Vec::new(),
        ))));

        // Set style data
        let parent_style = doc.nodes[container_node_id].primary_styles().unwrap();
        let read_guard = doc.guard.read();
        let guards = StylesheetGuards::same(&read_guard);
        let style = doc.stylist.style_for_anonymous::<&Node>(
            &guards,
            &PseudoElement::ServoAnonymousBox,
            &parent_style,
        );
        let mut stylo_element_data = StyloElementData {
            damage: ALL_DAMAGE,
            ..Default::default()
        };
        drop(parent_style);

        stylo_element_data.styles.primary = Some(style);
        stylo_element_data.set_restyled();

        *doc.nodes[node_id]
            .stylo_element_data_mut()
            .ensure_init_mut() = stylo_element_data;

        if doc.nodes[container_node_id]
            .flags
            .contains(NodeFlags::IS_IN_DOCUMENT)
        {
            doc.nodes[node_id].flags.insert(NodeFlags::IS_IN_DOCUMENT);
        }
        doc.nodes[node_id].parent = Some(container_node_id);
        doc.nodes[node_id]
            .layout_parent
            .set(Some(container_node_id));

        self.children.push(node_id);
        self.anonymous_block_id = Some(node_id);
        self.anonymous_blocks.push(node_id);
    }
}

fn push_children_and_pseudos(layout_children: &mut ThinVec<NodeId>, node: &Node) {
    if let Some(before) = node.before() {
        layout_children.push(before);
    }
    layout_children.extend(node.children.iter().copied().filter(|child_id| {
        let child_node = node.with(*child_id);
        child_node.data.kind() != NodeKind::Comment
    }));
    if let Some(after) = node.after() {
        layout_children.push(after);
    }
}

/// Wrapping policy of the nearest non-contents ancestor container. Children
/// hoisted out of display:contents nodes must be wrapped in anonymous blocks
/// exactly as if they were direct children of that container: without this,
/// a bare text node could end up as the layout child of a block/flex/grid
/// container, which cannot be laid out (text nodes carry no style).
#[derive(Copy, Clone)]
struct WrapContext {
    /// The container whose style anonymous blocks inherit from.
    container_node_id: NodeId,
    needs_wrap: fn(NodeKind, DisplayOutside) -> bool,
}

fn block_item_needs_wrap(child_node_kind: NodeKind, display_outside: DisplayOutside) -> bool {
    child_node_kind == NodeKind::Text || display_outside == DisplayOutside::Inline
}

/// Used for flex/grid containers, and for flow containers whose in-flow
/// children are all out-of-flow (where inline elements are pushed raw, but
/// bare text still cannot be laid out directly).
fn text_item_needs_wrap(child_node_kind: NodeKind, _display_outside: DisplayOutside) -> bool {
    child_node_kind == NodeKind::Text
}

/// Push a single hoisted child, recursing through display:contents nodes and
/// wrapping text/inline children per the ancestor container's `WrapContext`.
fn push_hoisted_child(
    doc: &mut BaseDocument,
    child_id: NodeId,
    out: &mut LayoutChildren,
    wrap: Option<WrapContext>,
) {
    let child = &doc.nodes[child_id];
    let child_display = child.display_style().unwrap_or(Display::inline());
    if matches!(child_display.inside(), DisplayInside::Contents) {
        collect_layout_children_with_wrap(doc, child_id, out, wrap);
        return;
    }
    if let Some(wrap_ctx) = wrap {
        let child_node_kind = child.data.kind();
        let display_outside = if child.is_or_contains_block() {
            DisplayOutside::Block
        } else {
            child_display.outside()
        };
        if (wrap_ctx.needs_wrap)(child_node_kind, display_outside) {
            out.push_wrapped(wrap_ctx.container_node_id, child_id, doc);
            return;
        }
    }
    out.push(child_id, doc);
}

/// Push the container's children (and ::before/::after pseudos) as layout
/// children, hoisting transparently through display:contents nodes and
/// filtering out comments and whitespace.
fn push_hoisted_children_and_pseudos(
    doc: &mut BaseDocument,
    container_node_id: NodeId,
    out: &mut LayoutChildren,
    wrap: Option<WrapContext>,
) {
    if let Some(before) = doc.nodes[container_node_id].before() {
        push_hoisted_child(doc, before, out, wrap);
    }
    // Take children array from node to avoid borrow checker issues.
    let children = std::mem::take(&mut doc.nodes[container_node_id].children);
    for child_id in children.iter().copied() {
        let child = &doc.nodes[child_id];
        if child.data.kind() == NodeKind::Comment || child.is_whitespace_node() {
            continue;
        }
        push_hoisted_child(doc, child_id, out, wrap);
    }
    doc.nodes[container_node_id].children = children;
    if let Some(after) = doc.nodes[container_node_id].after() {
        push_hoisted_child(doc, after, out, wrap);
    }
}

fn push_non_whitespace_children_and_pseudos(layout_children: &mut ThinVec<NodeId>, node: &Node) {
    if let Some(before) = node.before() {
        layout_children.push(before);
    }
    layout_children.extend(node.children.iter().copied().filter(|child_id| {
        let child_node = node.with(*child_id);
        !child_node.is_whitespace_node() && child_node.data.kind() != NodeKind::Comment
    }));
    if let Some(after) = node.after() {
        layout_children.push(after);
    }
}

/// PATCH: the line height of an inline formatting context's root (its strut).
#[derive(Clone, Copy)]
struct RootLineHeight {
    px: f32,
    /// `line-height: normal` (then `px` is an approximation).
    normal: bool,
}

/// Convert a relative line height to an absolute one
fn resolve_line_height(line_height: parley::LineHeight, font_size: f32) -> f32 {
    match line_height {
        parley::LineHeight::FontSizeRelative(relative) => relative * font_size,
        parley::LineHeight::Absolute(absolute) => absolute,
        // PATCH: `normal` (the font's rounded metrics, computed by parley per run); where a
        // number is needed up front, typical fonts' value (Arial: 1.15) stands in for it.
        parley::LineHeight::MetricsRelative(relative) => relative * font_size * 1.15,
    }
}

/// Result of classifying the in-flow children of a flow container as
/// all-block, all-inline and/or all-out-of-flow.
struct FlowClassification {
    all_block: bool,
    all_inline: bool,
    all_out_of_flow: bool,
    has_contents: bool,
}

impl Default for FlowClassification {
    fn default() -> Self {
        Self {
            all_block: true,
            all_inline: true,
            all_out_of_flow: true,
            has_contents: false,
        }
    }
}

/// Classify a flow container's children (including its ::before/::after
/// pseudo-elements) for inline-vs-block layout, recursing transparently
/// through display:contents nodes (whose children participate in the
/// container's formatting context).
fn classify_flow_children(
    doc: &BaseDocument,
    container_node_id: NodeId,
    classification: &mut FlowClassification,
) {
    let node = &doc.nodes[container_node_id];
    // ::before/::after pseudos with display:contents are transparent for box
    // generation, so their children (e.g. generated text) participate in the
    // container's formatting context and vote in the classification. Pseudos
    // with any other display value generate their own box, which every
    // construction arm already pushes explicitly, so they cast no vote.
    let pseudo_ids = node
        .before()
        .into_iter()
        .chain(node.after())
        .filter(|pe_id| {
            let display = doc.nodes[*pe_id]
                .display_style()
                .unwrap_or(Display::inline());
            matches!(display.inside(), DisplayInside::Contents)
        });
    let child_ids = node.children.iter().copied().chain(pseudo_ids);
    for child_id in child_ids {
        let child = &doc.nodes[child_id];

        // Comment nodes generate no boxes and must not affect the
        // inline-vs-block classification: an unstyled comment would
        // default to display:inline below and force an inline
        // formatting context on the container, swallowing element
        // siblings into the inline layout (zero-sizing any
        // out-of-flow ones).
        if child.data.kind() == NodeKind::Comment {
            continue;
        }

        // Unwraps on Text and SVG nodes
        let style = child.primary_styles();
        let style = style.as_ref();
        let display = style
            .map(|s| s.clone_display())
            .unwrap_or(Display::inline());
        if matches!(display.inside(), DisplayInside::Contents) {
            // Transparent for box generation: the contents node casts
            // no vote itself — its children decide.
            classification.has_contents = true;
            classify_flow_children(doc, child_id, classification);
        } else if matches!(display.inside(), DisplayInside::None) {
            // display:none children generate no boxes and cast no vote.
            continue;
        } else {
            let position = style
                .map(|s| s.clone_position())
                .unwrap_or(PositionProperty::Static);
            let float = style.map(|s| s.clone_float()).unwrap_or(Float::None);

            // Ignore nodes that are entirely whitespace
            if child.is_whitespace_node() {
                continue;
            }

            // display:none children generate no boxes and cast no vote
            if matches!(display.outside(), DisplayOutside::None) {
                continue;
            }

            let is_in_flow = matches!(
                position,
                PositionProperty::Static | PositionProperty::Relative | PositionProperty::Sticky
            ) && matches!(float, Float::None);

            if !is_in_flow {
                continue;
            }

            classification.all_out_of_flow = false;
            match display.outside() {
                DisplayOutside::None => {}
                DisplayOutside::Block
                | DisplayOutside::TableCaption
                | DisplayOutside::InternalTable => classification.all_inline = false,
                DisplayOutside::Inline => {
                    classification.all_block = false;

                    // We need the "complex" tree fixing when an inline contains a block
                    if child.is_or_contains_block() {
                        classification.all_inline = false;
                    }
                }
            }
        }
    }
}

pub(crate) fn collect_layout_children(
    doc: &mut BaseDocument,
    container_node_id: NodeId,
    out: &mut LayoutChildren,
) {
    collect_layout_children_with_wrap(doc, container_node_id, out, None)
}

fn collect_layout_children_with_wrap(
    doc: &mut BaseDocument,
    container_node_id: NodeId,
    out: &mut LayoutChildren,
    wrap: Option<WrapContext>,
) {
    // Reset construction flags
    // TODO: make incremental and only remove this if the element is no longer an inline root
    doc.nodes[container_node_id]
        .flags
        .reset_construction_flags();
    if let Some(element_data) = doc.nodes[container_node_id].element_data_mut() {
        element_data.take_inline_layout();
    }

    flush_pseudo_elements(doc, container_node_id);

    if let Some(el) = doc.nodes[container_node_id].data.downcast_element() {
        // Handle text inputs
        let tag_name = el.name.local.as_ref();
        if matches!(tag_name, "input" | "textarea") {
            let type_attr: Option<&str> = doc.nodes[container_node_id]
                .data
                .downcast_element()
                .and_then(|el| el.attr(local_name!("type")));
            if tag_name == "textarea" {
                create_text_editor(doc, container_node_id, true);
                return;
            } else if matches!(
                type_attr,
                None | Some("text" | "password" | "email" | "number" | "search" | "tel" | "url")
            ) {
                create_text_editor(doc, container_node_id, false);
                return;
            } else if matches!(type_attr, Some("checkbox" | "radio")) {
                create_checkbox_input(doc, container_node_id);
                return;
            }
        }

        #[cfg(feature = "svg")]
        if matches!(tag_name, "svg") {
            // PATCH: own serializer: keeps `currentColor` (resolved by usvg through the root
            // `color`) and carries CSS-set `fill`/`stroke` as inline style.
            let mut outer_html = String::new();
            write_svg_markup(doc, container_node_id, &mut outer_html);

            // HACK: usvg fails to parse SVGs that don't have the SVG xmlns set. So inject it
            // if the generated source doesn't have it.
            if !outer_html.contains("xmlns") {
                outer_html =
                    outer_html.replace("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"");
            }

            // PATCH: `<use href="#icon">` / `url(#gradient)` pointing outside this `<svg>`
            // (icon sprites elsewhere in the page).
            let outer_html = inline_external_svg_refs(doc, outer_html);
            // PATCH: paint inherited through CSS (`.icon { fill: currentColor }`, `color`).
            let outer_html = add_svg_root_paint(doc, container_node_id, outer_html);

            // Remove contruction damage from subtree
            doc.iter_subtree_mut(container_node_id, |id: NodeId, doc: &mut BaseDocument| {
                doc.nodes[id].remove_damage(CONSTRUCT_BOX | CONSTRUCT_DESCENDENT | CONSTRUCT_FC);
            });

            match crate::util::parse_svg_image(outer_html.as_bytes()) {
                Ok(svg) => {
                    doc.get_node_mut(container_node_id)
                        .unwrap()
                        .element_data_mut()
                        .unwrap()
                        .special_data =
                        SpecialElementData::Image(Box::new(crate::node::ImageData::Svg(svg)));
                }
                Err(err) => {
                    #[cfg(feature = "tracing")]
                    tracing::warn!(
                        node_id = ?container_node_id,
                        html = outer_html,
                        error = ?err,
                        "SVG parse failed",
                    );
                    #[cfg(not(feature = "tracing"))]
                    let _ = err;
                }
            };
            return;
        }

        //Only ol tags have start and reversed attributes
        let (mut index, reversed) = if tag_name == "ol" {
            (
                el.attr_parsed(local_name!("start"))
                    .map(|start: usize| start - 1)
                    .unwrap_or(0),
                el.attr_parsed(local_name!("reversed")).unwrap_or(false),
            )
        } else {
            (1, false)
        };
        collect_list_item_children(doc, &mut index, reversed, container_node_id);
    }

    // Skip further construction if the node has no children or psuedo-children
    {
        let node = &doc.nodes[container_node_id];
        if node.children.is_empty() && node.before().is_none() && node.after().is_none() {
            return;
        }
    }

    let container_display = doc.nodes[container_node_id].display_style().unwrap_or(
        match doc.nodes[container_node_id].data.kind() {
            NodeKind::AnonymousBlock => Display::Block,
            _ => Display::Inline,
        },
    );

    match container_display.inside() {
        DisplayInside::None => {}
        DisplayInside::Contents => {
            doc.nodes[container_node_id]
                .remove_damage(CONSTRUCT_BOX | CONSTRUCT_DESCENDENT | CONSTRUCT_FC);
            // display:contents is transparent for box generation: hoist the
            // children THEMSELVES (not their layout children) into the
            // parent, recursing only through nested contents nodes.
            push_hoisted_children_and_pseudos(doc, container_node_id, out, wrap);
        }
        DisplayInside::Flex | DisplayInside::Grid => {
            // ::before/::after pseudos must be checked too: a pseudo with
            // display:contents hoists its text content into the container.
            let container = &doc.nodes[container_node_id];
            let has_text_node_or_contents = container
                .children
                .iter()
                .copied()
                .chain(container.before())
                .chain(container.after())
                .map(|child_id| &doc.nodes[child_id])
                .any(|child| {
                    let display = child.display_style().unwrap_or(Display::inline());
                    let node_kind = child.data.kind();
                    display.inside() == DisplayInside::Contents || node_kind == NodeKind::Text
                });

            if !has_text_node_or_contents {
                return push_non_whitespace_children_and_pseudos(
                    &mut out.children,
                    &doc.nodes[container_node_id],
                );
            }

            collect_complex_layout_children(
                doc,
                container_node_id,
                out,
                true,
                text_item_needs_wrap,
            );
        }

        DisplayInside::Table => {
            let (table_context, tlayout_children) = build_table_context(doc, container_node_id);
            #[allow(clippy::arc_with_non_send_sync)]
            let data = SpecialElementData::TableRoot(Arc::new(table_context));
            doc.nodes[container_node_id]
                .flags
                .insert(NodeFlags::IS_TABLE_ROOT);
            doc.nodes[container_node_id]
                .data
                .downcast_element_mut()
                .unwrap()
                .special_data = data;
            if let Some(before) = doc.nodes[container_node_id].before() {
                out.push(before, doc);
            }
            out.extend(&tlayout_children, doc);
            if let Some(after) = doc.nodes[container_node_id].after() {
                out.push(after, doc);
            }
        }

        // Flow, FlowRoot and TableCell, plus internal table displays (row,
        // row group, column, ...) occurring outside of a table. Blitz does
        // not yet generate anonymous table wrapper boxes for the latter, so
        // they are laid out as flow containers, which crucially ensures
        // their text children get wrapped rather than being pushed as bare
        // layout children (text nodes carry no style and cannot be laid out
        // as block/flex/grid items).
        _ => {
            let mut classification = FlowClassification::default();
            classify_flow_children(doc, container_node_id, &mut classification);

            if classification.all_out_of_flow {
                // Contents-transparent: a display:contents child may be
                // holding the out-of-flow elements (otherwise the contents
                // node itself would be pushed as a layout box).
                let wrap = Some(WrapContext {
                    container_node_id,
                    needs_wrap: text_item_needs_wrap,
                });
                return push_hoisted_children_and_pseudos(doc, container_node_id, out, wrap);
            }

            // TODO: fix display:contents
            if classification.all_inline {
                let existing_layout = doc.nodes[container_node_id]
                    .element_data_mut()
                    .and_then(|el| el.inline_layout_data.take());
                let layout = existing_layout.unwrap_or_else(|| Box::new(TextLayout::new()));

                // Queue node for inline layout construction. Deferring construction of inline layouts to a
                // dedicated phase allows us to multithread the expensive text shaping step.
                doc.deferred_construction_nodes.push(ConstructionTask {
                    node_id: container_node_id,
                    data: ConstructionTaskData::InlineLayout(layout),
                });
                doc.nodes[container_node_id]
                    .flags
                    .insert(NodeFlags::IS_INLINE_ROOT);

                find_inline_layout_embedded_boxes(doc, container_node_id, &mut out.children);
                return;
            }

            // If the children are either all inline or all block then simply return the regular children
            // as the layout children
            if classification.all_block & !classification.has_contents {
                return push_non_whitespace_children_and_pseudos(
                    &mut out.children,
                    &doc.nodes[container_node_id],
                );
            } else if classification.all_inline & !classification.has_contents {
                return push_children_and_pseudos(&mut out.children, &doc.nodes[container_node_id]);
            }

            collect_complex_layout_children(
                doc,
                container_node_id,
                out,
                false,
                block_item_needs_wrap,
            );
        }
    }
}

/// Extract the text generated by a pseudo-element's `content` property
/// (only string content items are currently supported).
fn pe_content_text(style: &style::properties::ComputedValues) -> Option<&str> {
    match &style.get_counters().content {
        Content::Items(item_data) => {
            let items = &item_data.items[0..item_data.alt_start];
            match items.first() {
                Some(ContentItem::String(owned_str)) => Some(owned_str),
                _ => {
                    // TODO: other types of content
                    None
                }
            }
        }
        _ => None,
    }
}

fn flush_pseudo_elements(doc: &mut BaseDocument, node_id: NodeId) {
    let (before_style, after_style, before_node_id, after_node_id) = {
        let node = &doc.nodes[node_id];

        let before_node_id = node.before();
        let after_node_id = node.after();

        // Note: yes these are kinda backwards
        let style_data = node.stylo_element_data_opt().and_then(|s| s.get());
        let before_style = style_data
            .as_ref()
            .and_then(|d| d.styles.pseudos.as_array()[1].clone());
        let after_style = style_data
            .as_ref()
            .and_then(|d| d.styles.pseudos.as_array()[0].clone());

        (before_style, after_style, before_node_id, after_node_id)
    };

    // Sync pseudo element
    // TODO: Make incremental
    for (idx, pe_style, pe_node_id) in [
        (1, before_style, before_node_id),
        (0, after_style, after_node_id),
    ] {
        // Delete psuedo element if it exists but shouldn't
        if let (Some(pe_node_id), None) = (pe_node_id, &pe_style) {
            doc.remove_and_drop_pe(pe_node_id);
            let node = &mut doc.nodes[node_id];
            node.set_pe_by_index(idx, None);
            node.insert_damage(ALL_DAMAGE);
        }

        // Create pseudo element if it should exist but doesn't
        if let (None, Some(pe_style)) = (pe_node_id, &pe_style) {
            let new_node_id = doc.create_node(NodeData::AnonymousBlock(Box::new(
                ElementData::new(DUMMY_NAME, Vec::new()),
            )));
            doc.nodes[new_node_id].parent = Some(node_id);
            doc.nodes[new_node_id].layout_parent.set(Some(node_id));
            if doc.nodes[node_id].flags.contains(NodeFlags::IS_IN_DOCUMENT) {
                doc.nodes[new_node_id]
                    .flags
                    .insert(NodeFlags::IS_IN_DOCUMENT);
            }

            if let Some(text) = pe_content_text(pe_style) {
                let text = text.to_string();
                let text_node_id = doc.create_text_node(&text);
                doc.nodes[text_node_id].parent = Some(new_node_id);
                doc.nodes[new_node_id].children.push(text_node_id);
            }

            let mut element_data = StyloElementData::default();
            element_data.styles.primary = Some(pe_style.clone());
            element_data.set_restyled();
            element_data.damage = ALL_DAMAGE;
            *doc.nodes[new_node_id]
                .stylo_element_data_mut()
                .ensure_init_mut() = element_data;

            let node = &mut doc.nodes[node_id];
            node.set_pe_by_index(idx, Some(new_node_id));
            node.insert_damage(ALL_DAMAGE);

            doc.pending_style_image_nodes.push(new_node_id);
        }

        // Else: Update psuedo element
        if let (Some(pe_node_id), Some(pe_style)) = (pe_node_id, pe_style) {
            // Sync the pseudo-element's text node with its `content` style, which
            // may have changed (e.g. `details[open] summary::after { content: ... }`).
            //
            // Note: this deliberately compares the text itself rather than relying on
            // the style-pointer comparison below, as the pseudo-element's style may
            // already have been updated by `sync_pseudo_element_styles` during the
            // style traversal without the text having been updated.
            let new_text = pe_content_text(&pe_style).map(str::to_string);
            let existing_text_node_id = doc.nodes[pe_node_id]
                .children
                .first()
                .copied()
                .filter(|&child_id| doc.nodes[child_id].is_text_node());
            match (existing_text_node_id, new_text) {
                (Some(text_node_id), Some(new_text)) => {
                    let text_data = doc.nodes[text_node_id].text_data_mut().unwrap();
                    if text_data.content != new_text {
                        text_data.content = new_text;
                        doc.nodes[node_id].insert_damage(ALL_DAMAGE);
                    }
                }
                (None, Some(new_text)) => {
                    let text_node_id = doc.create_text_node(&new_text);
                    doc.nodes[text_node_id].parent = Some(pe_node_id);
                    doc.nodes[pe_node_id].children.push(text_node_id);
                    doc.nodes[node_id].insert_damage(ALL_DAMAGE);
                }
                (Some(text_node_id), None) => {
                    doc.nodes[pe_node_id]
                        .children
                        .retain(|&child_id| child_id != text_node_id);
                    doc.remove_node_from_tree(text_node_id);
                    doc.nodes[node_id].insert_damage(ALL_DAMAGE);
                }
                (None, None) => {}
            }

            let mut node_styles = doc.nodes[pe_node_id]
                .stylo_element_data_opt_mut()
                .and_then(|s| s.get_mut());
            let node_styles = &mut node_styles.as_mut().unwrap();
            node_styles.damage.insert(ALL_DAMAGE);
            let primary_styles = &mut node_styles.styles.primary;

            if !std::ptr::eq(&**primary_styles.as_ref().unwrap(), &*pe_style) {
                *primary_styles = Some(pe_style);
                node_styles.set_restyled();
                doc.pending_style_image_nodes.push(pe_node_id);
            }
        }
    }
}

/// Handles the cases where there are text nodes or inline nodes that need to be wrapped in an anonymous block node
fn collect_complex_layout_children(
    doc: &mut BaseDocument,
    container_node_id: NodeId,
    out: &mut LayoutChildren,
    hide_whitespace: bool,
    needs_wrap: fn(NodeKind, DisplayOutside) -> bool,
) {
    doc.iter_children_and_pseudos_mut(container_node_id, |child_id, doc| {
        // Get node kind (text, element, comment, etc)
        let child_node_kind = doc.nodes[child_id].data.kind();

        // Get Display style. Default to inline because nodes without styles are probably text nodes
        let contains_block = doc.nodes[child_id].is_or_contains_block();
        let child_display = &doc.nodes[child_id]
            .display_style()
            .unwrap_or(Display::inline());
        let display_inside = child_display.inside();
        let display_outside = if contains_block {
            DisplayOutside::Block
        } else {
            child_display.outside()
        };

        let is_whitespace_node = doc.nodes[child_id].is_whitespace_node();

        // Skip comment nodes. Note that we do *not* skip `Display::None` nodes as they may need to be hidden.
        // Taffy knows how to deal with `Display::None` children.
        //
        // Also hide all-whitespace flexbox children as these should be ignored
        if child_node_kind == NodeKind::Comment || (hide_whitespace && is_whitespace_node) {
            // return;
        }
        // Recurse into `Display::Contents` nodes, wrapping hoisted text and
        // inline children as if they were direct children of this container
        else if display_inside == DisplayInside::Contents {
            let wrap = Some(WrapContext {
                container_node_id,
                needs_wrap,
            });
            collect_layout_children_with_wrap(doc, child_id, out, wrap)
        }
        // Push nodes that need wrapping into the current "anonymous block container".
        // If there is not an open one then we create one.
        else if needs_wrap(child_node_kind, display_outside) {
            out.push_wrapped(container_node_id, child_id, doc);
        }
        // Else push the child directly (and close any open "anonymous block container")
        else {
            out.push(child_id, doc);
        }
    });

    // If anonymous block node only contains whitespace then delete it, else push it
    out.maybe_push_anon_block(doc);
}

fn create_text_editor(doc: &mut BaseDocument, input_element_id: NodeId, is_multiline: bool) {
    let node = &mut doc.nodes[input_element_id];
    let parley_style = node
        .primary_styles()
        .as_ref()
        .map(|s| stylo_to_parley::style(node.id, s))
        .unwrap_or_default();

    let element = &mut node.data.downcast_element_mut().unwrap();
    if !matches!(element.special_data, SpecialElementData::TextInput(_)) {
        let mut text_input_data = TextInputData::new(is_multiline);
        let editor = &mut text_input_data.editor;
        editor.set_text(element.attr(local_name!("value")).unwrap_or(""));
        element.special_data = SpecialElementData::TextInput(text_input_data);
    }

    let SpecialElementData::TextInput(text_input_data) = &mut element.special_data else {
        unreachable!();
    };

    let editor = &mut text_input_data.editor;
    editor.set_scale(doc.viewport.scale_f64() as f32);
    editor.set_width(None);

    // PATCH: the page's font (family, weight, style, letter spacing), not just its size.
    let text_styles = [
        StyleProperty::FontFamily(parley_style.font_family.clone()),
        StyleProperty::FontSize(parley_style.font_size),
        StyleProperty::FontWeight(parley_style.font_weight),
        StyleProperty::FontStyle(parley_style.font_style),
        StyleProperty::FontWidth(parley_style.font_width),
        StyleProperty::LetterSpacing(parley_style.letter_spacing),
        StyleProperty::LineHeight(parley_style.line_height),
        StyleProperty::Brush(parley_style.brush.clone()),
    ];
    let styles = editor.edit_styles();
    styles.retain(|_| false);
    for property in text_styles.iter().cloned() {
        styles.insert(property);
    }

    let placeholder = element
        .attr(local_name!("placeholder"))
        .filter(|p| !p.is_empty())
        .map(|p| {
            // Line breaks in the attribute are removed for single-line inputs.
            if is_multiline {
                p.to_string()
            } else {
                p.replace(['\n', '\r'], "")
            }
        });
    let scale = doc.viewport.scale_f64() as f32;
    let SpecialElementData::TextInput(text_input_data) = &mut element.special_data else {
        unreachable!();
    };
    let editor = &mut text_input_data.editor;
    let mut font_ctx = doc.font_ctx.lock().unwrap();
    editor.refresh_layout(&mut font_ctx, &mut doc.layout_ctx);

    // PATCH: `placeholder` text (painted while the value is empty).
    text_input_data.placeholder = placeholder.map(|text| {
        let mut builder = doc.layout_ctx.ranged_builder(&mut font_ctx, &text, scale, true);
        for property in text_styles {
            builder.push_default(property);
        }
        let mut layout = builder.build(&text);
        layout.break_all_lines(None);
        Box::new(layout)
    });
}

fn create_checkbox_input(doc: &mut BaseDocument, input_element_id: NodeId) {
    let node = &mut doc.nodes[input_element_id];

    let element = &mut node.data.downcast_element_mut().unwrap();
    if !matches!(element.special_data, SpecialElementData::CheckboxInput(_)) {
        let checked = element.has_attr(local_name!("checked"));
        element.special_data = SpecialElementData::CheckboxInput(checked);
        element.set_checkbox_input_checked(checked);
    }
}

/// Find and return the "layout_children" (inline boxes) for an inline layout
/// without actually constructing the layout. This allows us to defer the expensive
/// construction of the Parley layout (which invokes text shaping) to a paralell phase.
pub(crate) fn find_inline_layout_embedded_boxes(
    doc: &mut BaseDocument,
    inline_context_root_node_id: NodeId,
    layout_children: &mut ThinVec<NodeId>,
) {
    flush_inline_pseudos_recursive(doc, inline_context_root_node_id);

    iter_children_and_pseudos!(doc.nodes[inline_context_root_node_id], |child_id| {
        find_inline_layout_embedded_boxes_recursive(
            &mut doc.nodes,
            inline_context_root_node_id,
            child_id,
            layout_children,
        );
    });

    fn flush_inline_pseudos_recursive(doc: &mut BaseDocument, node_id: NodeId) {
        doc.iter_children_mut(node_id, |child_id, doc| {
            flush_pseudo_elements(doc, child_id);
            let display = doc.nodes[node_id]
                .display_style()
                .unwrap_or(Display::inline());
            let do_recurse = match (display.outside(), display.inside()) {
                (DisplayOutside::None, DisplayInside::Contents) => true,
                (DisplayOutside::Inline, DisplayInside::Flow) => true,
                (_, _) => false,
            };
            if do_recurse {
                flush_inline_pseudos_recursive(doc, child_id);
            }
        });
    }

    fn find_inline_layout_embedded_boxes_recursive(
        nodes: &mut crate::NodeTree,
        parent_id: NodeId,
        node_id: NodeId,
        layout_children: &mut ThinVec<NodeId>,
    ) {
        let node = &mut nodes[node_id];

        // Set layout_parent for node.
        node.layout_parent.set(Some(parent_id));

        match &node.data {
            NodeData::Element(element_data) | NodeData::AnonymousBlock(element_data) => {
                // if the input type is hidden, hide it
                if *element_data.name.local == *"input" {
                    if let Some("hidden") = element_data.attr(local_name!("type")) {
                        return;
                    }
                }

                let display = node.display_style().unwrap_or(Display::inline());

                match (display.outside(), display.inside()) {
                    (DisplayOutside::None, DisplayInside::None) => {
                        node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                    }
                    (DisplayOutside::None, DisplayInside::Contents) => {
                        node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                        iter_children!(nodes[node_id], |child_id| {
                            find_inline_layout_embedded_boxes_recursive(
                                nodes,
                                parent_id,
                                child_id,
                                layout_children,
                            );
                        });
                    }
                    (DisplayOutside::Inline, DisplayInside::Flow) => {
                        let tag_name = &element_data.name.local;

                        if is_replaced_element(tag_name)
                            || *tag_name == local_name!("input")
                            || *tag_name == local_name!("textarea")
                            || *tag_name == local_name!("button")
                        {
                            layout_children.push(node_id);
                        } else if *tag_name == local_name!("br") {
                            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                        } else {
                            node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                            iter_children_and_pseudos!(nodes[node_id], |child_id| {
                                find_inline_layout_embedded_boxes_recursive(
                                    nodes,
                                    node_id,
                                    child_id,
                                    layout_children,
                                );
                            });
                        }
                    }
                    // Inline box
                    (_, _) => {
                        layout_children.push(node_id);
                    }
                };
            }
            NodeData::Comment { .. } | NodeData::Text(_) => {
                node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            }
            NodeData::Document(_) => unreachable!(),
        }
    }
}

/// PATCH: id flag for zero-height "spacer" inline boxes that reserve the horizontal
/// margin + border + padding of inline elements (Parley has no notion of inline-box
/// edges). Boxes with this flag don't correspond to a node.
pub const INLINE_SPACER_FLAG: u64 = (1 << 63) | (1 << 62);
/// PATCH: spacer that covers border + padding (painted with the element's background).
pub const INLINE_EDGE_SPACER: u64 = 1 << 62;
/// PATCH: spacer that covers the margin (never painted).
pub const INLINE_MARGIN_SPACER: u64 = 1 << 63;

/// PATCH: horizontal (start, end) margin + border + padding of an inline element in CSS
/// px. Percentages resolve to 0 (they'd need the containing block width).
/// Returns ((margin_start, edge_start), (edge_end, margin_end)).
fn inline_edge_extents(node: &crate::Node) -> ((f32, f32), (f32, f32)) {
    use taffy::ResolveOrZero;
    let Some(s) = node.primary_styles() else {
        return ((0.0, 0.0), (0.0, 0.0));
    };
    let ts = stylo_taffy::to_taffy_style(&s);
    let m = ts.margin.resolve_or_zero(None, super::resolve_calc_value);
    let p = ts.padding.resolve_or_zero(None, super::resolve_calc_value);
    let b = ts.border.resolve_or_zero(None, super::resolve_calc_value);
    ((m.left, p.left + b.left), (p.right + b.right, m.right))
}

/// PATCH: copy the elements that an inline `<svg>` references by id but doesn't contain
/// (`<use href="#id">`, gradient/pattern/filter `href`, `url(#id)`) into a `<defs>`, so
/// usvg can resolve them. Sprites (`<svg style="display:none"><symbol id=…>`) are a
/// common way to ship icons.
#[cfg(feature = "svg")]
fn inline_external_svg_refs(doc: &BaseDocument, mut svg: String) -> String {
    const MAX_ELEMENTS: usize = 64;
    const MAX_BYTES: usize = 512 * 1024;
    let mut defs = String::new();
    let mut seen: Vec<String> = Vec::new();
    let mut queue = svg_refs(&svg);
    let mut copied = 0;
    while let Some(id) = queue.pop() {
        if seen.iter().any(|s| *s == id) || copied >= MAX_ELEMENTS || defs.len() > MAX_BYTES {
            continue;
        }
        seen.push(id.clone());
        if svg.contains(&format!(" id=\"{id}\"")) {
            continue;
        }
        let Some(&node_id) = doc.nodes_to_id.get(&id).and_then(|ids| ids.first()) else {
            continue;
        };
        let node = &doc.nodes[node_id];
        let is_svg_element = node
            .element_data()
            .is_some_and(|el| el.name.ns == markup5ever::ns!(svg));
        if !is_svg_element {
            continue;
        }
        // Serialized as authored: `currentColor` must resolve where the element is used,
        // not with the color of the (hidden) sprite it lives in.
        let mut html = String::new();
        write_svg_markup(doc, node_id, &mut html);
        queue.extend(svg_refs(&html));
        defs.push_str(&html);
        copied += 1;
    }
    if !defs.is_empty() {
        if let Some(end) = svg.find('>') {
            let self_closing = svg[..end].ends_with('/');
            if !self_closing {
                svg.insert_str(end + 1, &format!("<defs>{defs}</defs>"));
            }
        }
    }
    svg
}

/// Serialize an SVG subtree for usvg: attributes as authored (`currentColor` resolves
/// through the root's `color`), plus `fill`/`stroke`/`stroke-width` that CSS rules set on
/// an element (they differ from the parent's computed value) as inline style, since
/// usvg doesn't see the page's stylesheets (`.icon path { fill: currentColor }`).
#[cfg(feature = "svg")]
fn write_svg_markup(doc: &BaseDocument, node_id: NodeId, out: &mut String) {
    let node = &doc.nodes[node_id];
    match &node.data {
        NodeData::Text(t) => {
            html_escape::encode_text_to_string(&t.content, out);
        }
        NodeData::Element(el) => {
            out.push('<');
            out.push_str(&el.name.local);
            let css = svg_css_paint(doc, node_id);
            let mut wrote_style = false;
            for attr in el.attrs.iter() {
                out.push(' ');
                if let Some(prefix) = &attr.name.prefix {
                    out.push_str(prefix);
                    out.push(':');
                }
                out.push_str(&attr.name.local);
                out.push_str("=\"");
                if attr.name.local == local_name!("style") && attr.name.prefix.is_none() {
                    wrote_style = true;
                    let mut v = attr.value.to_string();
                    if let Some(css) = &css {
                        v.push(';');
                        v.push_str(css);
                    }
                    html_escape::encode_double_quoted_attribute_to_string(&v, out);
                } else {
                    html_escape::encode_double_quoted_attribute_to_string(&attr.value, out);
                }
                out.push('"');
            }
            if let (false, Some(css)) = (wrote_style, &css) {
                out.push_str(" style=\"");
                html_escape::encode_double_quoted_attribute_to_string(css, out);
                out.push('"');
            }
            out.push('>');
            for &child in node.children.iter() {
                write_svg_markup(doc, child, out);
            }
            out.push_str("</");
            out.push_str(&el.name.local);
            out.push('>');
        }
        _ => {}
    }
}

/// `fill`/`stroke`/`stroke-width` declarations for SVG paint that differs from the
/// parent's computed values (i.e. was set by a CSS rule on this element).
#[cfg(feature = "svg")]
fn svg_css_paint(doc: &BaseDocument, node_id: NodeId) -> Option<String> {
    use style_traits::ToCss as _;
    let node = &doc.nodes[node_id];
    let styles = node.primary_styles()?;
    let parent_styles = node.parent.and_then(|p| doc.nodes[p].primary_styles())?;
    let (own, parent) = (styles.get_inherited_svg(), parent_styles.get_inherited_svg());
    let mut decls = String::new();
    if own.fill != parent.fill {
        decls.push_str(&format!("fill:{};", own.fill.to_css_string()));
    }
    if own.stroke != parent.stroke {
        decls.push_str(&format!("stroke:{};", own.stroke.to_css_string()));
    }
    if own.stroke_width != parent.stroke_width {
        decls.push_str(&format!("stroke-width:{};", own.stroke_width.to_css_string()));
    }
    (!decls.is_empty()).then_some(decls)
}

/// Add `color`, `fill` and `stroke` presentation attributes to the root `<svg>` tag
/// from its computed style when CSS (not an attribute) set them, so they reach usvg.
#[cfg(feature = "svg")]
fn add_svg_root_paint(doc: &BaseDocument, svg_id: NodeId, mut svg: String) -> String {
    use style::values::generics::svg::SVGPaintKind;
    use style_traits::ToCss as _;
    let Some(styles) = doc.nodes[svg_id].primary_styles() else {
        return svg;
    };
    let Some(end) = svg.find('>') else { return svg };
    let tag = svg[..end].trim_end_matches('/').to_string();
    let has_attr = |name: &str| {
        tag.split(|c: char| c.is_ascii_whitespace())
            .any(|a| a.split('=').next() == Some(name))
    };
    let mut extra = String::new();
    let color = styles.clone_color().to_css_string();
    if !has_attr("color") {
        extra.push_str(&format!(" color=\"{color}\""));
    }
    let svg_style = styles.get_inherited_svg();
    let paint_css = |paint: &style::values::computed::SVGPaint| -> Option<String> {
        match &paint.kind {
            SVGPaintKind::Color(c) => Some(c.resolve_to_absolute(&styles.clone_color()).to_css_string()),
            SVGPaintKind::None => Some("none".to_string()),
            _ => None,
        }
    };
    let fill = &svg_style.fill;
    if !has_attr("fill") && *fill != style::values::computed::SVGPaint::BLACK {
        if let Some(v) = paint_css(fill) {
            extra.push_str(&format!(" fill=\"{v}\""));
        }
    }
    let stroke = &svg_style.stroke;
    if !has_attr("stroke") && !matches!(stroke.kind, SVGPaintKind::None) {
        if let Some(v) = paint_css(stroke) {
            extra.push_str(&format!(" stroke=\"{v}\""));
        }
    }
    if !extra.is_empty() {
        let insert_at = if svg[..end].ends_with('/') { end - 1 } else { end };
        svg.insert_str(insert_at, &extra);
    }
    svg
}

/// Ids referenced by `href="#id"` on referencing SVG elements and by `url(#id)`.
#[cfg(feature = "svg")]
fn svg_refs(markup: &str) -> Vec<String> {
    const HREF_TAGS: &[&str] = &[
        "use", "linearGradient", "radialGradient", "pattern", "filter", "textPath", "feImage",
    ];
    let mut out = Vec::new();
    let mut rest = markup;
    while let Some(lt) = rest.find('<') {
        rest = &rest[lt + 1..];
        let end = rest.find('>').unwrap_or(rest.len());
        let tag = &rest[..end];
        let name: &str = tag
            .split(|c: char| c.is_ascii_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        if HREF_TAGS.contains(&name) {
            for key in ["href=\"#", "href='#"] {
                if let Some(p) = tag.find(key) {
                    let v = &tag[p + key.len()..];
                    let q = key.as_bytes()[5] as char;
                    if let Some(e) = v.find(q) {
                        out.push(v[..e].to_string());
                    }
                }
            }
        }
        let mut t = tag;
        while let Some(p) = t.find("url(") {
            let v = t[p + 4..].trim_start_matches(['"', '\'', ' ']);
            if let Some(id) = v.strip_prefix('#') {
                let e = id.find([')', '"', '\'', ' ']).unwrap_or(id.len());
                out.push(id[..e].to_string());
            }
            t = &t[p + 4..];
        }
        rest = &rest[end.min(rest.len())..];
    }
    out
}

fn push_spacer(builder: &mut TreeBuilder<TextBrush>, flag: u64, node_id: NodeId, width: f32) {
    if width > 0.0 {
        // Spacers don't take part in white-space collapsing (vendored parley PATCH).
        builder.push_collapse_transparent_inline_box(InlineBox {
            id: flag | node_id.as_u64(),
            kind: InlineBoxKind::InFlow,
            index: 0,
            width,
            height: 0.0,
        });
    }
}

pub(crate) fn build_inline_layout_into(
    nodes: &crate::NodeTree,
    layout_ctx: &mut LayoutContext<TextBrush>,
    font_ctx: &mut FontContext,
    text_layout: &mut TextLayout,
    scale: f32,
    inline_context_root_node_id: NodeId,
) {
    // Get the inline context's root node's text styles
    let root_node = &nodes[inline_context_root_node_id];
    let root_node_style = root_node.primary_styles().or_else(|| {
        root_node
            .parent
            .and_then(|parent_id| nodes[parent_id].primary_styles())
    });

    let parley_style = root_node_style
        .as_ref()
        .map(|s| stylo_to_parley::style(inline_context_root_node_id, s))
        .unwrap_or_default();

    let root_line_height = RootLineHeight {
        px: resolve_line_height(parley_style.line_height, parley_style.font_size),
        normal: matches!(parley_style.line_height, parley::LineHeight::MetricsRelative(_)),
    };

    // Create a parley tree builder
    let mut builder = layout_ctx.tree_builder(font_ctx, scale, true, &parley_style);

    // Set whitespace collapsing mode
    let collapse_mode = root_node_style
        .as_ref()
        .map(|s| s.get_inherited_text().white_space_collapse)
        .map(stylo_to_parley::white_space_collapse)
        .unwrap_or(WhiteSpaceCollapse::Collapse);
    builder.set_white_space_mode(collapse_mode);

    let text_transform = root_node_style
        .as_ref()
        .map(|s| s.clone_text_transform() & TextTransform::CASE_TRANSFORMS)
        .unwrap_or(TextTransform::NONE);

    // Render position-inside list items
    if let Some(ListItemLayout {
        marker,
        position: ListItemLayoutPosition::Inside,
    }) = root_node
        .element_data()
        .and_then(|el| el.list_item_data.as_deref())
    {
        match marker {
            // Bullet glyphs live in the bundled bullet font. The position-outside
            // path already asks for it; without the same span here a marker like
            // disclosure-closed (U+25B8) falls back to the element's own font and
            // renders as a missing glyph.
            Marker::Char(char) => {
                let mut marker_style = parley_style.clone();
                marker_style.font_family = BULLET_FONT_FAMILY.into();
                builder.push_style_span(marker_style);
                builder.push_text(&format!("{char} "));
                builder.pop_style_span();
            }
            Marker::String(str) => builder.push_text(str),
        }
    };

    if let Some(before_id) = root_node.before() {
        build_inline_layout_recursive(
            &mut builder,
            nodes,
            inline_context_root_node_id,
            before_id,
            collapse_mode,
            text_transform,
            root_line_height,
            scale,
        );
    }
    for child_id in root_node.children.iter().copied() {
        build_inline_layout_recursive(
            &mut builder,
            nodes,
            inline_context_root_node_id,
            child_id,
            collapse_mode,
            text_transform,
            root_line_height,
            scale,
        );
    }
    if let Some(after_id) = root_node.after() {
        build_inline_layout_recursive(
            &mut builder,
            nodes,
            inline_context_root_node_id,
            after_id,
            collapse_mode,
            text_transform,
            root_line_height,
            scale,
        );
    }

    text_layout.text = builder.build_into(&mut text_layout.layout);
    return;

    #[allow(clippy::too_many_arguments)]
    fn build_inline_layout_recursive(
        builder: &mut TreeBuilder<TextBrush>,
        nodes: &crate::NodeTree,
        parent_id: NodeId,
        node_id: NodeId,
        collapse_mode: WhiteSpaceCollapse,
        parent_text_transform: TextTransform,
        root_line_height: RootLineHeight,
        scale: f32,
    ) {
        let node = &nodes[node_id];

        // Set layout_parent for node.
        node.layout_parent.set(Some(parent_id));

        let style = node.primary_styles();
        let style = style.as_ref();

        // Set whitespace collapsing mode
        let collapse_mode = style
            .map(|s| s.clone_white_space_collapse())
            .map(stylo_to_parley::white_space_collapse)
            .unwrap_or(collapse_mode);
        builder.set_white_space_mode(collapse_mode);

        let text_transform = style
            .map(|s| s.clone_text_transform() & TextTransform::CASE_TRANSFORMS)
            .unwrap_or(TextTransform::NONE);

        match &node.data {
            NodeData::Element(element_data) | NodeData::AnonymousBlock(element_data) => {
                // if the input type is hidden, hide it
                if *element_data.name.local == *"input" {
                    if let Some("hidden") = element_data.attr(local_name!("type")) {
                        return;
                    }
                }

                let display = node.display_style().unwrap_or(Display::inline());
                let position = style
                    .map(|s| s.clone_position())
                    .unwrap_or(PositionProperty::Static);
                let float = style.map(|s| s.clone_float()).unwrap_or(Float::None);
                let box_kind = if position.is_absolutely_positioned() {
                    InlineBoxKind::OutOfFlow
                } else if float.is_floating() {
                    InlineBoxKind::CustomOutOfFlow
                } else {
                    InlineBoxKind::InFlow
                };

                match (display.outside(), display.inside()) {
                    (DisplayOutside::None, DisplayInside::None) => {
                        // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                    }
                    (DisplayOutside::None, DisplayInside::Contents) => {
                        for child_id in node.children.iter().copied() {
                            // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                            build_inline_layout_recursive(
                                builder,
                                nodes,
                                parent_id,
                                child_id,
                                collapse_mode,
                                text_transform,
                                root_line_height,
                                scale,
                            );
                        }
                    }
                    (DisplayOutside::Inline, DisplayInside::Flow) => {
                        let tag_name = &element_data.name.local;

                        if is_replaced_element(tag_name)
                            || *tag_name == local_name!("input")
                            || *tag_name == local_name!("textarea")
                            || *tag_name == local_name!("button")
                        {
                            builder.push_inline_box(InlineBox {
                                id: node_id.as_u64(),
                                kind: box_kind,
                                // Overridden by push_inline_box method
                                index: 0,
                                // Width and height are set during layout
                                width: 0.0,
                                height: 0.0,
                            });
                        } else if *tag_name == local_name!("br") {
                            // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                            // TODO: update span id for br spans
                            builder.push_style_modification_span(&[]);
                            builder.set_white_space_mode(WhiteSpaceCollapse::Preserve);
                            builder.push_text("\n");
                            builder.pop_style_span();
                            builder.set_white_space_mode(collapse_mode);
                        } else {
                            // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                            let mut style = node
                                .primary_styles()
                                .map(|s| stylo_to_parley::style(node.id, &s))
                                .unwrap_or_default();

                            // dbg!(&style);

                            let font_size = style.font_size;

                            // Floor the line-height of the span by the line-height of the inline context
                            // See https://www.w3.org/TR/CSS21/visudet.html#line-height
                            // PATCH: with both at `normal`, parley's per-run font metrics
                            // give the exact heights (no approximation).
                            let both_normal = matches!(
                                style.line_height,
                                parley::LineHeight::MetricsRelative(_)
                            ) && root_line_height.normal;
                            if !both_normal {
                                style.line_height = parley::LineHeight::Absolute(
                                    resolve_line_height(style.line_height, font_size)
                                        .max(root_line_height.px),
                                );
                            }

                            // dbg!(node_id);
                            // dbg!(&style);

                            builder.push_style_span(style);

                            // PATCH: reserve inline-start margin/border/padding.
                            let ((margin_start, edge_start), (edge_end, margin_end)) =
                                inline_edge_extents(node);
                            push_spacer(builder, INLINE_MARGIN_SPACER, node_id, margin_start * scale);
                            push_spacer(builder, INLINE_EDGE_SPACER, node_id, edge_start * scale);
                            // PATCH: an empty inline element still has a (zero-width) box
                            // at its position, e.g. for getClientRects() and
                            // IntersectionObserver sentinels (`<span x-intersect>`).
                            if node.children.is_empty()
                                && node.before().is_none()
                                && node.after().is_none()
                                && edge_start <= 0.0
                                && edge_end <= 0.0
                            {
                                builder.push_collapse_transparent_inline_box(InlineBox {
                                    id: INLINE_EDGE_SPACER | node_id.as_u64(),
                                    kind: InlineBoxKind::InFlow,
                                    index: 0,
                                    width: 0.0,
                                    height: 0.0,
                                });
                            }

                            if let Some(before_id) = node.before() {
                                build_inline_layout_recursive(
                                    builder,
                                    nodes,
                                    node_id,
                                    before_id,
                                    collapse_mode,
                                    text_transform,
                                    root_line_height,
                                    scale,
                                );
                            }

                            for child_id in node.children.iter().copied() {
                                build_inline_layout_recursive(
                                    builder,
                                    nodes,
                                    node_id,
                                    child_id,
                                    collapse_mode,
                                    text_transform,
                                    root_line_height,
                                    scale,
                                );
                            }
                            if let Some(after_id) = node.after() {
                                build_inline_layout_recursive(
                                    builder,
                                    nodes,
                                    node_id,
                                    after_id,
                                    collapse_mode,
                                    text_transform,
                                    root_line_height,
                                    scale,
                                );
                            }

                            // PATCH: reserve inline-end margin/border/padding.
                            push_spacer(builder, INLINE_EDGE_SPACER, node_id, edge_end * scale);
                            push_spacer(builder, INLINE_MARGIN_SPACER, node_id, margin_end * scale);

                            builder.pop_style_span();
                        }
                    }
                    // Inline box
                    (_, _) => {
                        builder.push_inline_box(InlineBox {
                            id: node_id.as_u64(),
                            kind: box_kind,
                            // Overridden by push_inline_box method
                            index: 0,
                            // Width and height are set during layout
                            width: 0.0,
                            height: 0.0,
                        });
                    }
                };
            }
            NodeData::Text(data) => {
                // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
                // dbg!(&data.content);

                // TODO: optimize case transforms to be non-allocating
                match parent_text_transform {
                    TextTransform::UPPERCASE => {
                        builder.push_text(&data.content.to_uppercase());
                    }
                    TextTransform::LOWERCASE => {
                        builder.push_text(&data.content.to_lowercase());
                    }
                    _ => {
                        builder.push_text(&data.content);
                    }
                }
            }
            NodeData::Comment { .. } => {
                // node.remove_damage(CONSTRUCT_DESCENDENT | CONSTRUCT_FC | CONSTRUCT_BOX);
            }
            NodeData::Document(_) => unreachable!(),
        }
    }
}
