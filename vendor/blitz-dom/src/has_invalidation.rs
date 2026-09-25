//! PATCH: `:has()` (relative selector) invalidation.
//!
//! Stylo records which elements a `:has()` anchor searched (selector flags) and ships the
//! invalidator, but the embedder has to run it whenever the DOM changes, just like Gecko's
//! glue (`Servo_StyleSet_MaybeInvalidateRelativeSelector*`), which this mirrors:
//!
//! - attribute / class / id / state changes are handled from the style snapshots right
//!   before the style traversal ([`invalidate_for_snapshots`]),
//! - insertions and removals are handled by the mutator as they happen
//!   ([`after_insert`], [`before_remove`]).
//!
//! Everything is gated on the selector flags Stylo sets while matching, so documents
//! without `:has()` rules pay only a flag check per mutation.

use std::marker::PhantomData;

use selectors::matching::ElementSelectorFlags;
use selectors::Element as _;
use style::context::QuirksMode;
use style::dom::{TElement, TNode};
use style::invalidation::element::invalidation_map::TSStateForInvalidation;
use style::invalidation::element::invalidator::{InvalidationResult, SiblingTraversalMap};
use style::invalidation::element::relative_selector::{
    DomMutationOperation, RelativeSelectorInvalidator,
};
use style::invalidation::element::restyle_hints::RestyleHint;
use style::selector_parser::SnapshotMap;
use style::stylist::Stylist;
use style::values::GenericAtomIdent;
use style::{Atom, LocalName};
use style_dom::ElementState;

use crate::node::{Node, NodeData};
use crate::{BaseDocument, NodeId};

const NTH_OF_FLAGS: ElementSelectorFlags = ElementSelectorFlags::HAS_SLOW_SELECTOR_NTH_OF;

fn invalidator<'a, 'b>(
    element: &'a Node,
    quirks_mode: QuirksMode,
    snapshots: Option<&'b SnapshotMap>,
    sibling_traversal_map: SiblingTraversalMap<&'a Node>,
) -> RelativeSelectorInvalidator<'a, 'b, &'a Node> {
    RelativeSelectorInvalidator {
        element,
        quirks_mode,
        snapshot_table: snapshots,
        invalidated: invalidated_at,
        sibling_traversal_map,
        _marker: PhantomData,
    }
}

/// Called by Stylo for every anchor whose style (or whose descendants'/siblings' styles)
/// the relative selector invalidation touched: make sure the traversal reaches them.
fn invalidated_at(element: &Node, result: &InvalidationResult) {
    if result.has_invalidated_siblings() {
        if let Some(parent) = TElement::traversal_parent(&element) {
            unsafe { TElement::set_dirty_descendants(&parent) };
        }
    } else if result.has_invalidated_descendants() {
        unsafe { TElement::set_dirty_descendants(&element) };
    } else if result.has_invalidated_self() {
        element.mark_ancestors_dirty();
        let parent_flags = TElement::traversal_parent(&element)
            .map_or(ElementSelectorFlags::empty(), |p| p.selector_flags().get());
        if parent_flags.intersects(NTH_OF_FLAGS) {
            restyle_siblings(element);
        }
    }
}

/// `:nth-child(An+B of S)`: a sibling's match may depend on this element.
fn restyle_siblings(element: &Node) {
    let Some(parent) = TElement::traversal_parent(&element) else {
        return;
    };
    for child in TNode::dom_children(&parent) {
        if let Some(child) = child.as_element() {
            if let Some(mut data) = child.mutate_data() {
                data.hint.insert(RestyleHint::restyle_subtree());
            }
        }
    }
    unsafe { TElement::set_dirty_descendants(&parent) };
}

fn element_of(doc: &BaseDocument, id: NodeId) -> Option<&Node> {
    let node = doc.get_node(id)?;
    (node.is_element() && node.flags.is_in_document()).then_some(node)
}

/// Whether any stylesheet that applies to `element` uses a relative selector at all.
fn any_relative_selectors(stylist: &Stylist, element: &Node) -> bool {
    let mut used = false;
    stylist.for_each_cascade_data_with_scope(element, |data, _| {
        used |= data.relative_invalidation_map_attributes().used;
    });
    used
}

