//! Tree, creation, mutation, attribute, content and selector natives.

use blitz_dom::node::NodeData;
use blitz_dom::{BaseDocument, NodeId, local_name};

use crate::cx::{Cx, JsErr, NResult};
use crate::dom::{self, Kind};
use crate::html;
use crate::selector::LiveElement;
use crate::state::RuntimeState;

fn kind(cx: &Cx, doc: &BaseDocument, id: NodeId) -> Kind {
    dom::kind_of(cx.st, doc, id)
}

pub(crate) fn n_document_id(cx: &mut Cx) -> NResult {
    if !cx.st.has_doc() {
        // Called while the JS layer loads (no document yet): a BaseDocument allocates its
        // document node first, which is the first slot of its slotmap (index 1, version 1;
        // slotmap reserves index 0).
        let first = NodeId::from_u64((1 << 32) | 1);
        cx.ret_f64(crate::cx::node_id_to_js(first).unwrap_or(0.0));
        return Ok(());
    }
    let doc = cx.st.doc()?;
    let id = doc.root_node().id;
    cx.ret_node(doc, Some(id));
    Ok(())
}

pub(crate) fn n_node_type(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let t = kind(cx, doc, id).node_type();
    cx.ret_i32(t as i32);
    Ok(())
}

pub(crate) fn n_local_name(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    if kind(cx, doc, id) != Kind::Element {
        cx.ret_str("");
        return Ok(());
    }
    let el = doc.get_node(id).unwrap().element_data().unwrap();
    let name: &str = &el.name.local;
    cx.ret_str(name);
    Ok(())
}

pub(crate) fn n_qualified_name(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    if kind(cx, doc, id) != Kind::Element {
        cx.ret_str("");
        return Ok(());
    }
    let name = dom::element_qname(doc.get_node(id).unwrap()).unwrap_or_default();
    cx.ret_str(&name);
    Ok(())
}

pub(crate) fn n_namespace_uri(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    if kind(cx, doc, id) != Kind::Element {
        cx.ret_str("");
        return Ok(());
    }
    let el = doc.get_node(id).unwrap().element_data().unwrap();
    let ns: &str = &el.name.ns;
    cx.ret_str(ns);
    Ok(())
}

pub(crate) fn n_parent(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let p = doc.get_node(id).and_then(|n| n.parent);
    cx.ret_node(doc, p);
    Ok(())
}

pub(crate) fn n_first_child(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let c = doc
        .get_node(id)
        .and_then(|n| dom::dom_children(n).first().copied());
    if let Some(c) = c {
        cx.st.sibling_hint(id).set((c, 0));
    }
    cx.ret_node(doc, c);
    Ok(())
}

pub(crate) fn n_last_child(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let kids = dom::dom_children(doc.get_node(id).unwrap());
    let c = kids.last().copied();
    if let Some(c) = c {
        cx.st.sibling_hint(id).set((c, kids.len() - 1));
    }
    cx.ret_node(doc, c);
    Ok(())
}

/// Index of `child` in its parent's child list, using the last-lookup hint so that
/// iterating siblings is O(1) per step.
fn sibling_index(st: &RuntimeState, doc: &BaseDocument, child: NodeId) -> Option<(NodeId, usize)> {
    let parent = doc.get_node(child)?.parent?;
    let kids = dom::dom_children(doc.get_node(parent)?);
    let (hint_id, hint_idx) = st.sibling_hint(parent).get();
    if hint_id == child && kids.get(hint_idx) == Some(&child) {
        return Some((parent, hint_idx));
    }
    kids.iter().position(|&c| c == child).map(|i| (parent, i))
}

pub(crate) fn n_next_sibling(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let next = sibling_index(cx.st, doc, id).and_then(|(p, i)| {
        let c = dom::dom_children(doc.get_node(p)?).get(i + 1).copied()?;
        cx.st.sibling_hint(p).set((c, i + 1));
        Some(c)
    });
    cx.ret_node(doc, next);
    Ok(())
}

pub(crate) fn n_prev_sibling(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let prev = sibling_index(cx.st, doc, id).and_then(|(p, i)| {
        if i == 0 {
            return None;
        }
        let c = dom::dom_children(doc.get_node(p)?).get(i - 1).copied()?;
        cx.st.sibling_hint(p).set((c, i - 1));
        Some(c)
    });
    cx.ret_node(doc, prev);
    Ok(())
}

