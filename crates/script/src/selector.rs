//! Selector matching for the natives (`querySelector*`, `matches`, `closest`).
//!
//! [`LiveElement`] wraps a blitz node and delegates to blitz's `selectors::Element`
//! implementation, except for:
//! * pseudo-classes that depend on state blitz doesn't evaluate (`:checked` for options,
//!   `:indeterminate`, `:default`, `:disabled`/`:enabled` with fieldsets,
//!   `:placeholder-shown`, `:required`/`:optional`, `:read-only`/`:read-write`,
//!   `:valid`/`:invalid` (value missing), `:target`, `:focus-within`, `:open`,
//!   `:defined`, `:lang()`, `:in-range`/`:out-of-range`), evaluated from live form
//!   state;
//! * tree navigation: the DOM view (fragments are not elements, `<input>` internals are
//!   hidden), with sibling moves in O(1) when the index is known (blitz searches the
//!   parent's child list on every step);
//! * `is_html_element_in_html_document`, which is false for SVG/MathML so their
//!   camel-case names match.

use std::fmt;

use blitz_dom::node::NodeData;
use blitz_dom::{BaseDocument, Node, NodeId, local_name, ns};
use selectors::attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint};
use selectors::bloom::BloomFilter;
use selectors::matching::{ElementSelectorFlags, MatchingContext};
use selectors::{Element, OpaqueElement};
use style::selector_parser::{NonTSPseudoClass, SelectorImpl};

use crate::dom::{self, Kind};
use crate::forms;
use crate::state::RuntimeState;

type Impl = SelectorImpl;
type SImpl = <SelectorImpl as selectors::SelectorImpl>::LocalName;

const UNKNOWN: usize = usize::MAX;

#[derive(Clone, Copy)]
pub(crate) struct LiveElement<'a> {
    pub(crate) node: &'a Node,
    doc: &'a BaseDocument,
    st: &'a RuntimeState,
    /// Index of `node` in its parent's child list, if known.
    idx: usize,
}

impl fmt::Debug for LiveElement<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LiveElement({:?})", self.node.id)
    }
}

impl<'a> LiveElement<'a> {
    pub(crate) fn new(st: &'a RuntimeState, doc: &'a BaseDocument, node: &'a Node) -> Self {
        LiveElement {
            node,
            doc,
            st,
            idx: UNKNOWN,
        }
    }

    pub(crate) fn with_index(
        st: &'a RuntimeState,
        doc: &'a BaseDocument,
        node: &'a Node,
        idx: usize,
    ) -> Self {
        LiveElement { node, doc, st, idx }
    }

    fn wrap(&self, node: &'a Node, idx: usize) -> Self {
        LiveElement {
            node,
            doc: self.doc,
            st: self.st,
            idx,
        }
    }

    fn siblings(&self) -> Option<(&'a [NodeId], usize)> {
        let parent = self.doc.get_node(self.node.parent?)?;
        let kids = dom::dom_children(parent);
        let idx = if kids.get(self.idx) == Some(&self.node.id) {
            self.idx
        } else {
            kids.iter().position(|&c| c == self.node.id)?
        };
        Some((kids, idx))
    }

