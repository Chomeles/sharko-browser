//! DOM tree helpers on top of blitz: node classification, DocumentFragment emulation,
//! validated mutations, cloning, attributes and text content.

use std::borrow::Cow;

use blitz_dom::node::{Attribute, NodeData, NodeFlags};
use blitz_dom::{
    BaseDocument, LocalName, Namespace, Node, NodeId, Prefix, QualName, local_name, ns,
};
use smallvec::SmallVec;

use crate::cx::JsErr;
use crate::state::RuntimeState;

/// Flag bit set on nodes whose id has been handed to JS. Nodes that were never exposed
/// can be freed when they are removed by `innerHTML` / `textContent` replacement; exposed
/// nodes are only detached (JS may still reference and re-insert them).
pub(crate) const EXPOSED: NodeFlags = NodeFlags::from_bits_retain(1 << 30);

#[inline]
pub(crate) fn expose(doc: &mut BaseDocument, id: NodeId) {
    if let Some(n) = doc.get_node_mut(id) {
        n.flags.insert(EXPOSED);
    }
}

pub(crate) const HTML_NS: &str = "http://www.w3.org/1999/xhtml";
pub(crate) const SVG_NS: &str = "http://www.w3.org/2000/svg";
pub(crate) const MATHML_NS: &str = "http://www.w3.org/1998/Math/MathML";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Document,
    Element,
    Fragment,
    Text,
    Comment,
    /// Layout-internal node (never exposed).
    Anonymous,
}

impl Kind {
    pub(crate) fn node_type(self) -> u32 {
        match self {
            Kind::Element => 1,
            Kind::Text => 3,
            Kind::Comment => 8,
            Kind::Document => 9,
            Kind::Fragment => 11,
            Kind::Anonymous => 0,
        }
    }
    /// Can have children in the DOM sense.
    pub(crate) fn is_parent(self) -> bool {
        matches!(self, Kind::Document | Kind::Element | Kind::Fragment)
    }
}

#[inline]
pub(crate) fn kind(st: &RuntimeState, node: &Node) -> Kind {
    match &node.data {
        NodeData::Document(_) => Kind::Document,
        NodeData::Element(el) => {
            if el.name.local == st.fragment_atom {
                Kind::Fragment
            } else {
                Kind::Element
            }
        }
        NodeData::AnonymousBlock(_) => Kind::Anonymous,
        NodeData::Text(_) => Kind::Text,
        NodeData::Comment { .. } => Kind::Comment,
    }
}

#[inline]
pub(crate) fn kind_of(st: &RuntimeState, doc: &BaseDocument, id: NodeId) -> Kind {
    doc.get_node(id)
        .map(|n| kind(st, n))
        .unwrap_or(Kind::Anonymous)
}

/// Is `node` an HTML element with the given local name?
#[inline]
pub(crate) fn is_html(node: &Node, local: &LocalName) -> bool {
    node.element_data()
        .is_some_and(|el| el.name.local == *local && el.name.ns == ns!(html))
}

#[inline]
pub(crate) fn is_html_id(doc: &BaseDocument, id: NodeId, local: &LocalName) -> bool {
    doc.get_node(id).is_some_and(|n| is_html(n, local))
}

/// The DOM children of a node. Children blitz creates under an `<input>` (the label
/// text of button-like inputs, file-input widgets) are rendering internals: in the DOM
/// an input has no children, so every JS-visible traversal goes through this.
#[inline]
pub(crate) fn dom_children(node: &Node) -> &[NodeId] {
    if !node.children.is_empty() && is_html(node, &local_name!("input")) {
        &[]
    } else {
        &node.children
    }
}