fn search_direction(element: Option<&Node>) -> ElementSelectorFlags {
    element.map_or(ElementSelectorFlags::empty(), |e| {
        e.relative_selector_search_direction()
    })
}

fn inherit_search_direction(parent: Option<&Node>, prev_sibling: Option<&Node>) -> ElementSelectorFlags {
    search_direction(parent) & ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_ANCESTOR
        | search_direction(prev_sibling)
            & ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_ANCESTOR_SIBLING
}

/// Attribute, class, id and element state changes recorded in the snapshots since the
/// last style pass. Must run before the traversal consumes the snapshots.
pub(crate) fn invalidate_for_snapshots(doc: &BaseDocument) {
    if doc.snapshots.is_empty() {
        return;
    }
    let stylist = &doc.stylist;
    let quirks_mode = stylist.quirks_mode();
    let mut any_used: Option<bool> = None;
    for (opaque, snapshot) in doc.snapshots.iter() {
        let Some(element) = element_of(doc, NodeId::from_u64(opaque.id() as u64)) else {
            continue;
        };
        let searched = !element.relative_selector_search_direction().is_empty();
        let parent_nth_of = TElement::traversal_parent(&element)
            .is_some_and(|p| p.selector_flags().get().intersects(NTH_OF_FLAGS));
        if !searched && !parent_nth_of {
            continue;
        }
        if !*any_used.get_or_insert_with(|| any_relative_selectors(stylist, element))
            && !parent_nth_of
        {
            continue;
        }

        let changed_state = snapshot
            .state
            .map_or(ElementState::empty(), |old| old ^ element.state());
        let mut changed_ids: Vec<Atom> = Vec::new();
        let mut changed_classes: Vec<Atom> = Vec::new();
        let mut changed_attrs: Vec<LocalName> = Vec::new();
        if let Some(old_attrs) = snapshot.attrs.as_ref() {
            diff_attributes(
                element,
                old_attrs,
                &mut changed_ids,
                &mut changed_classes,
                &mut changed_attrs,
            );
        }
        if changed_state.is_empty() && changed_attrs.is_empty() {
            continue;
        }

        if parent_nth_of
            && stylist.any_applicable_rule_data(element, |data| {
                changed_ids
                    .iter()
                    .any(|id| data.might_have_nth_of_id_dependency(id))
                    || changed_classes
                        .iter()
                        .any(|c| data.might_have_nth_of_class_dependency(c))
                    || changed_attrs
                        .iter()
                        .any(|a| data.might_have_nth_of_attribute_dependency(a))
            })
        {
            restyle_siblings(element);
        }
        if !searched {
            continue;
        }

        invalidator(
            element,
            quirks_mode,
            Some(&doc.snapshots),
            SiblingTraversalMap::default(),
        )
        .invalidate_relative_selectors_for_this(
            stylist,
            |element, scope, data, quirks_mode, collector| {
                let map = data.relative_selector_invalidation_map();
                for id in &changed_ids {
                    for dep in map.id_to_selector.get(id, quirks_mode).into_iter().flatten() {
                        collector.add_dependency(dep, *element, scope);
                    }
                }
                for class in &changed_classes {
                    for dep in map
                        .class_to_selector
                        .get(class, quirks_mode)
                        .into_iter()
                        .flatten()
                    {
                        collector.add_dependency(dep, *element, scope);
                    }
                }
                for name in &changed_attrs {
                    for dep in map
                        .other_attribute_affecting_selectors
                        .get(name)
                        .into_iter()
                        .flatten()
                    {
                        collector.add_dependency(dep, *element, scope);
                    }
                }
                if !changed_state.is_empty() {
                    map.state_affecting_selectors.lookup_with_additional(
                        *element,
                        quirks_mode,
                        None,
                        &[],
                        changed_state,
                        |dep| {
                            if dep.state.intersects(changed_state) {
                                collector.add_dependency(&dep.dep, *element, scope);
                            }
                            true
                        },
                    );
                }
            },
        );
    }
}