    fn element_at(&self, id: NodeId) -> Option<&'a Node> {
        self.doc
            .get_node(id)
            .filter(|n| n.is_element() && dom::kind(self.st, n) == Kind::Element)
    }

    /// Live evaluation of pseudo-classes blitz doesn't track; `None` = ask blitz.
    fn live_pseudo_class(&self, pc: &NonTSPseudoClass) -> Option<bool> {
        let el = self.node.element_data()?;
        let html = el.name.ns == ns!(html);
        let id = self.node.id;
        let (st, doc) = (self.st, self.doc);
        let local: &str = &el.name.local;
        let input_type = || forms::input_type(doc, id);
        Some(match pc {
            NonTSPseudoClass::Checked => {
                html && match local {
                    "input" => {
                        matches!(input_type().as_str(), "checkbox" | "radio")
                            && forms::get_checked(st, doc, id)
                    }
                    "option" => forms::option_selected(st, doc, id),
                    _ => false,
                }
            }
            NonTSPseudoClass::Indeterminate => {
                html && match local {
                    "input" => match input_type().as_str() {
                        "checkbox" => st.forms.borrow().indeterminate.contains(&id),
                        "radio" => {
                            !forms::get_checked(st, doc, id)
                                && !forms::radio_group(doc, id)
                                    .iter()
                                    .any(|&o| forms::get_checked(st, doc, o))
                        }
                        _ => false,
                    },
                    "progress" => !el.has_attr(local_name!("value")),
                    _ => false,
                }
            }
            NonTSPseudoClass::Default => {
                html && match local {
                    "input" => match input_type().as_str() {
                        "checkbox" | "radio" => el.has_attr(local_name!("checked")),
                        "submit" | "image" => is_default_button(doc, id),
                        _ => false,
                    },
                    "button" => forms::is_submit_button(doc, id) && is_default_button(doc, id),
                    "option" => el.has_attr(local_name!("selected")),
                    _ => false,
                }
            }
            NonTSPseudoClass::Disabled => {
                html && can_be_disabled(local) && forms::is_disabled(doc, id)
            }
            NonTSPseudoClass::Enabled => {
                html && can_be_disabled(local) && !forms::is_disabled(doc, id)
            }
            NonTSPseudoClass::PlaceholderShown => {
                html && el.has_attr(local_name!("placeholder"))
                    && (local == "textarea"
                        || (local == "input" && placeholder_applies(&input_type())))
                    && forms::get_value(st, doc, id).is_empty()
            }
            NonTSPseudoClass::Required => {
                html && is_requirable(local) && el.has_attr(local_name!("required"))
            }
            NonTSPseudoClass::Optional => {
                html && is_requirable(local) && !el.has_attr(local_name!("required"))
            }
            NonTSPseudoClass::ReadWrite => is_read_write(doc, self.node),
            NonTSPseudoClass::ReadOnly => !is_read_write(doc, self.node),
            NonTSPseudoClass::Valid | NonTSPseudoClass::Invalid => {
                let invalid = match local {
                    "input" | "select" | "textarea" if html => {
                        forms::suffers_value_missing(st, doc, id)
                    }
                    "form" | "fieldset" if html => dom::subtree(doc, id)
                        .into_iter()
                        .skip(1)
                        .any(|c| forms::suffers_value_missing(st, doc, c)),
                    _ => return Some(false),
                };
                if matches!(pc, NonTSPseudoClass::Invalid) {
                    invalid
                } else {
                    !invalid
                }
            }
            NonTSPseudoClass::Target => {
                let url = st.url.borrow();
                let frag = url.fragment().unwrap_or("");
                !frag.is_empty() && el.id.as_ref().is_some_and(|i| **i == *frag)
            }
            NonTSPseudoClass::FocusWithin => crate::activation::focused(doc)
                .is_some_and(|f| dom::is_inclusive_ancestor(doc, id, f)),
            NonTSPseudoClass::FocusVisible => crate::activation::focused(doc) == Some(id),
            NonTSPseudoClass::Open => {
                html && matches!(local, "details" | "dialog") && el.has_attr(local_name!("open"))
            }
            NonTSPseudoClass::Defined => true,
            NonTSPseudoClass::Lang(lang) => lang_matches(doc, self.node, lang),
            NonTSPseudoClass::InRange | NonTSPseudoClass::OutOfRange => {
                let Some(inside) = in_range(st, doc, self.node) else {
                    return Some(false);
                };
                if matches!(pc, NonTSPseudoClass::InRange) {
                    inside
                } else {
                    !inside
                }
            }
            _ => return None,
        })
    }
}

fn can_be_disabled(local: &str) -> bool {
    matches!(
        local,
        "button" | "input" | "select" | "textarea" | "fieldset" | "optgroup" | "option"
    )
}

fn is_requirable(local: &str) -> bool {
    matches!(local, "input" | "select" | "textarea")
}