/// Drop blitz's internal `<input>` children inside the detached subtree `root`, which is
/// about to be inserted into the document: blitz re-creates them on insertion and would
/// otherwise duplicate them (e.g. "GoGo" after moving a submit button).
fn strip_input_internals(doc: &mut BaseDocument, root: NodeId) {
    let mut stack: SmallVec<[NodeId; 32]> = SmallVec::new();
    let mut found: SmallVec<[NodeId; 4]> = SmallVec::new();
    stack.push(root);
    while let Some(id) = stack.pop() {
        let Some(n) = doc.get_node(id) else { continue };
        if n.children.is_empty() {
            continue;
        }
        if is_html(n, &local_name!("input")) {
            found.push(id);
        } else {
            stack.extend(n.children.iter().copied());
        }
    }
    for input in found {
        let children: SmallVec<[NodeId; 4]> = doc
            .get_node(input)
            .map(|n| n.children.iter().copied().collect())
            .unwrap_or_default();
        let mut m = doc.mutate();
        for c in children {
            m.remove_and_drop_node_with(c, &mut |_| {});
        }
    }
}

/// Before inserting `nodes` under `parent`: see [`strip_input_internals`].
fn prepare_insertion(doc: &mut BaseDocument, parent: NodeId, nodes: &[NodeId]) {
    if is_connected(doc, parent) {
        for &n in nodes {
            if !is_connected(doc, n) {
                strip_input_internals(doc, n);
            }
        }
    }
}

/// Keep the label of a connected `<input type=button|submit|reset>` in sync with its
/// `value` attribute (blitz only creates it when the input is inserted).
pub(crate) fn sync_input_label(doc: &mut BaseDocument, id: NodeId) {
    let Some(node) = doc.get_node(id) else { return };
    if !is_html(node, &local_name!("input")) || !node.flags.is_in_document() {
        return;
    }
    let el = node.element_data().unwrap();
    let ty = el.attr(local_name!("type"));
    if ty == Some("file") {
        return; // blitz's file-input widgets (when that feature is enabled)
    }
    let label = match ty {
        Some("button" | "submit" | "reset") => el.attr(local_name!("value")),
        _ => None,
    };
    let current: SmallVec<[NodeId; 2]> = node.children.iter().copied().collect();
    if let (Some(label), [only]) = (label, &current[..])
        && doc
            .get_node(*only)
            .and_then(|n| n.text_data())
            .is_some_and(|t| t.content == label)
    {
        return;
    }
    if label.is_none() && current.is_empty() {
        return;
    }
    let label = label.map(str::to_owned);
    let mut m = doc.mutate();
    for c in current {
        m.remove_and_drop_node_with(c, &mut |_| {});
    }
    if let Some(label) = label {
        let t = m.create_text_node(&label);
        m.append_children(id, &[t]);
    }
}

/// Is `ancestor` an inclusive ancestor of `node`?
pub(crate) fn is_inclusive_ancestor(doc: &BaseDocument, ancestor: NodeId, node: NodeId) -> bool {
    let mut cur = Some(node);
    while let Some(id) = cur {
        if id == ancestor {
            return true;
        }
        cur = doc.get_node(id).and_then(|n| n.parent);
    }
    false
}

/// The node and its ancestors, from `id` up to the root.
pub(crate) fn inclusive_ancestors(doc: &BaseDocument, id: NodeId) -> SmallVec<[NodeId; 32]> {
    let mut out = SmallVec::new();
    let mut cur = Some(id);
    while let Some(i) = cur {
        out.push(i);
        cur = doc.get_node(i).and_then(|n| n.parent);
    }
    out
}

/// Is the node connected to the document tree?
#[inline]
pub(crate) fn is_connected(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id).is_some_and(|n| n.flags.is_in_document())
}

/// Does the subtree rooted at `id` contain a node that was exposed to JS?
pub(crate) fn subtree_exposed(doc: &BaseDocument, id: NodeId) -> bool {
    let mut stack: SmallVec<[NodeId; 32]> = SmallVec::new();
    stack.push(id);
    while let Some(i) = stack.pop() {
        let Some(n) = doc.get_node(i) else { continue };
        if n.flags.contains(EXPOSED) {
            return true;
        }
        stack.extend(n.children.iter().copied());
    }
    false
}