/// Compares the snapshot's attributes with the element's current ones.
fn diff_attributes(
    element: &Node,
    old_attrs: &[(style::attr::AttrIdentifier, style::attr::AttrValue)],
    changed_ids: &mut Vec<Atom>,
    changed_classes: &mut Vec<Atom>,
    changed_attrs: &mut Vec<LocalName>,
) {
    use style::attr::AttrValue;
    let NodeData::Element(el) = &element.data else {
        return;
    };
    let old_value = |name: &markup5ever::LocalName| {
        old_attrs
            .iter()
            .find(|(ident, _)| &*ident.local_name == name)
            .map(|(_, v)| v)
    };
    for attr in el.attrs.iter() {
        let name = &attr.name.local;
        let unchanged = old_value(name).is_some_and(|old| &**old == attr.value.as_str());
        if !unchanged {
            changed_attrs.push(GenericAtomIdent(name.clone()));
        }
    }
    for (ident, _) in old_attrs {
        if !el.attrs.iter().any(|a| a.name.local == *ident.local_name) {
            changed_attrs.push(ident.local_name.clone());
        }
    }

    let id_name = markup5ever::local_name!("id");
    if changed_attrs.iter().any(|a| *a.0 == id_name) {
        if let Some(AttrValue::Atom(old)) = old_value(&id_name) {
            changed_ids.push(old.clone());
        }
        if let Some(new) = el.attr(id_name.clone()) {
            changed_ids.push(Atom::from(new));
        }
    }

    let class_name = markup5ever::local_name!("class");
    if changed_attrs.iter().any(|a| *a.0 == class_name) {
        let old: Vec<Atom> = match old_value(&class_name) {
            Some(AttrValue::TokenList(_, atoms)) => atoms.clone(),
            _ => Vec::new(),
        };
        let new: Vec<Atom> = el
            .attr(class_name.clone())
            .map(|v| v.split_ascii_whitespace().map(Atom::from).collect())
            .unwrap_or_default();
        for class in old.iter().filter(|c| !new.contains(c)) {
            changed_classes.push(class.clone());
        }
        for class in new.iter().filter(|c| !old.contains(c)) {
            changed_classes.push(class.clone());
        }
    }
}

fn ts_dependency(stylist: &Stylist, element: &Node, state: TSStateForInvalidation) {
    invalidator(
        element,
        stylist.quirks_mode(),
        None,
        SiblingTraversalMap::default(),
    )
    .invalidate_relative_selectors_for_this(stylist, |element, scope, data, quirks_mode, collector| {
        data.relative_invalidation_map_attributes()
            .ts_state_to_selector
            .lookup_with_additional(
                *element,
                quirks_mode,
                None,
                &[],
                ElementState::empty(),
                |dep| {
                    if dep.state.intersects(state) {
                        collector.add_dependency(&dep.dep, *element, scope);
                    }
                    true
                },
            );
    });
}

fn side_effects(stylist: &Stylist, prev: &Node, next: &Node) {
    let quirks_mode = stylist.quirks_mode();
    // Pretend `element` is not between `prev` and `next`.
    invalidator(
        prev,
        quirks_mode,
        None,
        SiblingTraversalMap::new(prev, prev.prev_sibling_element(), Some(next)),
    )
    .invalidate_relative_selectors_for_dom_mutation(
        false,
        stylist,
        ElementSelectorFlags::empty(),
        DomMutationOperation::SideEffectPrevSibling,
    );
    invalidator(
        next,
        quirks_mode,
        None,
        SiblingTraversalMap::new(next, Some(prev), next.next_sibling_element()),
    )
    .invalidate_relative_selectors_for_dom_mutation(
        false,
        stylist,
        ElementSelectorFlags::empty(),
        DomMutationOperation::SideEffectNextSibling,
    );
}