pub(crate) fn n_child_ids(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let children: Vec<NodeId> = dom::dom_children(doc.get_node(id).unwrap()).to_vec();
    cx.ret_nodes(doc, &children);
    Ok(())
}

pub(crate) fn n_child_element_ids(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let children: Vec<NodeId> = dom::dom_children(doc.get_node(id).unwrap())
        .iter()
        .copied()
        .filter(|&c| doc.get_node(c).is_some_and(|n| n.is_element()))
        .collect();
    cx.ret_nodes(doc, &children);
    Ok(())
}

pub(crate) fn n_is_connected(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let c = dom::is_connected(doc, id);
    cx.ret_bool(c);
    Ok(())
}

pub(crate) fn n_contains(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let a = cx.node(doc, 0)?;
    let b = cx.opt_node(doc, 1)?;
    let r = b.is_some_and(|b| dom::is_inclusive_ancestor(doc, a, b));
    cx.ret_bool(r);
    Ok(())
}

pub(crate) fn n_compare_document_position(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let a = cx.node(doc, 0)?;
    let b = cx.node(doc, 1)?;
    let r = dom::compare_position(doc, a, b);
    cx.ret_i32(r as i32);
    Ok(())
}

// --- creation ---

pub(crate) fn n_create_element(cx: &mut Cx) -> NResult {
    let name = cx.string(0)?;
    let ns = cx.opt_string(1)?.unwrap_or_default();
    let doc = cx.st.doc()?;
    let id = dom::create_element(doc, &name, &ns)?;
    cx.ret_node(doc, Some(id));
    Ok(())
}

pub(crate) fn n_create_text(cx: &mut Cx) -> NResult {
    let data = cx.string(0)?;
    let doc = cx.st.doc()?;
    let id = dom::create_text(doc, &data);
    cx.ret_node(doc, Some(id));
    Ok(())
}

pub(crate) fn n_create_comment(cx: &mut Cx) -> NResult {
    let data = cx.string(0)?;
    let doc = cx.st.doc()?;
    let id = dom::create_comment(doc, &data);
    cx.ret_node(doc, Some(id));
    Ok(())
}

pub(crate) fn n_create_fragment(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = dom::create_fragment(cx.st, doc);
    cx.ret_node(doc, Some(id));
    Ok(())
}

pub(crate) fn n_clone_node(cx: &mut Cx) -> NResult {
    let deep = cx.bool(1);
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let c = dom::clone_node(cx.st, doc, id, deep)?;
    cx.ret_node(doc, Some(c));
    Ok(())
}

/// Addition: content fragment of a `<template>` element (created on demand).
pub(crate) fn n_template_content(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    if !dom::is_html_id(doc, id, &local_name!("template")) {
        cx.ret_i32(0);
        return Ok(());
    }
    let f = dom::template_content(cx.st, doc, id);
    cx.ret_node(doc, Some(f));
    Ok(())
}