/// Descendant text (DOM `textContent` for elements, fragments and documents).
pub(crate) fn descendant_text(doc: &BaseDocument, id: NodeId, out: &mut String) {
    let Some(node) = doc.get_node(id) else { return };
    match &node.data {
        NodeData::Text(t) => out.push_str(&t.content),
        NodeData::Comment { .. } => {}
        _ => {
            let mut stack: SmallVec<[(NodeId, usize); 32]> = SmallVec::new();
            stack.push((id, 0));
            while let Some((nid, idx)) = stack.pop() {
                let Some(n) = doc.get_node(nid) else { continue };
                if let Some(&child) = dom_children(n).get(idx) {
                    stack.push((nid, idx + 1));
                    if let Some(c) = doc.get_node(child) {
                        match &c.data {
                            NodeData::Text(t) => out.push_str(&t.content),
                            NodeData::Comment { .. } => {}
                            _ => stack.push((child, 0)),
                        }
                    }
                }
            }
        }
    }
}

/// Text of the direct Text children (the "child text content").
pub(crate) fn child_text(doc: &BaseDocument, id: NodeId) -> String {
    let mut s = String::new();
    if let Some(n) = doc.get_node(id) {
        for &c in n.children.iter() {
            if let Some(NodeData::Text(t)) = doc.get_node(c).map(|n| &n.data) {
                s.push_str(&t.content);
            }
        }
    }
    s
}

// ---------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------

fn namespace_for(ns_uri: &str) -> Namespace {
    match ns_uri {
        "" | HTML_NS => ns!(html),
        SVG_NS => ns!(svg),
        MATHML_NS => ns!(mathml),
        other => Namespace::from(other),
    }
}

/// Create a detached element. `ns_uri == ""` means the HTML namespace.
pub(crate) fn create_element(
    doc: &mut BaseDocument,
    qualified: &str,
    ns_uri: &str,
) -> Result<NodeId, JsErr> {
    if qualified.is_empty()
        || qualified.starts_with('#')
        || qualified.contains(['<', '>', ' ', '\t', '\n', '/', '\0'])
    {
        return Err(JsErr::dom(
            "InvalidCharacterError",
            format!("'{qualified}' is not a valid element name"),
        ));
    }
    let ns = namespace_for(ns_uri);
    let (prefix, local) = match qualified.split_once(':') {
        Some((p, l)) if !ns_uri.is_empty() && !p.is_empty() && !l.is_empty() => {
            (Some(Prefix::from(p)), l)
        }
        _ => (None, qualified),
    };
    let name = QualName::new(prefix, ns, LocalName::from(local));
    let mut m = doc.mutate();
    Ok(m.create_element(name, Vec::new()))
}

pub(crate) fn create_fragment(st: &RuntimeState, doc: &mut BaseDocument) -> NodeId {
    let name = QualName::new(None, ns!(html), st.fragment_atom.clone());
    let mut m = doc.mutate();
    m.create_element(name, Vec::new())
}

pub(crate) fn create_text(doc: &mut BaseDocument, text: &str) -> NodeId {
    doc.create_text_node(text)
}

pub(crate) fn create_comment(doc: &mut BaseDocument, text: &str) -> NodeId {
    let mut m = doc.mutate();
    m.create_comment_node(text)
}

/// The content fragment of a `<template>` element, created on first use by moving the
/// template's (parser-inserted) children into it. Until then template contents are
/// ordinary children of the template element (blitz-html's parsing model, which the JS
/// layer also expects).
pub(crate) fn template_content(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    template: NodeId,
) -> NodeId {
    if let Some(&f) = st.template_contents.borrow().get(&template)
        && doc.get_node(f).is_some()
    {
        return f;
    }
    let f = create_fragment(st, doc);
    let children: Vec<NodeId> = doc
        .get_node(template)
        .map(|n| n.children.to_vec())
        .unwrap_or_default();
    if !children.is_empty() {
        let mut m = doc.mutate();
        m.append_children(f, &children);
    }
    st.template_contents.borrow_mut().insert(template, f);
    f
}

