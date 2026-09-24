//! HTML fragment serialization (innerHTML/outerHTML) and a side-effect-free fragment
//! parser (innerHTML setter, `N.parseHTMLFragment`).
//!
//! blitz-html's `parse_inner_html` temporarily attaches the parsed nodes to the document
//! (starting image loads, applying `<style>` elements even when the target is detached).
//! Our sink builds the nodes detached; they are attached afterwards with a normal
//! insertion, so side effects happen exactly when the nodes become connected.

use std::borrow::Cow;
use std::cell::{Ref, RefCell};

use blitz_dom::node::{Attribute, NodeData};
use blitz_dom::{BaseDocument, DocumentMutator, LocalName, Node, NodeId, QualName, local_name, ns};
use html5ever::tendril::{StrTendril, TendrilSink};
use html5ever::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeBuilderOpts, TreeSink};
use html5ever::{ParseOpts, tokenizer::TokenizerOpts};

use crate::dom::{self, Kind};
use crate::state::RuntimeState;

// ---------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------

fn is_void(local: &LocalName) -> bool {
    matches!(
        &**local,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "source"
            | "track"
            | "wbr"
            | "basefont"
            | "bgsound"
            | "frame"
            | "keygen"
            | "param"
    )
}

fn is_raw_text_parent(node: &Node) -> bool {
    node.element_data().is_some_and(|el| {
        el.name.ns == ns!(html)
            && matches!(
                &*el.name.local,
                "style"
                    | "script"
                    | "xmp"
                    | "iframe"
                    | "noembed"
                    | "noframes"
                    | "plaintext"
                    | "noscript"
            )
    })
}

fn escape_into(s: &str, out: &mut String, attr: bool) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            '"' if attr => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
}

/// HTML serialization escaping (`<`/`>` are escaped in attributes too, as current
/// browsers do). 0xC2 is the UTF-8 lead byte of U+00A0.
#[inline]
fn escape(s: &str, out: &mut String, attr: bool) {
    let needs = s
        .bytes()
        .any(|b| matches!(b, b'&' | b'<' | b'>' | 0xC2) || (attr && b == b'"'));
    if !needs {
        out.push_str(s);
        return;
    }
    escape_into(s, out, attr);
}

fn serialized_tag_name(node: &Node) -> Cow<'_, str> {
    let el = node.element_data().unwrap();
    if el.name.ns == ns!(html) || el.name.ns == ns!(svg) || el.name.ns == ns!(mathml) {
        Cow::Borrowed(&*el.name.local)
    } else {
        dom::element_qname(node).unwrap()
    }
}

fn serialized_attr_name(attr: &Attribute) -> Cow<'_, str> {
    let n = &attr.name;
    if n.ns == ns!() {
        return Cow::Borrowed(&*n.local);
    }
    if n.ns == ns!(xml) {
        return Cow::Owned(format!("xml:{}", &*n.local));
    }
    if n.ns == ns!(xmlns) {
        if &*n.local == "xmlns" {
            return Cow::Borrowed("xmlns");
        }
        return Cow::Owned(format!("xmlns:{}", &*n.local));
    }
    if n.ns == ns!(xlink) {
        return Cow::Owned(format!("xlink:{}", &*n.local));
    }
    dom::attr_qname(attr)
}

enum Step {
    Open(NodeId),
    Close(NodeId),
}

/// Serialize the children of `id` (innerHTML). Template elements serialize their
/// content fragment.
pub(crate) fn serialize_children(
    st: &RuntimeState,
    doc: &BaseDocument,
    id: NodeId,
    out: &mut String,
) {
    let Some(node) = doc.get_node(id) else { return };
    let container = if dom::is_html(node, &local_name!("template")) {
        dom::template_container(st, id)
    } else {
        id
    };
    let Some(container_node) = doc.get_node(container) else {
        return;
    };
    let mut stack: Vec<Step> = dom::dom_children(container_node)
        .iter()
        .rev()
        .map(|&c| Step::Open(c))
        .collect();
    run(st, doc, &mut stack, out);
}