/// Addition: `N.setShadowHost(id, isHost)`: `id` hosts an (emulated) shadow tree, so
/// stylesheets inside it are scoped to it (see `blitz_dom::shadow_css`).
pub(crate) fn n_set_shadow_host(cx: &mut Cx) -> NResult {
    let on = cx.bool(1);
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    if doc.get_node(id).is_some_and(|n| n.is_element()) {
        doc.set_shadow_host(id, on);
        cx.st.invalidate_layout();
    }
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.setDefined(id)`: the custom element `id` was upgraded (or created from
/// its definition), so CSS `:defined` matches it.
pub(crate) fn n_set_defined(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    doc.set_custom_element_defined(id);
    cx.st.invalidate_layout();
    cx.ret_undefined();
    Ok(())
}

/// Addition: `N.releaseNode(id)`: the JS layer dropped its wrapper for `id` (e.g. from a
/// `FinalizationRegistry`). The node stops counting as exposed, and its tree is freed if
/// it is detached from the document and no other node in it is exposed. Ids of freed
/// nodes become invalid (natives throw `TypeError`). Unknown ids are ignored.
pub(crate) fn n_release_node(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let Some(id) = crate::cx::node_id_from_js(cx.num(0)) else {
        cx.ret_undefined();
        return Ok(());
    };
    let Some(node) = doc.get_node_mut(id) else {
        cx.ret_undefined();
        return Ok(());
    };
    node.flags.remove(dom::EXPOSED);
    let root = *dom::inclusive_ancestors(doc, id).last().unwrap();
    let is_template_content = cx
        .st
        .template_contents
        .borrow()
        .values()
        .any(|&f| f == root);
    let freeable = root != doc.root_node().id
        && !is_template_content
        && !dom::subtree_exposed(doc, root)
        && !matches!(kind(cx, doc, root), Kind::Document | Kind::Anonymous);
    if freeable {
        let mut dropped = Vec::new();
        {
            let mut m = doc.mutate();
            m.remove_and_drop_node_with(root, &mut |d| dropped.push(d));
        }
        for d in dropped {
            dom::forget_node(cx.st, doc, d);
        }
    }
    cx.ret_undefined();
    Ok(())
}

// --- mutation ---

pub(crate) fn n_append_child(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let parent = cx.node(doc, 0)?;
    let child = cx.node(doc, 1)?;
    dom::insert(cx.st, doc, parent, child, None)?;
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_insert_before(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let parent = cx.node(doc, 0)?;
    let child = cx.node(doc, 1)?;
    let reference = cx.opt_node(doc, 2)?;
    dom::insert(cx.st, doc, parent, child, reference)?;
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_remove_child(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let parent = cx.node(doc, 0)?;
    let child = cx.node(doc, 1)?;
    dom::remove_child(cx.st, doc, parent, child)?;
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_replace_child(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let parent = cx.node(doc, 0)?;
    let new = cx.node(doc, 1)?;
    let old = cx.node(doc, 2)?;
    dom::replace_child(cx.st, doc, parent, new, old)?;
    cx.ret_undefined();
    Ok(())
}

// --- attributes ---

pub(crate) fn n_get_attr(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    match dom::get_attr(doc, id, &name) {
        Some(v) => {
            let v = v.to_string();
            cx.ret_str(&v);
        }
        None => cx.ret_null(),
    }
    Ok(())
}

pub(crate) fn n_set_attr(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let value = cx.string(2)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    dom::set_attr(cx.st, doc, id, &name, &value)?;
    if name == "style" || name == "class" || name == "id" {
        cx.st.host.request_redraw();
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_remove_attr(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    dom::remove_attr(cx.st, doc, id, &name);
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_has_attr(cx: &mut Cx) -> NResult {
    let name = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let r = dom::get_attr(doc, id, &name).is_some();
    cx.ret_bool(r);
    Ok(())
}

pub(crate) fn n_attr_names(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let names: Vec<String> = match doc.get_node(id).and_then(|n| n.element_data()) {
        Some(el) => el
            .attrs
            .iter()
            .map(|a| dom::attr_qname(a).into_owned())
            .collect(),
        None => Vec::new(),
    };
    cx.ret_strs(&names);
    Ok(())
}

// --- character data / content ---

pub(crate) fn n_get_text(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let text = match &doc.get_node(id).unwrap().data {
        NodeData::Text(t) => t.content.clone(),
        NodeData::Comment { contents } => contents.clone(),
        _ => String::new(),
    };
    cx.ret_str(&text);
    Ok(())
}

pub(crate) fn n_set_text(cx: &mut Cx) -> NResult {
    let data = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    match kind(cx, doc, id) {
        Kind::Text | Kind::Comment => dom::set_char_data(cx.st, doc, id, &data),
        _ => return Err(JsErr::type_err("not a character data node")),
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_text_content(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let mut s = String::new();
    match &doc.get_node(id).unwrap().data {
        NodeData::Comment { contents } => s.push_str(contents),
        _ => dom::descendant_text(doc, id, &mut s),
    }
    cx.ret_str(&s);
    Ok(())
}

pub(crate) fn n_set_text_content(cx: &mut Cx) -> NResult {
    let text = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    match kind(cx, doc, id) {
        Kind::Text | Kind::Comment => dom::set_char_data(cx.st, doc, id, &text),
        Kind::Element | Kind::Fragment => {
            let new: Vec<NodeId> = if text.is_empty() {
                Vec::new()
            } else {
                vec![dom::create_text(doc, &text)]
            };
            dom::replace_all_children(cx.st, doc, id, &new);
        }
        _ => {}
    }
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_inner_html(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let mut out = String::new();
    html::serialize_children(cx.st, doc, id, &mut out);
    cx.ret_str(&out);
    Ok(())
}

pub(crate) fn n_set_inner_html(cx: &mut Cx) -> NResult {
    let markup = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let k = kind(cx, doc, id);
    if !matches!(k, Kind::Element | Kind::Fragment) {
        return Err(JsErr::dom(
            "NoModificationAllowedError",
            "cannot set innerHTML on this node",
        ));
    }
    let target = if dom::is_html_id(doc, id, &local_name!("template")) {
        dom::template_content(cx.st, doc, id)
    } else {
        id
    };
    let context = html::context_name_for(cx.st, doc, id);
    let nodes = html::parse_fragment(cx.st, doc, context, &markup);
    dom::replace_all_children(cx.st, doc, target, &nodes);
    cx.st.host.request_redraw();
    cx.ret_undefined();
    Ok(())
}

pub(crate) fn n_outer_html(cx: &mut Cx) -> NResult {
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let mut out = String::new();
    html::serialize_node(cx.st, doc, id, &mut out);
    cx.ret_str(&out);
    Ok(())
}

/// `N.parseHTMLFragment(html, contextIdOr0?)` -> new fragment id.
pub(crate) fn n_parse_html_fragment(cx: &mut Cx) -> NResult {
    let markup = cx.string(0)?;
    let doc = cx.st.doc()?;
    let context = match cx.opt_node(doc, 1)? {
        Some(c) => html::context_name_for(cx.st, doc, c),
        None => html::context_name_for(cx.st, doc, NodeId::default()),
    };
    let nodes = html::parse_fragment(cx.st, doc, context, &markup);
    let frag = dom::create_fragment(cx.st, doc);
    if !nodes.is_empty() {
        let mut m = doc.mutate();
        m.append_children(frag, &nodes);
    }
    cx.ret_node(doc, Some(frag));
    Ok(())
}

/// Addition: `N.parseHTMLDocument(html)` -> id of a new detached fragment holding the
/// parsed document's children (`<html>` with `<head>` and `<body>`).
pub(crate) fn n_parse_html_document(cx: &mut Cx) -> NResult {
    let markup = cx.string(0)?;
    let doc = cx.st.doc()?;
    let frag = html::parse_document(cx.st, doc, &markup);
    cx.ret_node(doc, Some(frag));
    Ok(())
}

// --- selectors ---

fn selector_list(
    st: &RuntimeState,
    doc: &BaseDocument,
    sel: &str,
) -> Result<blitz_dom::SelectorList, JsErr> {
    if let Some(l) = st.selector_cache.borrow().get(sel) {
        return Ok(l.clone());
    }
    let list = parse_dom_selector_list(doc, sel)
        .ok_or_else(|| JsErr::dom("SyntaxError", format!("'{sel}' is not a valid selector")))?;
    let mut cache = st.selector_cache.borrow_mut();
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(sel.to_string(), list.clone());
    Ok(list)
}

/// Parse a selector list for the DOM selector APIs (`querySelector*`, `matches`,
/// `closest`). Stylo's Servo parser disables `:has()` and `:nth-child(An+B of S)` (they
/// need style invalidation support); for one-off matching against the live tree they
/// work, so this parser enables them and delegates everything else.
fn parse_dom_selector_list(doc: &BaseDocument, sel: &str) -> Option<blitz_dom::SelectorList> {
    use style::selector_parser::SelectorParser;
    use style::stylesheets::{Namespaces, Origin, UrlExtraData};
    let namespaces = Namespaces::default();
    let url_data = UrlExtraData::from(doc.url().clone());
    let parser = DomSelectorParser(SelectorParser {
        stylesheet_origin: Origin::Author,
        namespaces: &namespaces,
        url_data: &url_data,
        for_supports_rule: false,
    });
    let mut input = cssparser::ParserInput::new(sel);
    selectors::SelectorList::parse(
        &parser,
        &mut cssparser::Parser::new(&mut input),
        selectors::parser::ParseRelative::No,
    )
    .ok()
}

struct DomSelectorParser<'a>(style::selector_parser::SelectorParser<'a>);

impl<'a, 'i> selectors::parser::Parser<'i> for DomSelectorParser<'a> {
    type Impl = style::selector_parser::SelectorImpl;
    type Error = style_traits::StyleParseErrorKind<'i>;

    fn parse_has(&self) -> bool {
        true
    }
    fn parse_nth_child_of(&self) -> bool {
        true
    }
    fn parse_is_and_where(&self) -> bool {
        self.0.parse_is_and_where()
    }
    fn parse_parent_selector(&self) -> bool {
        self.0.parse_parent_selector()
    }
    fn parse_part(&self) -> bool {
        self.0.parse_part()
    }
    fn parse_host(&self) -> bool {
        self.0.parse_host()
    }
    fn parse_slotted(&self) -> bool {
        self.0.parse_slotted()
    }
    fn allow_forgiving_selectors(&self) -> bool {
        self.0.allow_forgiving_selectors()
    }
    fn is_is_alias(&self, name: &str) -> bool {
        self.0.is_is_alias(name)
    }
    fn parse_non_ts_pseudo_class(
        &self,
        location: cssparser::SourceLocation,
        name: cssparser::CowRcStr<'i>,
    ) -> Result<
        style::selector_parser::NonTSPseudoClass,
        cssparser::ParseError<'i, Self::Error>,
    > {
        self.0.parse_non_ts_pseudo_class(location, name)
    }
    fn parse_non_ts_functional_pseudo_class<'t>(
        &self,
        name: cssparser::CowRcStr<'i>,
        parser: &mut cssparser::Parser<'i, 't>,
        after_part: bool,
    ) -> Result<
        style::selector_parser::NonTSPseudoClass,
        cssparser::ParseError<'i, Self::Error>,
    > {
        self.0.parse_non_ts_functional_pseudo_class(name, parser, after_part)
    }
    fn parse_pseudo_element(
        &self,
        location: cssparser::SourceLocation,
        name: cssparser::CowRcStr<'i>,
    ) -> Result<style::selector_parser::PseudoElement, cssparser::ParseError<'i, Self::Error>>
    {
        self.0.parse_pseudo_element(location, name)
    }
    fn parse_functional_pseudo_element<'t>(
        &self,
        name: cssparser::CowRcStr<'i>,
        arguments: &mut cssparser::Parser<'i, 't>,
    ) -> Result<style::selector_parser::PseudoElement, cssparser::ParseError<'i, Self::Error>>
    {
        self.0.parse_functional_pseudo_element(name, arguments)
    }
    fn default_namespace(&self) -> Option<style::Namespace> {
        self.0.default_namespace()
    }
    fn namespace_for_prefix(&self, prefix: &style::Prefix) -> Option<style::Namespace> {
        self.0.namespace_for_prefix(prefix)
    }
}

/// Selector matching over a subtree in tree order. blitz's `TNode::next_sibling`
/// searches the parent's child list linearly, which makes stylo's generic
/// `query_selector` traversal quadratic for wide nodes; we walk child vectors directly
/// and share one `MatchingContext` (and its nth-index caches) across candidates.
fn query(
    st: &RuntimeState,
    doc: &BaseDocument,
    scope: NodeId,
    list: &blitz_dom::SelectorList,
    first_only: bool,
    out: &mut Vec<NodeId>,
) {
    use selectors::matching::{
        MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags, SelectorCaches,
        matches_selector_list,
    };
    let Some(root) = doc.get_node(scope) else {
        return;
    };
    let mut caches = SelectorCaches::default();
    let mut ctx = MatchingContext::new(
        MatchingMode::Normal,
        None,
        &mut caches,
        style::context::QuirksMode::NoQuirks,
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    );
    if root.is_element() && dom::kind(st, root) == Kind::Element {
        ctx.scope_element = Some(selectors::Element::opaque(&root));
    }
    // Pre-order traversal with an explicit stack of (parent, next child index).
    let mut stack: smallvec::SmallVec<[(&blitz_dom::Node, usize); 32]> = smallvec::SmallVec::new();
    stack.push((root, 0));
    while let Some(top) = stack.last_mut() {
        let (parent, idx) = *top;
        let Some(&child_id) = dom::dom_children(parent).get(idx) else {
            stack.pop();
            continue;
        };
        top.1 += 1;
        let Some(child) = doc.get_node(child_id) else {
            continue;
        };
        if !child.is_element() {
            continue;
        }
        let el = LiveElement::with_index(st, doc, child, idx);
        if matches_selector_list(list, &el, &mut ctx) {
            out.push(child_id);
            if first_only {
                return;
            }
        }
        if !dom::dom_children(child).is_empty() {
            stack.push((child, 0));
        }
    }
}

/// A selector simple enough to match without the selector engine.
enum SimpleSelector<'a> {
    Class(&'a str),
    Tag(&'a str),
}

fn is_plain_ident(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && !b[0].is_ascii_digit()
        && !(b[0] == b'-' && b.get(1).is_some_and(|c| c.is_ascii_digit()))
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_')
}

/// `.class` and `tag` selectors (no escapes, combinators or pseudo-classes).
fn simple_selector(sel: &str) -> Option<SimpleSelector<'_>> {
    let sel = sel.trim();
    match sel.strip_prefix('.') {
        Some(class) => is_plain_ident(class).then_some(SimpleSelector::Class(class)),
        None => (is_plain_ident(sel) && sel.as_bytes()[0] != b'-').then_some(SimpleSelector::Tag(sel)),
    }
}

/// Whether the whitespace-separated token list `list` contains `token`.
fn has_token(list: &str, token: &str) -> bool {
    let hay = list.as_bytes();
    let is_ws = |c: u8| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c');
    let mut from = 0;
    while let Some(pos) = list[from..].find(token) {
        let start = from + pos;
        let end = start + token.len();
        if (start == 0 || is_ws(hay[start - 1])) && (end == hay.len() || is_ws(hay[end])) {
            return true;
        }
        from = start + 1;
    }
    false
}

/// PATCH: `query` for a [`SimpleSelector`]: the same traversal with a direct test per
/// element (the selector engine's per-element setup dominated `querySelectorAll('.x')`).
fn query_simple(
    doc: &BaseDocument,
    scope: NodeId,
    sel: &SimpleSelector,
    first_only: bool,
    out: &mut Vec<NodeId>,
) {
    let Some(root) = doc.get_node(scope) else {
        return;
    };
    let lower_tag = match sel {
        SimpleSelector::Tag(t) => t.to_ascii_lowercase(),
        SimpleSelector::Class(_) => String::new(),
    };
    let matches = |node: &blitz_dom::Node| -> bool {
        let Some(el) = node.element_data() else {
            return false;
        };
        match sel {
            SimpleSelector::Class(class) => el
                .attr(blitz_dom::local_name!("class"))
                .is_some_and(|list| has_token(list, class)),
            SimpleSelector::Tag(tag) => {
                if el.name.ns == blitz_dom::ns!(html) {
                    &*el.name.local == lower_tag.as_str()
                } else {
                    &*el.name.local == *tag
                }
            }
        }
    };
    let mut stack: smallvec::SmallVec<[(&blitz_dom::Node, usize); 32]> = smallvec::SmallVec::new();
    stack.push((root, 0));
    while let Some(top) = stack.last_mut() {
        let (parent, idx) = *top;
        let Some(&child_id) = dom::dom_children(parent).get(idx) else {
            stack.pop();
            continue;
        };
        top.1 += 1;
        let Some(child) = doc.get_node(child_id) else {
            continue;
        };
        if !child.is_element() {
            continue;
        }
        if matches(child) {
            out.push(child_id);
            if first_only {
                return;
            }
        }
        if !dom::dom_children(child).is_empty() {
            stack.push((child, 0));
        }
    }
}

/// `#ident` selectors (no escapes) can use the document's id map.
fn simple_id_selector(sel: &str) -> Option<&str> {
    let id = sel.trim().strip_prefix('#')?;
    let valid = !id.is_empty()
        && !id.as_bytes()[0].is_ascii_digit()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some(id)
}

pub(crate) fn n_query_selector(cx: &mut Cx) -> NResult {
    let sel = cx.string(1)?;
    let doc = cx.st.doc()?;
    let scope = cx.node(doc, 0)?;
    let list = selector_list(cx.st, doc, &sel)?;
    let k = kind(cx, doc, scope);
    if !matches!(k, Kind::Document | Kind::Element | Kind::Fragment) {
        cx.ret_node(doc, None);
        return Ok(());
    }
    if let Some(id) = simple_id_selector(&sel)
        && dom::is_connected(doc, scope)
    {
        if let Some(found) = doc.get_element_by_id(id) {
            if found != scope && dom::is_inclusive_ancestor(doc, scope, found) {
                cx.ret_node(doc, Some(found));
                return Ok(());
            }
        } else if k == Kind::Document {
            cx.ret_node(doc, None);
            return Ok(());
        }
    }
    let mut out = Vec::with_capacity(1);
    match simple_selector(&sel) {
        Some(simple) => query_simple(doc, scope, &simple, true, &mut out),
        None => query(cx.st, doc, scope, &list, true, &mut out),
    }
    cx.ret_node(doc, out.first().copied());
    Ok(())
}

pub(crate) fn n_query_selector_all(cx: &mut Cx) -> NResult {
    let sel = cx.string(1)?;
    let doc = cx.st.doc()?;
    let scope = cx.node(doc, 0)?;
    let list = selector_list(cx.st, doc, &sel)?;
    let mut out = Vec::new();
    if matches!(
        kind(cx, doc, scope),
        Kind::Document | Kind::Element | Kind::Fragment
    ) {
        match simple_selector(&sel) {
            Some(simple) => query_simple(doc, scope, &simple, false, &mut out),
            None => query(cx.st, doc, scope, &list, false, &mut out),
        }
    }
    cx.ret_nodes(doc, &out);
    Ok(())
}

fn matching_context_for<'c>(
    caches: &'c mut selectors::matching::SelectorCaches,
) -> selectors::matching::MatchingContext<'c, style::selector_parser::SelectorImpl> {
    use selectors::matching::{
        MatchingContext, MatchingForInvalidation, MatchingMode, NeedsSelectorFlags,
    };
    MatchingContext::new(
        MatchingMode::Normal,
        None,
        caches,
        style::context::QuirksMode::NoQuirks,
        NeedsSelectorFlags::No,
        MatchingForInvalidation::No,
    )
}