/// The node whose children hold a template's contents: its content fragment if one was
/// created, else the template itself.
pub(crate) fn template_container(st: &RuntimeState, template: NodeId) -> NodeId {
    st.template_contents
        .borrow()
        .get(&template)
        .copied()
        .unwrap_or(template)
}

// ---------------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------------

/// DOM "ensure pre-insertion validity".
pub(crate) fn ensure_pre_insert(
    st: &RuntimeState,
    doc: &BaseDocument,
    parent: NodeId,
    node: NodeId,
    child: Option<NodeId>,
) -> Result<(), JsErr> {
    let pk = kind_of(st, doc, parent);
    if !pk.is_parent() {
        return Err(JsErr::hierarchy("the parent cannot have children"));
    }
    if is_inclusive_ancestor(doc, node, parent) {
        return Err(JsErr::hierarchy(
            "the new child is an ancestor of the parent",
        ));
    }
    if let Some(c) = child
        && doc.get_node(c).and_then(|n| n.parent) != Some(parent)
    {
        return Err(JsErr::not_found(
            "the reference node is not a child of the parent",
        ));
    }
    let nk = kind_of(st, doc, node);
    match nk {
        Kind::Document | Kind::Anonymous => {
            return Err(JsErr::hierarchy("the node cannot be inserted"));
        }
        Kind::Text if pk == Kind::Document => {
            return Err(JsErr::hierarchy(
                "cannot insert a text node into a document",
            ));
        }
        _ => {}
    }
    if pk == Kind::Document {
        let parent_has_element = doc.get_node(parent).is_some_and(|p| {
            p.children
                .iter()
                .any(|&c| c != node && doc.get_node(c).is_some_and(|n| n.is_element()))
        });
        let inserting_elements = match nk {
            Kind::Element => 1,
            Kind::Fragment => {
                let n = doc.get_node(node).unwrap();
                if n.children
                    .iter()
                    .any(|&c| doc.get_node(c).is_some_and(|c| c.is_text_node()))
                {
                    return Err(JsErr::hierarchy("cannot insert text into a document"));
                }
                n.children
                    .iter()
                    .filter(|&&c| doc.get_node(c).is_some_and(|n| n.is_element()))
                    .count()
            }
            _ => 0,
        };
        if inserting_elements > 1 || (inserting_elements == 1 && parent_has_element) {
            return Err(JsErr::hierarchy(
                "a document can only have one element child",
            ));
        }
    }
    Ok(())
}

/// The nodes actually inserted for `node`: a fragment's children, else the node.
fn insertion_list(st: &RuntimeState, doc: &BaseDocument, node: NodeId) -> SmallVec<[NodeId; 8]> {
    match doc.get_node(node) {
        Some(n) if kind(st, n) == Kind::Fragment => n.children.iter().copied().collect(),
        Some(_) => smallvec::smallvec![node],
        None => SmallVec::new(),
    }
}

/// DOM `insertBefore` / `appendChild` (with fragment semantics).
pub(crate) fn insert(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    parent: NodeId,
    node: NodeId,
    child: Option<NodeId>,
) -> Result<(), JsErr> {
    ensure_pre_insert(st, doc, parent, node, child)?;
    let mut child = child;
    if child == Some(node) {
        child = doc.get_node(node).and_then(|n| next_sibling(doc, n));
    }
    let nodes = insertion_list(st, doc, node);
    if nodes.is_empty() {
        return Ok(());
    }
    let old_parent = doc.get_node(node).and_then(|n| n.parent);
    prepare_insertion(doc, parent, &nodes);
    {
        let mut m = doc.mutate();
        match child {
            Some(c) => m.insert_nodes_before(c, &nodes),
            None => m.append_children(parent, &nodes),
        }
    }
    st.invalidate_layout();
    children_changed(st, doc, parent);
    if let Some(op) = old_parent
        && op != parent
    {
        children_changed(st, doc, op);
    }
    Ok(())
}