/// Serialize the node itself (outerHTML).
pub(crate) fn serialize_node(st: &RuntimeState, doc: &BaseDocument, id: NodeId, out: &mut String) {
    let Some(node) = doc.get_node(id) else { return };
    match dom::kind(st, node) {
        Kind::Document | Kind::Fragment => serialize_children(st, doc, id, out),
        _ => {
            let mut stack = vec![Step::Open(id)];
            run(st, doc, &mut stack, out);
        }
    }
}

fn run(st: &RuntimeState, doc: &BaseDocument, stack: &mut Vec<Step>, out: &mut String) {
    while let Some(step) = stack.pop() {
        match step {
            Step::Close(id) => {
                let node = doc.get_node(id).unwrap();
                out.push_str("</");
                out.push_str(&serialized_tag_name(node));
                out.push('>');
            }
            Step::Open(id) => {
                let Some(node) = doc.get_node(id) else {
                    continue;
                };
                match &node.data {
                    NodeData::Text(t) => {
                        let raw = node
                            .parent
                            .and_then(|p| doc.get_node(p))
                            .is_some_and(is_raw_text_parent);
                        if raw {
                            out.push_str(&t.content);
                        } else {
                            escape(&t.content, out, false);
                        }
                    }
                    NodeData::Comment { contents } => {
                        out.push_str("<!--");
                        out.push_str(contents);
                        out.push_str("-->");
                    }
                    NodeData::Element(el) => {
                        if el.name.local == st.fragment_atom {
                            for &c in node.children.iter().rev() {
                                stack.push(Step::Open(c));
                            }
                            continue;
                        }
                        out.push('<');
                        out.push_str(&serialized_tag_name(node));
                        for attr in el.attrs.iter() {
                            out.push(' ');
                            out.push_str(&serialized_attr_name(attr));
                            out.push_str("=\"");
                            escape(&attr.value, out, true);
                            out.push('"');
                        }
                        out.push('>');
                        if el.name.ns == ns!(html) && is_void(&el.name.local) {
                            continue;
                        }
                        stack.push(Step::Close(id));
                        let container = if el.name.ns == ns!(html)
                            && el.name.local == local_name!("template")
                        {
                            dom::template_container(st, id)
                        } else {
                            id
                        };
                        if let Some(c) = doc.get_node(container) {
                            for &child in dom::dom_children(c).iter().rev() {
                                stack.push(Step::Open(child));
                            }
                        }
                    }
                    NodeData::Document(_) => {
                        for &c in node.children.iter().rev() {
                            stack.push(Step::Open(c));
                        }
                    }
                    NodeData::AnonymousBlock(_) => {}
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------
// Fragment parsing
// ---------------------------------------------------------------------------------

/// html5ever tree sink building detached blitz nodes under `holder` (which plays the
/// role of the document node), without any document-level side effects. Template
/// contents go into their own DocumentFragment (inert), as in the HTML spec.
struct FragmentSink<'m, 'doc> {
    mutr: RefCell<&'m mut DocumentMutator<'doc>>,
    holder: NodeId,
    fragment_name: QualName,
    /// (template element, content fragment)
    templates: RefCell<Vec<(NodeId, NodeId)>>,
}

fn to_blitz_attr(a: html5ever::Attribute) -> Attribute {
    Attribute {
        name: a.name,
        value: a.value.to_string(),
    }
}

impl<'m, 'doc> TreeSink for FragmentSink<'m, 'doc> {
    type Handle = NodeId;
    type Output = Vec<(NodeId, NodeId)>;
    type ElemName<'a>
        = Ref<'a, QualName>
    where
        Self: 'a;

    fn finish(self) -> Self::Output {
        self.templates.into_inner()
    }

    fn parse_error(&self, _msg: Cow<'static, str>) {}

    fn get_document(&self) -> NodeId {
        self.holder
    }

    fn elem_name<'a>(&'a self, target: &'a NodeId) -> Ref<'a, QualName> {
        Ref::map(self.mutr.borrow(), |m| {
            m.element_name(*target).unwrap_or(&self.fragment_name)
        })
    }

    fn create_element(
        &self,
        name: QualName,
        attrs: Vec<html5ever::Attribute>,
        _flags: ElementFlags,
    ) -> NodeId {
        let attrs = attrs.into_iter().map(to_blitz_attr).collect();
        self.mutr.borrow_mut().create_element(name, attrs)
    }

    fn create_comment(&self, text: StrTendril) -> NodeId {
        self.mutr.borrow_mut().create_comment_node(&text)
    }

    fn create_pi(&self, _target: StrTendril, data: StrTendril) -> NodeId {
        self.mutr.borrow_mut().create_comment_node(&data)
    }

    fn append(&self, parent: &NodeId, child: NodeOrText<NodeId>) {
        let mut m = self.mutr.borrow_mut();
        match child {
            NodeOrText::AppendNode(id) => m.append_children(*parent, &[id]),
            NodeOrText::AppendText(text) => {
                let last = m.last_child_id(*parent);
                let appended = last.is_some_and(|id| m.append_text_to_node(id, &text).is_ok());
                if !appended {
                    let t = m.create_text_node(&text);
                    m.append_children(*parent, &[t]);
                }
            }
        }
    }

    fn append_before_sibling(&self, sibling: &NodeId, new_node: NodeOrText<NodeId>) {
        let mut m = self.mutr.borrow_mut();
        if !m.node_has_parent(*sibling) {
            return;
        }
        match new_node {
            NodeOrText::AppendNode(id) => m.insert_nodes_before(*sibling, &[id]),
            NodeOrText::AppendText(text) => {
                let prev = m.previous_sibling_id(*sibling);
                let appended = prev.is_some_and(|id| m.append_text_to_node(id, &text).is_ok());
                if !appended {
                    let t = m.create_text_node(&text);
                    m.insert_nodes_before(*sibling, &[t]);
                }
            }
        }
    }

    fn append_based_on_parent_node(
        &self,
        element: &NodeId,
        prev_element: &NodeId,
        child: NodeOrText<NodeId>,
    ) {
        let has_parent = self.mutr.borrow().node_has_parent(*element);
        if has_parent {
            self.append_before_sibling(element, child);
        } else {
            self.append(prev_element, child);
        }
    }

    fn append_doctype_to_document(
        &self,
        _name: StrTendril,
        _public_id: StrTendril,
        _system_id: StrTendril,
    ) {
    }

    fn get_template_contents(&self, target: &NodeId) -> NodeId {
        if let Some(&(_, content)) = self.templates.borrow().iter().find(|(t, _)| t == target) {
            return content;
        }
        let content = self
            .mutr
            .borrow_mut()
            .create_element(self.fragment_name.clone(), Vec::new());
        self.templates.borrow_mut().push((*target, content));
        content
    }

    fn same_node(&self, x: &NodeId, y: &NodeId) -> bool {
        x == y
    }

    fn set_quirks_mode(&self, _mode: QuirksMode) {}

    fn add_attrs_if_missing(&self, target: &NodeId, attrs: Vec<html5ever::Attribute>) {
        let attrs = attrs.into_iter().map(to_blitz_attr).collect();
        self.mutr.borrow_mut().add_attrs_if_missing(*target, attrs);
    }

    fn remove_from_parent(&self, target: &NodeId) {
        self.mutr.borrow_mut().remove_node(*target);
    }

    fn reparent_children(&self, node: &NodeId, new_parent: &NodeId) {
        self.mutr.borrow_mut().reparent_children(*node, *new_parent);
    }
}

/// Parse `html` as a fragment in the context of an element named `context` (HTML
/// fragment parsing algorithm). Returns the detached top-level nodes in order.
pub(crate) fn parse_fragment(
    st: &RuntimeState,
    doc: &mut BaseDocument,
    context: QualName,
    html: &str,
) -> Vec<NodeId> {
    let fragment_name = QualName::new(None, ns!(html), st.fragment_atom.clone());
    let (holder, templates) = {
        let mut m = doc.mutate();
        let holder = m.create_element(fragment_name.clone(), Vec::new());
        let sink = FragmentSink {
            mutr: RefCell::new(&mut m),
            holder,
            fragment_name,
            templates: RefCell::default(),
        };
        let templates =
            html5ever::driver::parse_fragment(sink, parse_opts(true), context, Vec::new(), true)
                .one(StrTendril::from(html));
        (holder, templates)
    };
    st.template_contents.borrow_mut().extend(templates);

    // holder -> <html> root -> parsed nodes.
    let root = doc
        .get_node(holder)
        .and_then(|n| n.children.first().copied());
    let nodes: Vec<NodeId> = root
        .and_then(|r| doc.get_node(r))
        .map(|r| r.children.to_vec())
        .unwrap_or_default();
    {
        let mut m = doc.mutate();
        for &n in &nodes {
            m.remove_node(n);
        }
        // The holder subtree now only contains the html root (and the throwaway
        // context element is unparented); free them.
        m.remove_and_drop_node(holder);
    }
    for &n in &nodes {
        post_parse_fixups(st, doc, n);
    }
    nodes
}

fn parse_opts(scripting_enabled: bool) -> ParseOpts {
    ParseOpts {
        tokenizer: TokenizerOpts::default(),
        tree_builder: TreeBuilderOpts {
            exact_errors: false,
            scripting_enabled,
            iframe_srcdoc: false,
            drop_doctype: true,
            quirks_mode: QuirksMode::NoQuirks,
        },
    }
}

/// Parse `html` as a complete document (DOMParser / `createHTMLDocument`, scripting
/// disabled). Returns a new detached fragment holding the document's children (the
/// `<html>` element and any top-level comments; the doctype is dropped).
pub(crate) fn parse_document(st: &RuntimeState, doc: &mut BaseDocument, html: &str) -> NodeId {
    let fragment_name = QualName::new(None, ns!(html), st.fragment_atom.clone());
    let (holder, templates) = {
        let mut m = doc.mutate();
        let holder = m.create_element(fragment_name.clone(), Vec::new());
        let sink = FragmentSink {
            mutr: RefCell::new(&mut m),
            holder,
            fragment_name,
            templates: RefCell::default(),
        };
        let templates =
            html5ever::driver::parse_document(sink, parse_opts(false)).one(StrTendril::from(html));
        (holder, templates)
    };
    st.template_contents.borrow_mut().extend(templates);
    post_parse_fixups(st, doc, holder);
    holder
}

/// Fixups for freshly parsed subtrees: textarea default values, and template contents
/// moved out of the tree into their content fragments (blitz-html's parser leaves them
/// as children of the `<template>`).
pub(crate) fn post_parse_fixups(st: &RuntimeState, doc: &mut BaseDocument, root: NodeId) {
    let mut textareas = Vec::new();
    let mut templates = Vec::new();
    for id in dom::subtree(doc, root) {
        if dom::is_html_id(doc, id, &local_name!("textarea")) {
            textareas.push(id);
        } else if dom::is_html_id(doc, id, &local_name!("template")) {
            templates.push(id);
        }
    }
    for t in textareas {
        crate::forms::sync_textarea_default(st, doc, t);
    }
    // Tree order: outer templates first, so nested ones move within their contents.
    for t in templates {
        dom::template_content(st, doc, t);
    }
}

/// Context element name for fragment parsing into `target` (template content and
/// fragments parse as `<body>` / template contexts).
pub(crate) fn context_name_for(st: &RuntimeState, doc: &BaseDocument, target: NodeId) -> QualName {
    match doc.get_node(target) {
        Some(n) => match (&n.data, dom::kind(st, n)) {
            (NodeData::Element(el), Kind::Element) => el.name.clone(),
            _ => QualName::new(None, ns!(html), local_name!("body")),
        },
        None => QualName::new(None, ns!(html), local_name!("body")),
    }
}