fn placeholder_applies(ty: &str) -> bool {
    matches!(
        ty,
        "text" | "search" | "url" | "tel" | "email" | "password" | "number"
    )
}

fn is_default_button(doc: &BaseDocument, id: NodeId) -> bool {
    forms::form_owner(doc, id).is_some_and(|f| forms::default_button(doc, f) == Some(id))
}

/// `:read-write`: mutable text controls and editing hosts (and their contents).
fn is_read_write(doc: &BaseDocument, node: &Node) -> bool {
    let Some(el) = node.element_data() else {
        return false;
    };
    if el.name.ns == ns!(html) {
        let mutable = |d: &BaseDocument| {
            !el.has_attr(local_name!("readonly")) && !forms::is_disabled(d, node.id)
        };
        match &*el.name.local {
            "textarea" => return mutable(doc),
            "input" => {
                let ty = forms::input_type(doc, node.id);
                return matches!(
                    ty.as_str(),
                    "text"
                        | "search"
                        | "url"
                        | "tel"
                        | "email"
                        | "password"
                        | "date"
                        | "month"
                        | "week"
                        | "time"
                        | "datetime-local"
                        | "number"
                ) && mutable(doc);
            }
            _ => {}
        }
    }
    // contenteditable (inherited)
    for id in dom::inclusive_ancestors(doc, node.id) {
        if let Some(v) = dom::get_attr(doc, id, "contenteditable") {
            let v = v.trim();
            if v.is_empty()
                || v.eq_ignore_ascii_case("true")
                || v.eq_ignore_ascii_case("plaintext-only")
            {
                return true;
            }
            if v.eq_ignore_ascii_case("false") {
                return false;
            }
        }
    }
    false
}

/// `:lang(x)`: the element's language (nearest `lang` / `xml:lang`) is `x` or starts
/// with `x-` (ASCII case-insensitive; `*` matches any non-empty language).
fn lang_matches(doc: &BaseDocument, node: &Node, wanted: &str) -> bool {
    let mut lang: Option<&str> = None;
    for id in dom::inclusive_ancestors(doc, node.id) {
        if let Some(v) =
            dom::get_attr(doc, id, "xml:lang").or_else(|| dom::get_attr(doc, id, "lang"))
        {
            lang = Some(v);
            break;
        }
    }
    let Some(lang) = lang else { return false };
    let wanted = wanted.trim_matches('"');
    if wanted == "*" {
        return !lang.is_empty();
    }
    lang.len() >= wanted.len()
        && lang[..wanted.len()].eq_ignore_ascii_case(wanted)
        && (lang.len() == wanted.len() || lang.as_bytes()[wanted.len()] == b'-')
}

/// For number/range inputs with a `min` or `max`: is the value within them?
fn in_range(st: &RuntimeState, doc: &BaseDocument, node: &Node) -> Option<bool> {
    let el = node.element_data()?;
    if el.name.ns != ns!(html) || &*el.name.local != "input" {
        return None;
    }
    let ty = forms::input_type(doc, node.id);
    if !matches!(ty.as_str(), "number" | "range") {
        return None;
    }
    let min = el
        .attr(local_name!("min"))
        .and_then(|v| v.trim().parse::<f64>().ok());
    let max = el
        .attr(local_name!("max"))
        .and_then(|v| v.trim().parse::<f64>().ok());
    if ty == "number" && min.is_none() && max.is_none() {
        return None;
    }
    let Ok(v) = forms::get_value(st, doc, node.id).trim().parse::<f64>() else {
        return Some(true);
    };
    Some(min.is_none_or(|m| v >= m) && max.is_none_or(|m| v <= m))
}

impl<'a> Element for LiveElement<'a> {
    type Impl = Impl;

    fn opaque(&self) -> OpaqueElement {
        Element::opaque(&self.node)
    }

    fn parent_element(&self) -> Option<Self> {
        let parent = self.element_at(self.node.parent?)?;
        Some(self.wrap(parent, UNKNOWN))
    }

    fn parent_node_is_shadow_root(&self) -> bool {
        false
    }