pub(crate) fn remove_child(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    parent: NodeId,
    child: NodeId,
) -> Result<(), JsErr> {
    if doc.get_node(child).and_then(|n| n.parent) != Some(parent) {
        return Err(JsErr::not_found(
            "the node to be removed is not a child of this node",
        ));
    }
    {
        let mut m = doc.mutate();
        m.remove_node(child);
    }
    st.invalidate_layout();
    children_changed(st, doc, parent);
    Ok(())
}

pub(crate) fn replace_child(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    parent: NodeId,
    new: NodeId,
    old: NodeId,
) -> Result<(), JsErr> {
    let pk = kind_of(st, doc, parent);
    if !pk.is_parent() {
        return Err(JsErr::hierarchy("the parent cannot have children"));
    }
    if is_inclusive_ancestor(doc, new, parent) {
        return Err(JsErr::hierarchy(
            "the new child is an ancestor of the parent",
        ));
    }
    if doc.get_node(old).and_then(|n| n.parent) != Some(parent) {
        return Err(JsErr::not_found(
            "the node to be replaced is not a child of this node",
        ));
    }
    if new == old {
        return Ok(());
    }
    let nk = kind_of(st, doc, new);
    if matches!(nk, Kind::Document | Kind::Anonymous) || (nk == Kind::Text && pk == Kind::Document)
    {
        return Err(JsErr::hierarchy("the node cannot be inserted here"));
    }
    if pk == Kind::Document && matches!(nk, Kind::Element | Kind::Fragment) {
        let other_elements = doc.get_node(parent).is_some_and(|p| {
            p.children
                .iter()
                .any(|&c| c != old && c != new && doc.get_node(c).is_some_and(|n| n.is_element()))
        });
        if other_elements {
            return Err(JsErr::hierarchy(
                "a document can only have one element child",
            ));
        }
    }
    let nodes = insertion_list(st, doc, new);
    let old_parent = doc.get_node(new).and_then(|n| n.parent);
    prepare_insertion(doc, parent, &nodes);
    {
        let mut m = doc.mutate();
        if !nodes.is_empty() {
            m.insert_nodes_before(old, &nodes);
        }
        m.remove_node(old);
    }
    st.invalidate_layout();
    children_changed(st, doc, parent);
    if let Some(op) = old_parent
        && op != parent
    {
        children_changed(st, doc, op);
    }
    Ok(())
}

/// Remove all children of `parent` and append `new_children` (which must be detached or
/// movable). Removed subtrees that were never exposed to JS are freed.
pub(crate) fn replace_all_children(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    parent: NodeId,
    new_children: &[NodeId],
) {
    let old: Vec<NodeId> = doc
        .get_node(parent)
        .map(|n| n.children.to_vec())
        .unwrap_or_default();
    prepare_insertion(doc, parent, new_children);
    let mut dropped: Vec<NodeId> = Vec::new();
    {
        let mut m = doc.mutate();
        for c in old {
            if subtree_exposed(m.doc, c) {
                m.remove_node(c);
            } else {
                m.remove_and_drop_node_with(c, &mut |id| dropped.push(id));
            }
        }
        if !new_children.is_empty() {
            m.append_children(parent, new_children);
        }
    }
    for id in dropped {
        forget_node(st, doc, id);
    }
    st.invalidate_layout();
    children_changed(st, doc, parent);
}

/// Clean up runtime side tables for a node that was freed.
pub(crate) fn forget_node(st: &RuntimeState, doc: &mut BaseDocument, id: NodeId) {
    st.forms.borrow_mut().forget(id);
    let content = st.template_contents.borrow_mut().remove(&id);
    if let Some(frag) = content
        && doc.get_node(frag).is_some()
        && !subtree_exposed(doc, frag)
    {
        let mut dropped = Vec::new();
        {
            let mut m = doc.mutate();
            m.remove_and_drop_node_with(frag, &mut |d| dropped.push(d));
        }
        for d in dropped {
            if d != frag {
                forget_node(st, doc, d);
            }
        }
    }
}