pub(crate) fn n_matches(cx: &mut Cx) -> NResult {
    use selectors::Element as _;
    let sel = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let list = selector_list(cx.st, doc, &sel)?;
    let r = kind(cx, doc, id) == Kind::Element && {
        let el = LiveElement::new(cx.st, doc, doc.get_node(id).unwrap());
        let mut caches = selectors::matching::SelectorCaches::default();
        let mut ctx = matching_context_for(&mut caches);
        ctx.scope_element = Some(el.opaque());
        selectors::matching::matches_selector_list(&list, &el, &mut ctx)
    };
    cx.ret_bool(r);
    Ok(())
}

pub(crate) fn n_closest(cx: &mut Cx) -> NResult {
    use selectors::Element as _;
    let sel = cx.string(1)?;
    let doc = cx.st.doc()?;
    let id = cx.node(doc, 0)?;
    let list = selector_list(cx.st, doc, &sel)?;
    let mut r = None;
    if kind(cx, doc, id) == Kind::Element {
        let node = doc.get_node(id).unwrap();
        let mut caches = selectors::matching::SelectorCaches::default();
        let mut ctx = matching_context_for(&mut caches);
        ctx.scope_element = Some(LiveElement::new(cx.st, doc, node).opaque());
        let mut cur = Some(id);
        while let Some(c) = cur {
            let Some(n) = doc.get_node(c) else { break };
            if kind(cx, doc, c) != Kind::Element {
                break;
            }
            if selectors::matching::matches_selector_list(
                &list,
                &LiveElement::new(cx.st, doc, n),
                &mut ctx,
            ) {
                r = Some(c);
                break;
            }
            cur = n.parent;
        }
    }
    cx.ret_node(doc, r);
    Ok(())
}

pub(crate) fn n_get_element_by_id(cx: &mut Cx) -> NResult {
    let wanted = cx.string(0)?;
    let doc = cx.st.doc()?;
    let r = if wanted.is_empty() {
        None
    } else {
        doc.get_element_by_id(&wanted)
    };
    cx.ret_node(doc, r);
    Ok(())
}