/// `:has(:empty)`, `:has(:first-child)`, ... on the parent / new edge siblings.
fn structural_changes(stylist: &Stylist, parent: Option<&Node>, element: &Node) {
    if let Some(parent) = parent {
        if !parent.relative_selector_search_direction().is_empty() {
            ts_dependency(stylist, parent, TSStateForInvalidation::EMPTY);
        }
    }
    if let Some(prev) = element.prev_sibling_element() {
        if !prev.relative_selector_search_direction().is_empty() {
            ts_dependency(stylist, prev, TSStateForInvalidation::NTH_EDGE_LAST);
        }
    }
    if let Some(next) = element.next_sibling_element() {
        if !next.relative_selector_search_direction().is_empty() {
            ts_dependency(stylist, next, TSStateForInvalidation::NTH_EDGE_FIRST);
        }
    }
}

/// A text (or comment) child of `node`'s parent appeared or disappeared: `:has(:empty)`.
fn child_text_changed(doc: &BaseDocument, node: &Node) {
    let Some(parent) = node.parent.and_then(|p| element_of(doc, p)) else {
        return;
    };
    if parent.relative_selector_search_direction().is_empty()
        || !any_relative_selectors(&doc.stylist, parent)
    {
        return;
    }
    ts_dependency(&doc.stylist, parent, TSStateForInvalidation::EMPTY);
}

/// A node was inserted into the document (call after the tree update).
pub(crate) fn after_insert(doc: &BaseDocument, node_id: NodeId) {
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    if !node.flags.is_in_document() {
        return;
    }
    if !node.is_element() {
        return child_text_changed(doc, node);
    }
    let element = node;
    let parent = TElement::traversal_parent(&element);
    // Cheap exits first: nothing on a `:has()` search path.
    let parent_direction = search_direction(parent);
    let prev = element.prev_sibling_element();
    if parent_direction.is_empty() && search_direction(prev).is_empty() {
        return;
    }
    let inherited = inherit_search_direction(parent, prev);
    if inherited.is_empty() || !any_relative_selectors(&doc.stylist, element) {
        return;
    }
    let stylist = &doc.stylist;
    if let (Some(prev), Some(next)) = (prev, element.next_sibling_element()) {
        if prev
            .relative_selector_search_direction()
            .intersects(ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_SIBLING)
        {
            element.apply_selector_flags(
                ElementSelectorFlags::RELATIVE_SELECTOR_SEARCH_DIRECTION_SIBLING,
            );
            side_effects(stylist, prev, next);
        }
    }
    structural_changes(stylist, parent, element);
    invalidator(
        element,
        stylist.quirks_mode(),
        None,
        SiblingTraversalMap::default(),
    )
    .invalidate_relative_selectors_for_dom_mutation(
        true,
        stylist,
        inherited,
        DomMutationOperation::Insert,
    );
}

/// A node is about to be removed from the document (call while it is still in the tree).
pub(crate) fn before_remove(doc: &BaseDocument, node_id: NodeId) {
    let Some(node) = doc.get_node(node_id) else {
        return;
    };
    if !node.flags.is_in_document() {
        return;
    }
    if !node.is_element() {
        return child_text_changed(doc, node);
    }
    let element = node;
    // An element that was never on a search path cannot change any `:has()` result.
    if element.relative_selector_search_direction().is_empty() {
        return;
    }
    if !any_relative_selectors(&doc.stylist, element) {
        return;
    }
    let parent = TElement::traversal_parent(&element);
    let prev = element.prev_sibling_element();
    let next = element.next_sibling_element();
    let inherited = inherit_search_direction(parent, prev);
    if inherited.is_empty() {
        return;
    }
    let stylist = &doc.stylist;
    if let (Some(prev), Some(next)) = (prev, next) {
        side_effects(stylist, prev, next);
    }
    invalidator(
        element,
        stylist.quirks_mode(),
        None,
        SiblingTraversalMap::default(),
    )
    .invalidate_relative_selectors_for_dom_mutation(
        true,
        stylist,
        inherited,
        DomMutationOperation::Remove,
    );
    // The parent may become `:empty`, the neighbours new first/last children.
    structural_changes(stylist, parent, element);
}