/// Hook run after the child list (or child text) of `parent` changed.
pub(crate) fn children_changed(st: &RuntimeState, doc: &mut BaseDocument, parent: NodeId) {
    if is_html_id(doc, parent, &local_name!("textarea")) {
        crate::forms::sync_textarea_default(st, doc, parent);
    }
}

pub(crate) fn next_sibling(doc: &BaseDocument, node: &Node) -> Option<NodeId> {
    let parent = doc.get_node(node.parent?)?;
    let idx = parent.index_of_child(node.id)?;
    parent.children.get(idx + 1).copied()
}

/// Set the data of a Text or Comment node.
pub(crate) fn set_char_data(st: &RuntimeState, doc: &mut BaseDocument, id: NodeId, data: &str) {
    let parent = doc.get_node(id).and_then(|n| n.parent);
    let is_text = doc.get_node(id).is_some_and(|n| n.is_text_node());
    if is_text {
        let mut m = doc.mutate();
        m.set_node_text(id, data);
    } else if let Some(NodeData::Comment { contents }) = doc.get_node_mut(id).map(|n| &mut n.data) {
        contents.clear();
        contents.push_str(data);
    }
    st.invalidate_layout();
    if let Some(p) = parent {
        children_changed(st, doc, p);
    }
}

// ---------------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------------

fn clone_one(st: &RuntimeState, doc: &mut BaseDocument, src: NodeId) -> Option<NodeId> {
    let node = doc.get_node(src)?;
    let new = match &node.data {
        NodeData::Text(t) => {
            let text = t.content.clone();
            doc.create_text_node(&text)
        }
        NodeData::Comment { contents } => {
            let c = contents.clone();
            create_comment(doc, &c)
        }
        NodeData::Element(el) => {
            let name = el.name.clone();
            let attrs: Vec<Attribute> = el.attrs.to_vec();
            let mut m = doc.mutate();
            m.create_element(name, attrs)
        }
        _ => return None,
    };
    crate::forms::copy_clone_state(st, doc, src, new);
    Some(new)
}

/// DOM `cloneNode(deep)`. Template contents are cloned with deep clones.
pub(crate) fn clone_node(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    deep: bool,
) -> Result<NodeId, JsErr> {
    if kind_of(st, doc, id) == Kind::Document {
        return Err(JsErr::dom("NotSupportedError", "cannot clone a document"));
    }
    let root = clone_one(st, doc, id).ok_or_else(JsErr::invalid_node)?;
    if !deep {
        return Ok(root);
    }
    let mut stack = vec![(id, root)];
    while let Some((src, dst)) = stack.pop() {
        // Template contents.
        if is_html_id(doc, src, &local_name!("template")) {
            let src_content = st.template_contents.borrow().get(&src).copied();
            if let Some(sc) = src_content
                && doc.get_node(sc).is_some()
            {
                let dc = template_content(st, doc, dst);
                stack.push((sc, dc));
            }
        }
        let children: Vec<NodeId> = doc
            .get_node(src)
            .map(|n| dom_children(n).to_vec())
            .unwrap_or_default();
        if children.is_empty() {
            continue;
        }
        let mut new_children = Vec::with_capacity(children.len());
        for c in children {
            if let Some(nc) = clone_one(st, doc, c) {
                new_children.push(nc);
                let has_content = st.template_contents.borrow().contains_key(&c);
                if has_content || doc.get_node(c).is_some_and(|n| !dom_children(n).is_empty()) {
                    stack.push((c, nc));
                }
            }
        }
        let mut m = doc.mutate();
        m.append_children(dst, &new_children);
    }
    Ok(root)
}