    fn containing_shadow_host(&self) -> Option<Self> {
        None
    }

    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        let (kids, idx) = self.siblings()?;
        (0..idx)
            .rev()
            .find_map(|i| self.element_at(kids[i]).map(|n| self.wrap(n, i)))
    }

    fn next_sibling_element(&self) -> Option<Self> {
        let (kids, idx) = self.siblings()?;
        (idx + 1..kids.len()).find_map(|i| self.element_at(kids[i]).map(|n| self.wrap(n, i)))
    }

    fn first_element_child(&self) -> Option<Self> {
        let kids = dom::dom_children(self.node);
        kids.iter()
            .enumerate()
            .find_map(|(i, &c)| self.element_at(c).map(|n| self.wrap(n, i)))
    }

    fn is_html_element_in_html_document(&self) -> bool {
        self.node
            .element_data()
            .is_some_and(|e| e.name.ns == ns!(html))
    }

    fn has_local_name(
        &self,
        local_name: &<Impl as selectors::SelectorImpl>::BorrowedLocalName,
    ) -> bool {
        Element::has_local_name(&self.node, local_name)
    }

    fn has_namespace(&self, ns: &<Impl as selectors::SelectorImpl>::BorrowedNamespaceUrl) -> bool {
        Element::has_namespace(&self.node, ns)
    }

    fn is_same_type(&self, other: &Self) -> bool {
        Element::is_same_type(&self.node, &other.node)
    }

    fn attr_matches(
        &self,
        ns: &NamespaceConstraint<&<Impl as selectors::SelectorImpl>::NamespaceUrl>,
        local_name: &SImpl,
        operation: &AttrSelectorOperation<&<Impl as selectors::SelectorImpl>::AttrValue>,
    ) -> bool {
        Element::attr_matches(&self.node, ns, local_name, operation)
    }

    fn match_non_ts_pseudo_class(
        &self,
        pc: &NonTSPseudoClass,
        context: &mut MatchingContext<Impl>,
    ) -> bool {
        match self.live_pseudo_class(pc) {
            Some(r) => r,
            None => Element::match_non_ts_pseudo_class(&self.node, pc, context),
        }
    }

    fn match_pseudo_element(
        &self,
        pe: &<Impl as selectors::SelectorImpl>::PseudoElement,
        context: &mut MatchingContext<Impl>,
    ) -> bool {
        Element::match_pseudo_element(&self.node, pe, context)
    }

    fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

    fn is_link(&self) -> bool {
        Element::is_link(&self.node)
    }

    fn is_html_slot_element(&self) -> bool {
        false
    }

    fn has_id(
        &self,
        id: &<Impl as selectors::SelectorImpl>::Identifier,
        case_sensitivity: CaseSensitivity,
    ) -> bool {
        Element::has_id(&self.node, id, case_sensitivity)
    }

    fn has_class(
        &self,
        name: &<Impl as selectors::SelectorImpl>::Identifier,
        case_sensitivity: CaseSensitivity,
    ) -> bool {
        Element::has_class(&self.node, name, case_sensitivity)
    }

    fn has_custom_state(&self, _name: &<Impl as selectors::SelectorImpl>::Identifier) -> bool {
        false
    }

    fn imported_part(
        &self,
        _name: &<Impl as selectors::SelectorImpl>::Identifier,
    ) -> Option<<Impl as selectors::SelectorImpl>::Identifier> {
        None
    }

    fn is_part(&self, _name: &<Impl as selectors::SelectorImpl>::Identifier) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        dom::dom_children(self.node)
            .iter()
            .all(|&c| match self.doc.get_node(c).map(|n| &n.data) {
                Some(NodeData::Element(_)) => false,
                Some(NodeData::Text(t)) => t.content.is_empty(),
                _ => true,
            })
    }

    fn is_root(&self) -> bool {
        self.node
            .parent
            .and_then(|p| self.doc.get_node(p))
            .is_some_and(|p| matches!(p.data, NodeData::Document(_)))
    }

    fn add_element_unique_hashes(&self, filter: &mut BloomFilter) -> bool {
        Element::add_element_unique_hashes(&self.node, filter)
    }
}