// ---------------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------------

/// Qualified name of an attribute (`prefix:local` or `local`).
pub(crate) fn attr_qname(attr: &Attribute) -> Cow<'_, str> {
    match &attr.name.prefix {
        Some(p) => Cow::Owned(format!("{}:{}", &**p, &*attr.name.local)),
        None => Cow::Borrowed(&*attr.name.local),
    }
}

/// Find an attribute by qualified name.
pub(crate) fn find_attr<'a>(attrs: &'a [Attribute], qname: &str) -> Option<&'a Attribute> {
    attrs.iter().find(|a| match &a.name.prefix {
        None => &*a.name.local == qname,
        Some(p) => {
            qname.len() == p.len() + 1 + a.name.local.len()
                && qname.starts_with(&**p)
                && qname.as_bytes()[p.len()] == b':'
                && qname.ends_with(&*a.name.local)
        }
    })
}

pub(crate) fn get_attr<'a>(doc: &'a BaseDocument, id: NodeId, qname: &str) -> Option<&'a str> {
    let el = doc.get_node(id)?.element_data()?;
    find_attr(&el.attrs, qname).map(|a| a.value.as_str())
}

/// QualName to use when setting attribute `qname` on the element.
fn attr_name_for(doc: &BaseDocument, id: NodeId, qname: &str) -> QualName {
    if let Some(a) = doc
        .get_node(id)
        .and_then(|n| n.element_data())
        .and_then(|el| find_attr(&el.attrs, qname))
    {
        return a.name.clone();
    }
    QualName::new(None, ns!(), LocalName::from(qname))
}

/// Set an attribute through blitz (which applies side effects: id map, style attribute,
/// stylesheet/image loads, disabled state...). `value` and `checked` get HTML
/// dirty-flag semantics blitz lacks.
pub(crate) fn set_attr(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    id: NodeId,
    qname: &str,
    value: &str,
) -> Result<(), JsErr> {
    if qname.is_empty()
        || qname.contains([
            ' ', '\t', '\n', '\x0c', '\r', '"', '\'', '>', '/', '=', '\0',
        ])
    {
        return Err(JsErr::dom(
            "InvalidCharacterError",
            format!("'{qname}' is not a valid attribute name"),
        ));
    }
    let Some(node) = doc.get_node(id) else {
        return Err(JsErr::invalid_node());
    };
    if !node.is_element() || kind(st, node) == Kind::Fragment {
        return Err(JsErr::type_err("not an element"));
    }
    let name = attr_name_for(doc, id, qname);
    if name.local == local_name!("value")
        && name.ns == ns!()
        && crate::forms::value_attr_is_shadowed(st, doc, id)
    {
        // The control's value is dirty: the attribute only changes the default value.
        raw_set_attr(doc, id, name, value);
    } else {
        let mut m = doc.mutate();
        m.set_attribute(id, name, value);
    }
    crate::forms::after_attr_change(st, doc, id, qname, true);
    st.invalidate_layout();
    Ok(())
}

pub(crate) fn remove_attr(st: &RuntimeState, doc: &mut BaseDocument, id: NodeId, qname: &str) {
    let Some(el) = doc.get_node(id).and_then(|n| n.element_data()) else {
        return;
    };
    let Some(name) = find_attr(&el.attrs, qname).map(|a| a.name.clone()) else {
        return;
    };
    if name.local == local_name!("value")
        && name.ns == ns!()
        && crate::forms::value_attr_is_shadowed(st, doc, id)
    {
        raw_remove_attr(doc, id, &name);
    } else {
        let mut m = doc.mutate();
        m.clear_attribute(id, name);
    }
    crate::forms::after_attr_change(st, doc, id, qname, false);
    st.invalidate_layout();
}

/// Set an attribute value without blitz side effects (still invalidates selectors).
pub(crate) fn raw_set_attr(doc: &mut BaseDocument, id: NodeId, name: QualName, value: &str) {
    let in_doc = is_connected(doc, id);
    if in_doc {
        doc.snapshot_node(id);
    }
    if let Some(node) = doc.get_node_mut(id) {
        if let Some(el) = node.element_data_mut() {
            el.attrs.set(name, value);
        }
        node.set_restyle_hint(blitz_dom::RestyleHint::RESTYLE_SELF);
    }
}

pub(crate) fn raw_remove_attr(doc: &mut BaseDocument, id: NodeId, name: &QualName) {
    let in_doc = is_connected(doc, id);
    if in_doc {
        doc.snapshot_node(id);
    }
    if let Some(node) = doc.get_node_mut(id) {
        if let Some(el) = node.element_data_mut() {
            el.attrs.remove(name);
        }
        node.set_restyle_hint(blitz_dom::RestyleHint::RESTYLE_SELF);
    }
}

/// Qualified element name as seen by `tagName` (without uppercasing).
pub(crate) fn element_qname(node: &Node) -> Option<Cow<'_, str>> {
    let el = node.element_data()?;
    Some(match &el.name.prefix {
        Some(p) => Cow::Owned(format!("{}:{}", &**p, &*el.name.local)),
        None => Cow::Borrowed(&*el.name.local),
    })
}

/// DOM `compareDocumentPosition` bitmask for `other` relative to `this`.
pub(crate) fn compare_position(doc: &BaseDocument, this: NodeId, other: NodeId) -> u32 {
    const DISCONNECTED: u32 = 1;
    const PRECEDING: u32 = 2;
    const FOLLOWING: u32 = 4;
    const CONTAINS: u32 = 8;
    const CONTAINED_BY: u32 = 16;
    const IMPLEMENTATION_SPECIFIC: u32 = 32;
    if this == other {
        return 0;
    }
    let a = inclusive_ancestors(doc, this);
    let b = inclusive_ancestors(doc, other);
    if a.last() != b.last() {
        let order = if other.as_u64() < this.as_u64() {
            PRECEDING
        } else {
            FOLLOWING
        };
        return DISCONNECTED | IMPLEMENTATION_SPECIFIC | order;
    }
    if a.contains(&other) {
        return CONTAINS | PRECEDING;
    }
    if b.contains(&this) {
        return CONTAINED_BY | FOLLOWING;
    }
    // Walk down from the common root until the paths diverge.
    let (mut i, mut j) = (a.len() - 1, b.len() - 1);
    while i > 0 && j > 0 && a[i - 1] == b[j - 1] {
        i -= 1;
        j -= 1;
    }
    let common = a[i];
    let (ca, cb) = (a[i - 1], b[j - 1]);
    let parent = doc.get_node(common).unwrap();
    let ia = parent.index_of_child(ca).unwrap_or(0);
    let ib = parent.index_of_child(cb).unwrap_or(0);
    if ib < ia { PRECEDING } else { FOLLOWING }
}

/// Nodes of the subtree rooted at `root` in tree order (including root).
pub(crate) fn subtree(doc: &BaseDocument, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let Some(n) = doc.get_node(id) else { continue };
        out.push(id);
        stack.extend(dom_children(n).iter().rev().copied());
    }
    out
}

/// The document's base URL: the first `<base href>` resolved against the document URL.
pub(crate) fn base_url(doc: &BaseDocument, doc_url: &url::Url) -> url::Url {
    let mut stack = vec![doc.root_node().id];
    let mut visited = 0;
    while let Some(id) = stack.pop() {
        visited += 1;
        if visited > 2000 {
            break; // <base> lives in <head>; don't scan huge documents.
        }
        let Some(n) = doc.get_node(id) else { continue };
        if is_html(n, &local_name!("base"))
            && let Some(href) = n.element_data().and_then(|e| e.attr(local_name!("href")))
            && let Ok(u) = doc_url.join(href)
        {
            return u;
        }
        stack.extend(n.children.iter().rev().copied());
    }
    doc_url.clone()
}
