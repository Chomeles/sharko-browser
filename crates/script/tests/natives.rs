//! Tests of the native functions (`__native`) without the JS layer.

mod common;

use common::Env;

const BASIC: &str = r#"<!DOCTYPE html>
<html><head><title>T</title></head>
<body style="margin:0">
  <div id="a" class="x y"><span id="s1">one</span><span id="s2">two</span></div>
  <p id="p">para <b>bold</b></p>
  <ul id="list"><li>1</li><li>2</li><li>3</li></ul>
  <template id="tpl"><div class="in-template">t</div></template>
</body></html>"#;

fn env() -> Env {
    let mut e = Env::new(BASIC);
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    e.eval("globalThis.N = __native; 1");
    e
}

#[test]
fn tree_navigation() {
    let mut e = env();
    assert_eq!(e.eval("N.nodeType(N.documentId())"), "9");
    assert_eq!(
        e.eval("const a = N.getElementById('a'); N.localName(a)"),
        "\"div\""
    );
    assert_eq!(e.eval("N.nodeType(a)"), "1");
    assert_eq!(
        e.eval("N.namespaceURI(a)"),
        "\"http://www.w3.org/1999/xhtml\""
    );
    assert_eq!(
        e.eval("N.childIds(a).map(id => N.getAttr(id, 'id'))"),
        "[\"s1\",\"s2\"]"
    );
    assert_eq!(e.eval("N.getAttr(N.firstChild(a), 'id')"), "\"s1\"");
    assert_eq!(e.eval("N.getAttr(N.lastChild(a), 'id')"), "\"s2\"");
    assert_eq!(
        e.eval("N.getAttr(N.nextSibling(N.firstChild(a)), 'id')"),
        "\"s2\""
    );
    assert_eq!(e.eval("N.prevSibling(N.firstChild(a))"), "0");
    assert_eq!(e.eval("N.nextSibling(N.lastChild(a))"), "0");
    assert_eq!(e.eval("N.parent(N.firstChild(a)) === a"), "true");
    assert_eq!(e.eval("N.localName(N.parent(N.parent(a)))"), "\"html\"");
    assert_eq!(
        e.eval("N.parent(N.parent(N.parent(a))) === N.documentId()"),
        "true"
    );
    assert_eq!(e.eval("N.parent(N.documentId())"), "0");
    // Text children
    assert_eq!(
        e.eval("const p = N.getElementById('p'); N.nodeType(N.firstChild(p))"),
        "3"
    );
    assert_eq!(e.eval("N.getText(N.firstChild(p))"), "\"para \"");
    assert_eq!(e.eval("N.childElementIds(p).length"), "1");
    assert_eq!(e.eval("N.textContent(p)"), "\"para bold\"");
    assert_eq!(e.eval("N.isConnected(p)"), "true");
    assert_eq!(
        e.eval("N.contains(N.documentId(), p) && N.contains(p, p) && !N.contains(p, a)"),
        "true"
    );
    assert_eq!(e.eval("N.contains(p, 0)"), "false");
    // compareDocumentPosition: a precedes p -> p is FOLLOWING (4) relative to a
    assert_eq!(e.eval("N.compareDocumentPosition(a, p)"), "4");
    assert_eq!(e.eval("N.compareDocumentPosition(p, a)"), "2");
    assert_eq!(
        e.eval("N.compareDocumentPosition(a, N.firstChild(a))"),
        "20"
    );
    assert_eq!(
        e.eval("N.compareDocumentPosition(N.firstChild(a), a)"),
        "10"
    );
    // Sibling iteration over a list.
    assert_eq!(
        e.eval("const ul = N.getElementById('list'); let c = N.firstChild(ul), n = 0; while (c) { n++; c = N.nextSibling(c); } n"),
        "3"
    );
    // Ids are small integers (Smis) for fresh nodes.
    assert_eq!(e.eval("Number.isInteger(a) && a > 0 && a < 1e6"), "true");
}

#[test]
fn invalid_ids_throw_type_error() {
    let mut e = env();
    let err = e.eval_err("N.parent(123456789)");
    assert!(err.contains("TypeError"), "{err}");
    let err = e.eval_err("N.parent(0)");
    assert!(err.contains("TypeError"), "{err}");
    let err = e.eval_err("N.localName('x')");
    assert!(err.contains("TypeError"), "{err}");
    let err = e.eval_err("N.appendChild(-5, 3.5)");
    assert!(err.contains("TypeError"), "{err}");
    // A dropped node: create, drop via innerHTML replacement (never exposed children
    // are freed; exposed ones survive).
    assert_eq!(
        e.eval("const d = N.createElement('div', ''); N.setInnerHTML(d, '<i>x</i>'); const i = N.firstChild(d); N.setInnerHTML(d, ''); N.localName(i)"),
        "\"i\""
    );
}

#[test]
fn create_and_mutate() {
    let mut e = env();
    let r = e.eval(
        r#"
        const body = N.querySelector(N.documentId(), 'body');
        const div = N.createElement('div', '');
        const t = N.createText('hello');
        N.appendChild(div, t);
        N.setAttr(div, 'id', 'created');
        N.appendChild(body, div);
        const c = N.createComment('note');
        N.insertBefore(div, c, t);
        [N.getElementById('created') === div, N.isConnected(div), N.childIds(div).length,
         N.nodeType(c), N.getText(c), N.outerHTML(div)]
    "#,
    );
    assert_eq!(
        r,
        r#"[true,true,2,8,"note","<div id=\"created\"><!--note-->hello</div>"]"#
    );
    // removeChild keeps the node alive; re-insert works.
    let r = e.eval(
        r#"
        N.removeChild(body, div);
        const detached = [N.isConnected(div), N.getElementById('created'), N.parent(div)];
        N.appendChild(N.getElementById('a'), div);
        [detached, N.parent(div) === N.getElementById('a'), N.getElementById('created') === div]
    "#,
    );
    assert_eq!(r, "[[false,0,0],true,true]");
    // replaceChild
    let r = e.eval(
        r#"
        const a = N.getElementById('a');
        const nw = N.createElement('em', '');
        N.replaceChild(a, nw, N.firstChild(a));
        N.childIds(a).map(N.localName)
    "#,
    );
    assert_eq!(r, r#"["em","span","div"]"#);
    // insertBefore with ref 0 appends; moving within the same parent
    let r = e.eval(
        r#"
        const ul = N.getElementById('list');
        const first = N.firstChild(ul);
        N.insertBefore(ul, first, 0);
        N.childIds(ul).map(N.textContent).join(',')
    "#,
    );
    assert_eq!(r, "\"2,3,1\"");
    // insertBefore(node, node) is a no-op reorder
    let r = e.eval("const l2 = N.lastChild(ul); N.insertBefore(ul, l2, l2); N.childIds(ul).map(N.textContent).join(',')");
    assert_eq!(r, "\"2,3,1\"");
    // setTextContent / textContent
    let r = e.eval("N.setTextContent(ul, 'plain'); [N.childIds(ul).length, N.textContent(ul), N.nodeType(N.firstChild(ul))]");
    assert_eq!(r, r#"[1,"plain",3]"#);
    let r = e.eval("N.setTextContent(ul, ''); N.childIds(ul).length");
    assert_eq!(r, "0");
    // setText on a text node
    let r = e.eval("const tn = N.createText('a'); N.setText(tn, 'b'); N.getText(tn)");
    assert_eq!(r, "\"b\"");
    // cloneNode
    let r = e.eval(
        r#"
        const src = N.getElementById('p');
        const shallow = N.cloneNode(src, false), deep = N.cloneNode(src, true);
        [N.childIds(shallow).length, N.outerHTML(deep), N.isConnected(deep), N.getAttr(deep, 'id')]
    "#,
    );
    assert_eq!(r, r#"[0,"<p id=\"p\">para <b>bold</b></p>",false,"p"]"#);
}

#[test]
fn hierarchy_errors() {
    let mut e = env();
    let err = e.eval_err("const a = N.getElementById('a'); N.appendChild(N.firstChild(a), a)");
    assert!(err.contains("HierarchyRequestError"), "{err}");
    let err = e.eval_err("N.appendChild(a, a)");
    assert!(err.contains("HierarchyRequestError"), "{err}");
    let err = e.eval_err("N.appendChild(N.createText('x'), N.createText('y'))");
    assert!(err.contains("HierarchyRequestError"), "{err}");
    let err = e.eval_err("N.appendChild(N.documentId(), N.createText('y'))");
    assert!(err.contains("HierarchyRequestError"), "{err}");
    let err = e.eval_err("N.appendChild(N.documentId(), N.createElement('div', ''))");
    assert!(err.contains("HierarchyRequestError"), "{err}");
    let err = e.eval_err("N.insertBefore(a, N.createText('x'), N.getElementById('p'))");
    assert!(err.contains("NotFoundError"), "{err}");
    let err = e.eval_err("N.removeChild(a, N.getElementById('p'))");
    assert!(err.contains("NotFoundError"), "{err}");
    let err = e.eval_err("N.createElement('#bad', '')");
    assert!(err.contains("InvalidCharacterError"), "{err}");
    let err = e.eval_err("N.setAttr(a, 'bad name', 'v')");
    assert!(err.contains("InvalidCharacterError"), "{err}");
    // Document stays intact.
    assert_eq!(e.eval("N.localName(N.parent(a))"), "\"body\"");
}

#[test]
fn fragments() {
    let mut e = env();
    let r = e.eval(
        r#"
        const f = N.createFragment();
        N.appendChild(f, N.createElement('i', ''));
        N.appendChild(f, N.createText('t'));
        N.appendChild(f, N.createElement('b', ''));
        const info = [N.nodeType(f), N.localName(f), N.childIds(f).length, N.isConnected(f), N.textContent(f)];
        const a = N.getElementById('a');
        N.insertBefore(a, f, N.lastChild(a));
        [info, N.childIds(f).length, N.childIds(a).map(id => N.nodeType(id) === 1 ? N.localName(id) : '#text')]
    "#,
    );
    assert_eq!(
        r,
        r##"[[11,"",3,false,"t"],0,["span","i","#text","b","span"]]"##
    );
    // appendChild of a fragment moves its children; the fragment's own parent is never set.
    let r = e.eval(
        r#"
        const f2 = N.parseHTMLFragment('<em>1</em><em>2</em>');
        N.appendChild(N.getElementById('p'), f2);
        [N.childIds(f2).length, N.querySelectorAll(N.getElementById('p'), 'em').length, N.parent(f2)]
    "#,
    );
    assert_eq!(r, "[0,2,0]");
    // replaceChild with a fragment
    let r = e.eval(
        r#"
        const ul = N.getElementById('list');
        const f3 = N.parseHTMLFragment('<li>x</li><li>y</li>');
        N.replaceChild(ul, f3, N.firstChild(ul));
        N.childIds(ul).map(N.textContent).join(',')
    "#,
    );
    assert_eq!(r, "\"x,y,2,3\"");
    // Fragments are not matched by selectors/matches and are not elements.
    assert_eq!(e.eval("N.matches(N.createFragment(), '*')"), "false");
    // Querying inside a fragment
    assert_eq!(
        e.eval("const f4 = N.parseHTMLFragment('<div><p class=q>1</p></div><p class=q>2</p>'); N.querySelectorAll(f4, '.q').length"),
        "2"
    );
}

#[test]
fn attributes() {
    let mut e = env();
    let r = e.eval(
        r#"
        const a = N.getElementById('a');
        N.setAttr(a, 'data-x', '1');
        N.setAttr(a, 'title', 'hello "q" & <b>');
        [N.getAttr(a, 'class'), N.hasAttr(a, 'data-x'), N.getAttr(a, 'missing'), N.attrNames(a)]
    "#,
    );
    assert_eq!(r, r#"["x y",true,null,["id","class","data-x","title"]]"#);
    assert_eq!(
        e.eval("N.outerHTML(N.createElement('br','')) + '|' + (N.setAttr(a,'class','z'), N.getAttr(a,'class'))"),
        r#""<br>|z""#
    );
    let r = e.eval("N.removeAttr(a, 'data-x'); N.removeAttr(a, 'nope'); [N.hasAttr(a, 'data-x'), N.attrNames(a).length]");
    assert_eq!(r, "[false,3]");
    // id changes update getElementById
    let r = e.eval(
        "N.setAttr(a, 'id', 'renamed'); [N.getElementById('a'), N.getElementById('renamed') === a]",
    );
    assert_eq!(r, "[0,true]");
    // Attribute escaping in serialization
    let r = e.eval(
        "const q = N.createElement('q',''); N.setAttr(q, 'title', 'a\"b&c<d'); N.outerHTML(q)",
    );
    assert_eq!(r, r#""<q title=\"a&quot;b&amp;c&lt;d\"></q>""#);
    // SVG: namespaced element + xlink attribute via the parser
    let r = e.eval(
        r##"
        const host = N.createElement('div', '');
        N.setInnerHTML(host, '<svg viewBox="0 0 10 10"><use xlink:href="#x"></use><foreignObject></foreignObject></svg>');
        const svg = N.firstChild(host);
        const use = N.firstChild(svg);
        [N.namespaceURI(svg), N.localName(N.lastChild(svg)), N.getAttr(use, 'xlink:href'), N.attrNames(use), N.getAttr(svg, 'viewBox')]
    "##,
    );
    assert_eq!(
        r,
        r##"["http://www.w3.org/2000/svg","foreignObject","#x",["xlink:href"],"0 0 10 10"]"##
    );
}

#[test]
fn inner_outer_html() {
    let mut e = env();
    let r = e.eval(
        r#"
        const d = N.createElement('div', '');
        N.setInnerHTML(d, '<p class="a">x &amp; y &lt; z</p><img src="i.png"><br><input value=1><!--c--><script>if (a < b && c) {}</script>');
        N.innerHTML(d)
    "#,
    );
    assert_eq!(
        r,
        r#""<p class=\"a\">x &amp; y &lt; z</p><img src=\"i.png\"><br><input value=\"1\"><!--c--><script>if (a < b && c) {}</script>""#
    );
    // nbsp escaping
    assert_eq!(
        e.eval("N.setInnerHTML(d, 'a&nbsp;b'); N.innerHTML(d)"),
        r#""a&nbsp;b""#
    );
    // Context-sensitive parsing: <tr> inside a tbody context
    let r = e.eval(
        r#"
        const tb = N.createElement('tbody', '');
        N.setInnerHTML(tb, '<tr><td>1</td></tr>');
        N.localName(N.firstChild(tb))
    "#,
    );
    assert_eq!(r, "\"tr\"");
    // Template content is not part of the document tree.
    let r = e.eval(
        r#"
        const tpl = N.getElementById('tpl');
        const content = N.templateContent(tpl);
        [N.childIds(tpl).length, N.nodeType(content), N.querySelectorAll(N.documentId(), '.in-template').length,
         N.querySelectorAll(content, '.in-template').length, N.innerHTML(tpl), N.outerHTML(tpl)]
    "#,
    );
    assert_eq!(
        r,
        r#"[0,11,0,1,"<div class=\"in-template\">t</div>","<template id=\"tpl\"><div class=\"in-template\">t</div></template>"]"#
    );
    // innerHTML on a template parses into its content
    let r = e.eval(
        r#"
        const t2 = N.createElement('template', '');
        N.setInnerHTML(t2, '<b>1</b><b>2</b>');
        [N.childIds(t2).length, N.childIds(N.templateContent(t2)).length, N.innerHTML(t2)]
    "#,
    );
    assert_eq!(r, r#"[0,2,"<b>1</b><b>2</b>"]"#);
    // Parsed template contents go straight into the content fragment (inert).
    let r = e.eval(
        r#"
        const h = N.createElement('div', '');
        N.setInnerHTML(h, '<template><span>in</span></template>');
        const t3 = N.firstChild(h);
        const before = N.childIds(t3).length;
        const txt = N.textContent(N.templateContent(t3));
        [before, N.childIds(t3).length, txt, N.innerHTML(h), N.cloneNode(h, true) > 0]
    "#,
    );
    assert_eq!(
        r,
        r#"[0,0,"in","<template><span>in</span></template>",true]"#
    );
    // Template contents of the main document were moved out at document_parsed.
    assert_eq!(e.eval("[N.childIds(N.getElementById('tpl')).length, N.querySelector(N.documentId(), '.in-template')]"), "[0,0]");
    // outerHTML of the document element round-trips
    let r = e.eval("N.outerHTML(N.getElementById('p'))");
    assert_eq!(r, r#""<p id=\"p\">para <b>bold</b></p>""#);
    // innerHTML with a <style> on a detached element must not apply it.
    let r = e.eval(
        r#"
        const det = N.createElement('div', '');
        N.setInnerHTML(det, '<style>#p { color: rgb(1, 2, 3) }</style>');
        N.computedStyle(N.getElementById('p'), 'color', '')
    "#,
    );
    assert_ne!(r, "\"rgb(1, 2, 3)\"");
}

#[test]
fn selectors() {
    let mut e = env();
    let doc_q = |s: &str| format!("N.querySelectorAll(N.documentId(), {s:?}).length");
    assert_eq!(e.eval(&doc_q("span")), "2");
    assert_eq!(e.eval(&doc_q("#a > span + span")), "1");
    assert_eq!(e.eval(&doc_q("li:nth-child(2)")), "1");
    assert_eq!(e.eval(&doc_q("div.x.y")), "1");
    assert_eq!(e.eval(&doc_q("ul li, p b")), "4");
    let r = e.eval("const a = N.getElementById('a'); N.querySelectorAll(a, ':scope > span').map(id => N.getAttr(id, 'id'))");
    assert_eq!(r, r#"["s1","s2"]"#);
    assert_eq!(
        e.eval("N.getAttr(N.querySelector(N.documentId(), 'span:last-child'), 'id')"),
        "\"s2\""
    );
    assert_eq!(e.eval("N.querySelector(N.documentId(), 'article')"), "0");
    assert_eq!(e.eval("N.matches(a, 'div#a.x')"), "true");
    assert_eq!(e.eval("N.matches(a, 'span')"), "false");
    assert_eq!(
        e.eval("N.closest(N.getElementById('s1'), 'div') === a"),
        "true"
    );
    assert_eq!(e.eval("N.closest(N.getElementById('s1'), 'section')"), "0");
    assert_eq!(
        e.eval("N.matches(N.getElementById('s2'), ':last-child')"),
        "true"
    );
    let err = e.eval_err("N.querySelector(N.documentId(), 'div[')");
    assert!(err.contains("SyntaxError"), "{err}");
    let err = e.eval_err("N.matches(a, '!!')");
    assert!(err.contains("SyntaxError"), "{err}");
    // Results in document order
    let r = e.eval("N.querySelectorAll(N.documentId(), 'li, #p, #a').map(id => N.localName(id))");
    assert_eq!(r, r#"["div","p","li","li","li"]"#);
}

#[test]
fn layout_metrics() {
    let mut e = Env::new(
        r#"<html><body style="margin:0">
        <div id="box" style="position:absolute; left:10px; top:20px; width:100px; height:50px; padding:5px; border:2px solid black"></div>
        <div id="scroller" style="position:absolute; top:200px; width:100px; height:100px; overflow:scroll"><div style="height:500px;width:300px"></div></div>
        <div id="hidden" style="display:none"><span id="inner">x</span></div>
        </body></html>"#,
    );
    e.eval("globalThis.N = __native; 1");
    assert_eq!(
        e.eval("N.getBoundingClientRect(N.getElementById('box'))"),
        "[10,20,114,64]"
    );
    assert_eq!(
        e.eval("N.offsetMetrics(N.getElementById('box')).slice(0, 4)"),
        "[10,20,114,64]"
    );
    assert_eq!(
        e.eval("N.clientMetrics(N.getElementById('box'))"),
        "[2,2,110,60]"
    );
    assert_eq!(
        e.eval("N.getBoundingClientRect(N.getElementById('hidden'))"),
        "[0,0,0,0]"
    );
    assert_eq!(
        e.eval("N.getBoundingClientRect(N.getElementById('inner'))"),
        "[0,0,0,0]"
    );
    assert_eq!(
        e.eval("N.getClientRects(N.getElementById('hidden')).length"),
        "0"
    );
    // Layout is recomputed after mutations.
    assert_eq!(
        e.eval("const b = N.getElementById('box'); N.styleSet(b, 'width', '200px', ''); N.getBoundingClientRect(b)[2]"),
        "214"
    );
    // Element scrolling
    let r = e.eval(
        r#"
        const sc = N.getElementById('scroller');
        const before = N.scrollMetrics(sc);
        N.setScroll(sc, 0, 120);
        [before[0], before[1], before[3] >= 500, N.scrollMetrics(sc)[1]]
    "#,
    );
    assert_eq!(r, "[0,0,true,120]");
    // elementFromPoint
    assert_eq!(
        e.eval("N.getAttr(N.elementFromPoint(15, 25), 'id')"),
        "\"box\""
    );
    assert_eq!(
        e.eval("N.localName(N.elementFromPoint(700, 500))"),
        "\"html\""
    );
    assert_eq!(e.eval("N.elementFromPoint(-1, 5)"), "0");
    // viewport
    assert_eq!(e.eval("N.viewport().slice(0, 5)"), "[800,600,1,0,0]");
    assert_eq!(
        e.eval("N.clientMetrics(N.querySelector(N.documentId(), 'html'))"),
        "[0,0,800,600]"
    );
}

#[test]
fn inline_style() {
    let mut e = env();
    let r = e.eval(
        r#"
        const a = N.getElementById('a');
        N.styleSet(a, 'color', 'red', '');
        N.styleSet(a, 'margin', '1px 2px', 'important');
        N.styleSet(a, '--my-var', ' 10px', '');
        N.styleSet(a, 'width', 'bogus', '');
        [N.styleGet(a, 'color'), N.styleGet(a, 'margin'), N.styleGet(a, 'margin-left'),
         N.styleGetPriority(a, 'margin'), N.styleGetPriority(a, 'color'), N.styleGet(a, 'width'),
         N.styleGet(a, '--my-var'), N.styleLength(a), N.styleItem(a, 0), N.getAttr(a, 'style')]
    "#,
    );
    assert_eq!(
        r,
        r#"["red","1px 2px","2px","important","","","10px",6,"color","color: red; margin: 1px 2px !important; --my-var: 10px;"]"#
    );
    let r = e.eval("[N.styleRemove(a, 'color'), N.styleGet(a, 'color'), N.styleCssText(a)]");
    assert_eq!(
        r,
        r#"["red","","margin: 1px 2px !important; --my-var: 10px;"]"#
    );
    let r = e.eval("N.styleSetCssText(a, 'display: none; opacity:0.5'); [N.styleGet(a, 'display'), N.styleGet(a, 'opacity'), N.styleLength(a)]");
    assert_eq!(r, r#"["none","0.5",2]"#);
    let r = e.eval("N.styleSet(a, 'opacity', '', ''); N.styleCssText(a)");
    assert_eq!(r, r#""display: none;""#);
    // style attribute set directly is reflected
    let r = e.eval("N.setAttr(a, 'style', 'color: blue'); N.styleGet(a, 'color')");
    assert_eq!(r, "\"blue\"");
    assert_eq!(e.eval("N.cssSupports('display', 'grid')"), "true");
    assert_eq!(e.eval("N.cssSupports('display', 'nonsense')"), "false");
    assert_eq!(e.eval("N.cssSupports('not-a-prop', '1')"), "false");
    assert_eq!(
        e.eval("N.cssSupports('(display: flex) and (color: red)')"),
        "true"
    );
    assert_eq!(e.eval("N.cssSupports('(display: flexy)')"), "false");
}

#[test]
fn computed_style() {
    let mut e = Env::new(
        r#"<html><head><style>
            #c { color: red; width: 50%; padding: 4px; margin-top: 7px; font-size: 20px }
            #c::before { content: "x"; color: rgb(0, 0, 255) }
            .hidden { display: none }
        </style></head>
        <body style="margin:0; width: 400px"><div id="c">c</div><span id="i">inline</span>
        <div class="hidden"><p id="deep">d</p></div></body></html>"#,
    );
    e.eval("globalThis.N = __native; 1");
    let r = e.eval(
        r#"
        const c = N.getElementById('c');
        [N.computedStyle(c, 'color', ''), N.computedStyle(c, 'width', ''), N.computedStyle(c, 'padding-left', ''),
         N.computedStyle(c, 'margin-top', ''), N.computedStyle(c, 'font-size', ''), N.computedStyle(c, 'display', ''),
         N.computedStyle(c, 'color', '::before'), N.computedStyle(c, 'padding', ''), N.computedStyle(c, 'nonsense', '')]
    "#,
    );
    assert_eq!(
        r,
        r#"["rgb(255, 0, 0)","200px","4px","7px","20px","block","rgb(0, 0, 255)","4px",""]"#
    );
    assert_eq!(
        e.eval("N.computedStyle(N.getElementById('i'), 'display', '')"),
        "\"inline\""
    );
    assert_eq!(
        e.eval("N.computedStyle(N.getElementById('deep'), 'display', '')"),
        "\"none\""
    );
    // Style changes are visible immediately (forced style flush).
    assert_eq!(
        e.eval("N.styleSet(c, 'color', 'rgb(1, 2, 3)', ''); N.computedStyle(c, 'color', '')"),
        "\"rgb(1, 2, 3)\""
    );
    assert_eq!(
        e.eval("N.setAttr(c, 'class', 'hidden'); N.computedStyle(c, 'display', '')"),
        "\"none\""
    );
}

#[test]
fn media_queries() {
    let mut e = env();
    let q = |e: &mut Env, s: &str| e.eval(&format!("N.matchMedia({s:?})"));
    assert_eq!(q(&mut e, "(min-width: 500px)"), "true");
    assert_eq!(q(&mut e, "(max-width: 500px)"), "false");
    assert_eq!(q(&mut e, "(width >= 800px) and (height < 601px)"), "true");
    assert_eq!(q(&mut e, "(orientation: landscape)"), "true");
    assert_eq!(q(&mut e, "(prefers-color-scheme: dark)"), "false");
    assert_eq!(q(&mut e, "(prefers-color-scheme: light)"), "true");
    assert_eq!(q(&mut e, "screen"), "true");
    assert_eq!(q(&mut e, "print"), "false");
    assert_eq!(q(&mut e, "not print"), "true");
    assert_eq!(q(&mut e, "print, (min-width: 100px)"), "true");
    assert_eq!(q(&mut e, "(hover: hover) and (pointer: fine)"), "true");
    assert_eq!(q(&mut e, "(min-resolution: 2dppx)"), "false");
    assert_eq!(q(&mut e, "(-webkit-min-device-pixel-ratio: 1)"), "true");
    assert_eq!(q(&mut e, "(bogus-feature: 1)"), "false");
    assert_eq!(q(&mut e, "all"), "true");
}

#[test]
fn input_internal_children_are_hidden() {
    let mut e = env();
    let r = e.eval(
        r#"
        const a = N.getElementById('a');
        N.setInnerHTML(a, '<input id="sb" type="submit" value="Go">');
        const sb = N.getElementById('sb');
        [N.childIds(sb).length, N.firstChild(sb), N.lastChild(sb), N.textContent(a), N.innerHTML(a),
         N.querySelectorAll(a, '*').length]
    "#,
    );
    assert_eq!(
        r,
        r#"[0,0,0,"","<input id=\"sb\" type=\"submit\" value=\"Go\">",1]"#
    );
    let sb = script::node_id_from_js(e.eval("sb").parse::<f64>().unwrap()).unwrap();
    let label = |e: &Env| -> Vec<String> {
        let n = e.doc.get_node(sb).unwrap();
        n.children
            .iter()
            .map(|&c| e.doc.get_node(c).unwrap().text_content())
            .collect()
    };
    // blitz renders the label as an internal text child.
    assert_eq!(label(&e), vec!["Go"]);
    // Moving the input out of and back into the document does not duplicate it.
    e.eval("N.removeChild(a, sb); N.appendChild(a, sb); N.removeChild(a, sb); N.appendChild(N.getElementById('p'), sb); 1");
    assert_eq!(label(&e), vec!["Go"]);
    // The label follows the value attribute (and the `value` IDL setter).
    e.eval("N.setAttr(sb, 'value', 'Stop'); 1");
    assert_eq!(label(&e), vec!["Stop"]);
    e.eval("N.setValue(sb, 'Again'); 1");
    assert_eq!(label(&e), vec!["Again"]);
    e.eval("N.setAttr(sb, 'type', 'text'); 1");
    assert!(label(&e).is_empty());
    e.eval("N.setAttr(sb, 'type', 'reset'); 1");
    assert_eq!(label(&e), vec!["Again"]);
    // Clones copy no internals.
    let r = e.eval("const c = N.cloneNode(sb, true); N.appendChild(a, c); [N.childIds(c).length, N.getAttr(c, 'value')]");
    assert_eq!(r, r#"[0,"Again"]"#);
    let c = script::node_id_from_js(e.eval("c").parse::<f64>().unwrap()).unwrap();
    assert_eq!(e.doc.get_node(c).unwrap().children.len(), 1);
    // Checkedness survives type changes.
    let r = e.eval(
        r#"
        const cb = N.createElement('input', '');
        N.setChecked(cb, true);
        N.setAttr(cb, 'type', 'checkbox');
        const x = N.getChecked(cb);
        N.setAttr(cb, 'type', 'text');
        const y = N.getChecked(cb);
        N.setAttr(cb, 'type', 'radio');
        [x, y, N.getChecked(cb)]
    "#,
    );
    assert_eq!(r, "[true,true,true]");
}

#[test]
fn parse_document_image_size_blob_urls_sync_fetch() {
    let mut e = env();
    // DOMParser-style full document parse (scripting disabled: <noscript> content is markup).
    let r = e.eval(
        r#"
        const f = N.parseHTMLDocument('<!DOCTYPE html><!--c--><title>X</title><p>hi<noscript><b>n</b></noscript>');
        const html = N.lastChild(f);
        [N.nodeType(f), N.nodeType(N.firstChild(f)), N.localName(html), N.childIds(html).map(c => N.localName(c)),
         N.textContent(N.querySelector(f, 'title')), N.outerHTML(N.querySelector(f, 'body')), N.isConnected(html),
         N.getElementById('p') !== 0]
    "#,
    );
    assert_eq!(
        r,
        r#"[11,8,"html",["head","body"],"X","<body><p>hi<noscript><b>n</b></noscript></p></body>",false,true]"#
    );
    // imageSize: null until an image is decoded
    assert_eq!(e.eval("N.imageSize(N.createElement('img', ''))"), "null");
    // blob: URLs are visible to the renderer until revoked / the runtime is dropped.
    let url = "blob:https://example.com/0b2f";
    e.eval(&format!(
        "N.registerBlobURL('{url}', new Uint8Array([1, 2, 3]).buffer, 'image/png'); 1"
    ));
    let b = script::resolve_blob_url(&format!("{url}#frag")).expect("registered");
    assert_eq!(
        (&*b.bytes, b.content_type.as_str()),
        (&[1u8, 2, 3][..], "image/png")
    );
    e.eval(&format!("N.revokeBlobURL('{url}'); 1"));
    assert!(script::resolve_blob_url(url).is_none());
    e.eval(&format!(
        "N.registerBlobURL('{url}2', new Uint8Array([9]), ''); 1"
    ));
    assert!(script::resolve_blob_url(&format!("{url}2")).is_some());
    // Synchronous fetch through the host.
    e.host.serve(
        "https://example.com/dir/data.txt",
        "text/plain",
        "sync body",
    );
    let r = e.eval(
        r#"
        const r = N.fetchSync('get', 'data.txt', ['x-a', '1'], null);
        [r[0], r[1], r[2], r[3], N.textDecode(r[4], 'utf-8', false), r[5]]
    "#,
    );
    assert_eq!(
        r,
        r#"[200,"OK","https://example.com/dir/data.txt",["content-type","text/plain"],"sync body",null]"#
    );
    let req = e.host.sync_fetches.borrow()[0].clone();
    assert_eq!(
        (req.method.as_str(), req.headers.clone(), req.credentials),
        ("GET", vec![("x-a".to_string(), "1".to_string())], true)
    );
    drop(e);
    assert!(script::resolve_blob_url(&format!("{url}2")).is_none());
}

#[test]
fn style_element_text_changes_reparse() {
    let mut e = env();
    let r = e.eval(
        r#"
        const head = N.querySelector(N.documentId(), 'head');
        const st = N.createElement('style', '');
        N.appendChild(head, st);
        const p = N.getElementById('p');
        N.setTextContent(st, '#p { color: rgb(1, 2, 3) }');
        const a = N.computedStyle(p, 'color', '');
        N.setText(N.firstChild(st), '#p { color: rgb(4, 5, 6) }');
        const b = N.computedStyle(p, 'color', '');
        N.appendChild(st, N.createText(' #p { background-color: rgb(7, 8, 9) }'));
        const c = N.computedStyle(p, 'background-color', '');
        N.removeChild(head, st);
        const d = N.computedStyle(p, 'color', '');
        [a, b, c, d]
    "#,
    );
    assert_eq!(
        r,
        r#"["rgb(1, 2, 3)","rgb(4, 5, 6)","rgb(7, 8, 9)","rgb(0, 0, 0)"]"#
    );
}

#[test]
fn doctypes() {
    let p = script::parse_doctype;
    let t = |a: &str, b: &str, c: &str| Some((a.to_string(), b.to_string(), c.to_string()));
    assert_eq!(p("<!DOCTYPE html><html>"), t("html", "", ""));
    assert_eq!(p("\u{feff}  <!-- c --> <!doctype HTML>"), t("html", "", ""));
    assert_eq!(
        p(
            r#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" 'http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd'>"#
        ),
        t(
            "html",
            "-//W3C//DTD XHTML 1.0 Strict//EN",
            "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"
        )
    );
    assert_eq!(
        p(r#"<!DOCTYPE html SYSTEM "about:legacy-compat">"#),
        t("html", "", "about:legacy-compat")
    );
    assert_eq!(p("<html><body>no doctype"), None);
    let mut e = env();
    assert_eq!(e.eval("N.doctype()"), r#"["html","",""]"#);
    e.rt.set_doctype(None);
    assert_eq!(e.eval("N.doctype()"), "null");
    e.rt.set_doctype(Some(("html", "-//W3C//DTD HTML 4.01//EN", "")));
    assert_eq!(
        e.eval("N.doctype()"),
        r#"["html","-//W3C//DTD HTML 4.01//EN",""]"#
    );
}

#[test]
fn live_pseudo_classes() {
    let mut e = Env::new(
        r#"<html lang="en-US"><body>
<form id="f"><input id="t" placeholder="p"><input id="req" required><input id="cb" type="checkbox" checked>
<select id="s"><option id="o1">a</option><option id="o2" selected>b</option></select>
<fieldset id="fs" disabled><input id="inner"></fieldset>
<button id="b1">1</button><button id="b2">2</button>
<input id="n" type="number" min="1" max="5" value="9"><textarea id="ta" readonly></textarea>
<div id="ce" contenteditable=""><span id="ces">x</span></div>
<details id="d" open><summary>s</summary></details>
<svg id="svg"><foreignObject id="fo"></foreignObject></svg>
<p id="fr" lang="fr">x</p></form></body></html>"#,
    );
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    e.eval("globalThis.N = __native; globalThis.ids = (sel) => N.querySelectorAll(N.documentId(), sel).map(i => N.getAttr(i, 'id')).filter(Boolean).join(','); 1");
    let q = |e: &mut Env, sel: &str| {
        e.eval(&format!("ids({sel:?})"))
            .trim_matches('"')
            .to_string()
    };
    assert_eq!(q(&mut e, ":checked"), "cb,o2");
    e.eval("N.setChecked(N.getElementById('cb'), false); N.setSelectedIndex(N.getElementById('s'), 0); 1");
    assert_eq!(q(&mut e, ":checked"), "o1");
    assert_eq!(
        e.eval("N.matches(N.getElementById('o1'), 'option:checked')"),
        "true"
    );
    assert_eq!(q(&mut e, ":placeholder-shown"), "t");
    e.eval("N.setValue(N.getElementById('t'), 'x'); 1");
    assert_eq!(q(&mut e, ":placeholder-shown"), "");
    assert_eq!(q(&mut e, ":required"), "req");
    assert_eq!(q(&mut e, ":invalid"), "f,req");
    assert_eq!(q(&mut e, "input:valid"), "t,cb,inner,n");
    assert_eq!(q(&mut e, ":disabled"), "fs,inner");
    assert_eq!(q(&mut e, "input:enabled"), "t,req,cb,n");
    assert_eq!(q(&mut e, ":default"), "cb,o2,b1");
    assert_eq!(q(&mut e, ":indeterminate"), "");
    e.eval("N.setIndeterminate(N.getElementById('cb'), true); 1");
    assert_eq!(q(&mut e, ":indeterminate"), "cb");
    assert_eq!(q(&mut e, ":out-of-range"), "n");
    assert_eq!(q(&mut e, ":read-write"), "t,req,n,ce,ces");
    assert_eq!(q(&mut e, "textarea:read-only"), "ta");
    assert_eq!(q(&mut e, ":open"), "d");
    assert_eq!(q(&mut e, "p:lang(fr)"), "fr");
    assert_eq!(q(&mut e, "form:lang(en)"), "f");
    assert_eq!(q(&mut e, "foreignObject"), "fo");
    assert_eq!(q(&mut e, ":root"), "");
    assert_eq!(
        e.eval("N.matches(N.parent(N.parent(N.getElementById('f'))), ':root')"),
        "true"
    );
    e.eval("N.navigate('#t', false); N.focus(N.getElementById('req')); 1");
    assert_eq!(q(&mut e, ":target"), "t");
    assert_eq!(q(&mut e, "form:focus-within, input:focus-within"), "f,req");
    // Top-level children of a fragment have no parent element.
    assert_eq!(e.eval("const fr = N.parseHTMLFragment('<i></i><b></b>'); [N.querySelectorAll(fr, '* > b').length, N.querySelectorAll(fr, 'i + b').length]"), "[0,1]");
}

#[test]
fn forms_values_and_focus() {
    let mut e = Env::new(
        r#"<html><body>
        <form id="f" action="/submit">
          <input id="t" name="q" value="initial">
          <textarea id="ta" name="msg">hello
world</textarea>
          <input id="cb" type="checkbox" name="c" value="yes" checked>
          <input id="r1" type="radio" name="r" value="1" checked><input id="r2" type="radio" name="r" value="2">
          <select id="sel" name="s"><option>a</option><option value="bv" selected>b</option><optgroup><option>c</option></optgroup></select>
          <input id="range" type="range" min="0" max="10">
          <button id="btn">go</button>
        </form>
        <div id="plain">not focusable</div><div id="tab" tabindex="-1">focusable</div>
        </body></html>"#,
    );
    let doc = &mut e.doc;
    e.rt.document_parsed(doc);
    e.eval("globalThis.N = __native; globalThis.$ = id => N.getElementById(id); 1");
    assert_eq!(e.eval("N.getValue($('t'))"), "\"initial\"");
    assert_eq!(e.eval("N.getValue($('ta'))"), "\"hello\\nworld\"");
    assert_eq!(
        e.eval("N.setValue($('t'), 'changed'); [N.getValue($('t')), N.getAttr($('t'), 'value')]"),
        r#"["changed","initial"]"#
    );
    // Once dirty, the value attribute no longer changes the value.
    assert_eq!(
        e.eval("N.setAttr($('t'), 'value', 'attr2'); N.getValue($('t'))"),
        "\"changed\""
    );
    assert_eq!(
        e.eval("N.setValue($('ta'), 'a\\r\\nb'); N.getValue($('ta'))"),
        "\"a\\nb\""
    );
    // Checkboxes / radios
    assert_eq!(
        e.eval("[N.getChecked($('cb')), N.getChecked($('r1')), N.getChecked($('r2'))]"),
        "[true,true,false]"
    );
    assert_eq!(
        e.eval("N.setChecked($('r2'), true); [N.getChecked($('r1')), N.getChecked($('r2'))]"),
        "[false,true]"
    );
    assert_eq!(
        e.eval("N.setChecked($('cb'), false); N.getChecked($('cb'))"),
        "false"
    );
    assert_eq!(
        e.eval("N.matches($('r2'), ':checked') && !N.matches($('cb'), ':checked')"),
        "true"
    );
    // Select
    assert_eq!(
        e.eval("[N.getSelectedIndex($('sel')), N.getValue($('sel'))]"),
        r#"[1,"bv"]"#
    );
    assert_eq!(
        e.eval(
            "N.setSelectedIndex($('sel'), 2); [N.getSelectedIndex($('sel')), N.getValue($('sel'))]"
        ),
        r#"[2,"c"]"#
    );
    assert_eq!(
        e.eval("N.setValue($('sel'), 'a'); N.getSelectedIndex($('sel'))"),
        "0"
    );
    assert_eq!(
        e.eval("N.setValue($('sel'), 'zzz'); N.getSelectedIndex($('sel'))"),
        "-1"
    );
    // Options' selectedness through getChecked
    assert_eq!(e.eval("N.setSelectedIndex($('sel'), 1); N.getChecked(N.childIds($('sel')).filter(i => N.nodeType(i) === 1)[1])"), "true");
    // Range default value + sanitization
    assert_eq!(e.eval("N.getValue($('range'))"), "\"5\"");
    assert_eq!(
        e.eval("N.setValue($('range'), '42'); N.getValue($('range'))"),
        "\"10\""
    );
    // Focus
    assert_eq!(e.eval("N.activeElement()"), "0");
    assert_eq!(
        e.eval("N.focus($('t')); N.activeElement() === $('t')"),
        "true"
    );
    assert_eq!(e.eval("N.matches($('t'), ':focus')"), "true");
    assert_eq!(
        e.eval("N.focus($('plain')); N.activeElement() === $('t')"),
        "true"
    );
    assert_eq!(
        e.eval("N.focus($('tab')); N.activeElement() === $('tab')"),
        "true"
    );
    assert_eq!(e.eval("N.blur($('tab')); N.activeElement()"), "0");
    // submitForm navigates with the form data (GET)
    e.eval("N.setValue($('t'), 'a b&c'); N.submitForm($('f'), 0); 1");
    let navs = e.host.navigations.borrow().clone();
    assert_eq!(navs.len(), 1);
    assert_eq!(navs[0].method, "GET");
    assert_eq!(
        navs[0].url,
        "https://example.com/submit?q=a+b%26c&msg=a%0D%0Ab&r=2&s=bv"
    );
}

#[test]
fn form_post_multipart_and_submitter() {
    let mut e = Env::new(
        r#"<html><body>
        <form id="f" method="post" action="https://other.org/post" enctype="multipart/form-data">
          <input name="a" value="1"><input type="hidden" name="_charset_">
          <button id="b1" name="which" value="one">1</button>
          <button id="b2" name="which" value="two" formaction="/alt" formmethod="get">2</button>
          <input name="dis" value="x" disabled>
          <fieldset disabled><input name="infs" value="y"></fieldset>
        </form></body></html>"#,
    );
    e.eval("globalThis.N = __native; globalThis.$ = id => N.getElementById(id); 1");
    e.eval("N.submitForm($('f'), $('b1')); 1");
    e.eval("N.submitForm($('f'), $('b2')); 1");
    let navs = e.host.navigations.borrow().clone();
    assert_eq!(navs.len(), 2);
    assert_eq!(navs[0].method, "POST");
    assert_eq!(navs[0].url, "https://other.org/post");
    let ct = navs[0].content_type.clone().unwrap();
    assert!(ct.starts_with("multipart/form-data; boundary="), "{ct}");
    let body = String::from_utf8(navs[0].body.clone().unwrap()).unwrap();
    assert!(body.contains("name=\"a\"\r\n\r\n1\r\n"), "{body}");
    assert!(body.contains("name=\"_charset_\"\r\n\r\nUTF-8"), "{body}");
    assert!(body.contains("name=\"which\"\r\n\r\none"), "{body}");
    assert!(
        !body.contains("two") && !body.contains("dis") && !body.contains("infs"),
        "{body}"
    );
    assert_eq!(navs[1].method, "GET");
    assert_eq!(
        navs[1].url,
        "https://example.com/alt?a=1&_charset_=UTF-8&which=two"
    );
}

#[test]
fn timers_ordering_and_hooks() {
    let mut e = env();
    e.eval(
        r#"
        globalThis.log = [];
        N.setHooks({
            onTimer(id) {
                log.push('t' + id);
                Promise.resolve().then(() => log.push('m' + id));
                if (id === 2) N.setTimer(5, 0);
            },
        });
        N.setTimer(1, 30);
        N.setTimer(2, 0);
        N.setTimer(3, 0);
        N.setTimer(4, 10);
        N.clearTimer(3);
        1
    "#,
    );
    assert!(e.rt.next_timer_deadline().is_some());
    assert!(e.rt.is_busy());
    std::thread::sleep(std::time::Duration::from_millis(40));
    let doc = &mut e.doc;
    e.rt.run_timers(doc);
    // Timer 5 was created while running timers: it runs in the next round.
    assert_eq!(e.eval("log.join(',')"), "\"t2,m2,t4,m4,t1,m1\"");
    let doc = &mut e.doc;
    e.rt.run_timers(doc);
    assert_eq!(e.eval("log.join(',')"), "\"t2,m2,t4,m4,t1,m1,t5,m5\"");
    assert!(e.rt.next_timer_deadline().is_none());
    assert!(!e.rt.is_busy());
}

#[test]
fn microtasks_and_rejections() {
    let mut e = env();
    // Microtasks run at the end of the entry, after synchronous code.
    assert_eq!(
        e.eval("globalThis.order = []; Promise.resolve().then(() => order.push('micro')); order.push('sync'); order.join()"),
        "\"sync\""
    );
    assert_eq!(e.eval("order.join()"), "\"sync,micro\"");
    // An unhandled rejection is reported after the checkpoint...
    e.eval("Promise.reject(new Error('boom')); 1");
    assert!(
        e.host
            .errors()
            .iter()
            .any(|m| m.contains("Uncaught (in promise)") && m.contains("boom"))
    );
    // ...but not if a handler is attached within the same task.
    let before = e.host.errors().len();
    e.eval(
        "const p = Promise.reject(new Error('handled')); setTimeoutLike = 1; p.catch(() => {}); 1",
    );
    assert_eq!(e.host.errors().len(), before);
    // With an onUnhandledRejection hook the JS layer does the reporting...
    e.eval(
        "globalThis.rh = []; N.setHooks({ onUnhandledRejection(p, r) { globalThis.seen = String(r); globalThis.lastP = p; }, \
         onRejectionHandled(p, r) { rh.push(String(r) + (p === lastP)); } }); Promise.reject('why'); 1",
    );
    assert_eq!(e.eval("seen"), "\"why\"");
    assert_eq!(e.host.errors().len(), before);
    // ...and hears about handlers attached later (as a task).
    e.eval("lastP.catch(() => {}); 1");
    let doc = &mut e.doc;
    e.rt.run_timers(doc);
    assert_eq!(e.eval("rh"), r#"["whytrue"]"#);
    // Promise results are awaited by eval.
    assert_eq!(e.eval("Promise.resolve(41).then(x => x + 1)"), "42");
}

#[test]
fn eval_stringification_and_errors() {
    let mut e = env();
    assert_eq!(e.eval("({a: 1, b: [2, 'x']})"), r#"{"a":1,"b":[2,"x"]}"#);
    assert_eq!(e.eval("'str'"), "\"str\"");
    assert_eq!(e.eval("undefined"), "undefined");
    assert_eq!(e.eval("(function f() {})"), "function f() {}");
    assert_eq!(
        e.eval("const cyc = {}; cyc.self = cyc; cyc"),
        "[object Object]"
    );
    let err = e.eval_err("throw new TypeError('bad thing')");
    assert!(err.starts_with("TypeError: bad thing"), "{err}");
    let err = e.eval_err("function f() { null.x } f()");
    assert!(err.contains("TypeError") && err.contains("at f"), "{err}");
    let err = e.eval_err("syntax error here");
    assert!(err.contains("SyntaxError"), "{err}");
    // Hooks that throw are reported to the console with a stack.
    e.eval("N.setHooks({ onTimer() { throw new Error('in hook') } }); N.setTimer(1, 0); 1");
    let doc = &mut e.doc;
    e.rt.run_timers(doc);
    assert!(
        e.host
            .errors()
            .iter()
            .any(|m| m.contains("Uncaught Error: in hook") && m.contains("onTimer")),
        "{:?}",
        e.host.errors()
    );
}

#[test]
fn eval_script_and_compile_function() {
    let mut e = env();
    assert_eq!(
        e.eval("N.evalScript('var gx = 5; gx * 2', 'https://example.com/a.js', false)"),
        "10"
    );
    assert_eq!(e.eval("gx"), "5");
    // Errors are reported and re-thrown.
    let err = e.eval_err(
        "N.evalScript('throw new Error(\"script err\")', 'https://example.com/b.js', false)",
    );
    assert!(err.contains("script err"), "{err}");
    assert!(
        e.host
            .errors()
            .iter()
            .any(|m| m.contains("script err") && m.contains("b.js")),
        "{:?}",
        e.host.errors()
    );
    // compileFunction with argument names and a scope chain.
    let r = e.eval(
        r#"
        const f = N.compileFunction('return event.type + ":" + x + ":" + y', ['event'], 'https://example.com/#handler', [{x: 'outer', y: 'y1'}, {x: 'inner'}]);
        f({type: 'click'})
    "#,
    );
    assert_eq!(r, "\"click:inner:y1\"");
    let err = e.eval_err("N.compileFunction('return (', [], 'x')");
    assert!(err.contains("SyntaxError"), "{err}");
}

#[test]
fn modules_static_dynamic_and_meta() {
    let mut e = env();
    e.host.serve(
        "https://example.com/js/main.js",
        "text/javascript",
        r#"
        import { add } from './lib/math.js';
        import def, { name } from '/js/other.js';
        globalThis.result = add(2, 3) + ':' + name + ':' + def();
        globalThis.metaUrl = import.meta.url;
        globalThis.resolved = import.meta.resolve('./x.js');
    "#,
    );
    e.host.serve(
        "https://example.com/js/lib/math.js",
        "application/javascript",
        r#"
        import { name } from '../other.js';
        export const add = (a, b) => a + b;
        export const seenName = name;
    "#,
    );
    e.host.serve(
        "https://example.com/js/other.js",
        "text/javascript",
        r#"
        export const name = 'other';
        export default function () { return 'def'; }
        await Promise.resolve();
    "#,
    );
    e.host.serve(
        "https://example.com/js/dyn.js",
        "text/javascript",
        "export const v = 7;",
    );
    e.eval("globalThis.done = null; N.runModule('/js/main.js', null).then(() => done = 'ok', e => done = 'err:' + e); 1");
    assert_eq!(e.eval("done"), "null");
    let n = e.serve_fetches();
    assert_eq!(n, 3, "each module fetched exactly once");
    assert_eq!(e.eval("done"), "\"ok\"");
    assert_eq!(e.eval("result"), "\"5:other:def\"");
    assert_eq!(e.eval("metaUrl"), "\"https://example.com/js/main.js\"");
    assert_eq!(e.eval("resolved"), "\"https://example.com/js/x.js\"");
    // Dynamic import from a classic script resolves against the document base URL.
    e.eval("globalThis.dyn = null; import('./../js/dyn.js').then(m => dyn = m.v, e => dyn = String(e)); 1");
    e.serve_fetches();
    assert_eq!(e.eval("dyn"), "7");
    // Already-loaded modules are not fetched again.
    e.eval("import('https://example.com/js/other.js').then(m => globalThis.again = m.name); 1");
    assert_eq!(e.serve_fetches(), 0);
    assert_eq!(e.eval("again"), "\"other\"");
    // Inline module source + errors.
    e.eval("N.runModule('https://example.com/dir/page.html#inline1', 'import x from \"./missing.js\"').catch(e => globalThis.inlineErr = String(e)); 1");
    e.serve_fetches();
    assert!(
        e.eval("inlineErr").contains("404"),
        "{}",
        e.eval("inlineErr")
    );
    e.eval("N.runModule('https://example.com/inl2.js', 'throw new Error(\"top-level\")').catch(e => globalThis.tlErr = e.message); 1");
    assert_eq!(e.eval("tlErr"), "\"top-level\"");
    e.eval("import('bare-specifier').catch(e => globalThis.bareErr = e.name); 1");
    assert_eq!(e.eval("bareErr"), "\"TypeError\"");
    // Wrong MIME type is rejected.
    e.host
        .serve("https://example.com/js/html.js", "text/html", "<html>");
    e.eval("import('/js/html.js').catch(e => globalThis.mimeErr = e.message); 1");
    e.serve_fetches();
    assert!(e.eval("mimeErr").contains("MIME"), "{}", e.eval("mimeErr"));
    assert!(!e.rt.is_busy());
}

#[test]
fn structured_clone() {
    let mut e = env();
    let r = e.eval(
        r#"
        const src = { a: [1, { b: 'x' }], d: new Date(0), m: new Map([[1, 'one']]), s: new Set([2]), r: /re/g, u8: new Uint8Array([1, 2]) };
        src.self = src;
        const c = N.structuredClone(src);
        [c !== src, c.self === c, c.a[1].b, c.d.getTime(), c.m.get(1), c.s.has(2), c.r.source + c.r.flags, c.u8[1], c.a !== src.a]
    "#,
    );
    assert_eq!(r, r#"[true,true,"x",0,"one",true,"reg",2,true]"#);
    let err = e.eval_err("N.structuredClone({ f() {} })");
    assert!(err.contains("DataCloneError"), "{err}");
}

#[test]
fn text_encoding() {
    let mut e = env();
    assert_eq!(
        e.eval("Array.from(new Uint8Array(N.textEncode('aé€😀')))"),
        "[97,195,169,226,130,172,240,159,152,128]"
    );
    assert_eq!(e.eval("N.textEncode('').byteLength"), "0");
    assert_eq!(
        e.eval("N.textDecode(new Uint8Array([0xEF,0xBB,0xBF,104,105]), 'utf-8', false)"),
        "\"hi\""
    );
    assert_eq!(
        e.eval("N.textDecode(new Uint8Array([104, 0xFF, 105]).buffer, 'utf8', false)"),
        "\"h\u{FFFD}i\""
    );
    let err = e.eval_err("N.textDecode(new Uint8Array([0xFF]), 'utf-8', true)");
    assert!(err.contains("TypeError"), "{err}");
    assert_eq!(
        e.eval("N.textDecode(new Uint8Array([0xE9, 0x80]), 'windows-1252', false)"),
        "\"é€\""
    );
    assert_eq!(
        e.eval("N.textDecode(new Uint8Array([0xE9]), 'latin1', false)"),
        "\"é\""
    );
    assert_eq!(
        e.eval("N.textDecode(new Uint8Array([0xFF, 0xFE, 0x68, 0, 0x69, 0]), 'utf-16le', false)"),
        "\"hi\""
    );
    let err = e.eval_err("N.textDecode(new Uint8Array([]), 'no-such-encoding', false)");
    assert!(err.contains("RangeError"), "{err}");
    // Views with offsets
    assert_eq!(
        e.eval("N.textDecode(new Uint8Array([120, 97, 98, 120]).subarray(1, 3), 'utf-8', false)"),
        "\"ab\""
    );
}

#[test]
fn urls() {
    let mut e = env();
    assert_eq!(
        e.eval("N.urlParse('https://user:pw@例え.jp:8080/a/../b?q=1#frag', null)"),
        r##"["https://user:pw@xn--r8jz45g.jp:8080/b?q=1#frag","https:","user","pw","xn--r8jz45g.jp:8080","xn--r8jz45g.jp","8080","/b","?q=1","#frag","https://xn--r8jz45g.jp:8080"]"##
    );
    assert_eq!(
        e.eval("N.urlParse('../x?y', 'https://a.com/b/c/d')[0]"),
        "\"https://a.com/b/x?y\""
    );
    assert_eq!(e.eval("N.urlParse('nope', null)"), "null");
    assert_eq!(e.eval("N.urlParse('x', 'not a base')"), "null");
    assert_eq!(
        e.eval("N.urlParse('HTTP://EXAMPLE.com:80/', null)[0]"),
        "\"http://example.com/\""
    );
    assert_eq!(
        e.eval("N.urlSet('https://a.com/p?q#h', 'pathname', '/new path')[0]"),
        "\"https://a.com/new%20path?q#h\""
    );
    assert_eq!(
        e.eval("N.urlSet('https://a.com/', 'port', 'abc')[6]"),
        "\"\""
    );
    assert_eq!(
        e.eval("N.urlSet('https://a.com/', 'hash', 'x')[9]"),
        "\"#x\""
    );
    assert_eq!(
        e.eval("N.location()"),
        "\"https://example.com/dir/page.html\""
    );
    assert_eq!(e.eval("N.userAgent()"), "\"TestBrowser/1.0\"");
    assert_eq!(e.eval("N.randomBytes(16).byteLength"), "16");
    let err = e.eval_err("N.randomBytes(70000)");
    assert!(err.contains("QuotaExceededError"), "{err}");
    assert_eq!(
        e.eval("const t0 = N.now(); t0 >= 0 && N.now() >= t0 && N.timeOrigin() > 1.6e12"),
        "true"
    );
}

#[test]
fn storage_persistence() {
    let dir = common::temp_dir("storage");
    {
        let mut e = Env::with_profile(BASIC, dir.clone(), false);
        e.eval("globalThis.N = __native; N.storageSet(0, 'k', 'v1'); N.storageSet(0, 'k2', 'ü'); N.storageSet(1, 's', 'session'); 1");
        assert_eq!(
            e.eval("[N.storageGet(0, 'k'), N.storageGet(0, 'none'), N.storageKeys(0)]"),
            r#"["v1",null,["k","k2"]]"#
        );
        e.eval("N.storageRemove(0, 'k2'); 1");
        let doc = &mut e.doc;
        e.rt.page_hide(doc);
    }
    let file = dir.join("localstorage").join("https___example.com.json");
    assert!(file.exists(), "localStorage file written");
    {
        let mut e = Env::with_profile(BASIC, dir.clone(), false);
        e.eval("globalThis.N = __native; 1");
        assert_eq!(
            e.eval("[N.storageGet(0, 'k'), N.storageGet(0, 'k2')]"),
            r#"["v1",null]"#
        );
        // sessionStorage is per process (tab) and survives the runtime.
        assert_eq!(e.eval("N.storageGet(1, 's')"), "\"session\"");
        e.eval("N.storageClear(0); N.storageSet(0, 'after', 'x'); 1");
        // Written on drop.
    }
    {
        let mut e = Env::with_profile(BASIC, dir.clone(), false);
        e.eval("globalThis.N = __native; 1");
        assert_eq!(e.eval("N.storageKeys(0)"), r#"["after"]"#);
        let err = e.eval_err("N.storageSet(0, 'big', 'x'.repeat(6 * 1024 * 1024))");
        assert!(err.contains("QuotaExceededError"), "{err}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn fetch_and_cookies() {
    let mut e = env();
    e.eval(
        r#"
        globalThis.got = null;
        N.setHooks({ onFetch(id, status, statusText, url, headers, body, err) {
            got = [id, status, statusText, url, headers, err, N.textDecode(body, 'utf-8', false)];
        }});
        N.fetch(7, 'post', 'api/data?x=1', ['content-type', 'text/plain', 'x-a', 'b'], 'payload', 'cors');
        N.fetch(8, 'GET', 'https://other.org/', [], null, 'no-cors');
        N.abortFetch(8);
        1
    "#,
    );
    {
        let reqs = e.host.fetches.borrow();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].id, 7);
        assert_eq!(reqs[0].method, "POST");
        assert_eq!(reqs[0].url, "https://example.com/dir/api/data?x=1");
        assert_eq!(
            reqs[0].headers,
            vec![
                ("content-type".to_string(), "text/plain".to_string()),
                ("x-a".to_string(), "b".to_string())
            ]
        );
        assert_eq!(reqs[0].body.as_deref(), Some(&b"payload"[..]));
        assert_eq!(e.host.aborted.borrow().as_slice(), &[8]);
    }
    assert!(e.rt.is_busy());
    let resp = common_resp(7, 201, "hello");
    let doc = &mut e.doc;
    e.rt.deliver_fetch(doc, resp);
    // Aborted request: late response ignored.
    let doc = &mut e.doc;
    e.rt.deliver_fetch(doc, common_resp(8, 200, "late"));
    assert_eq!(
        e.eval("got[0] + ':' + got[1] + ':' + got[6] + ':' + got[4].join('=') + ':' + got[5]"),
        "\"7:201:hello:x-h=1:null\""
    );
    assert!(!e.rt.is_busy());
    // Cookies go through the host.
    e.eval("N.setCookie('a=1; Path=/'); N.setCookie('b=2'); 1");
    assert_eq!(e.eval("N.getCookie()"), "\"a=1; b=2\"");
}

fn common_resp(id: u64, status: u16, body: &str) -> ::common::protocol::NetResponse {
    ::common::protocol::NetResponse {
        id,
        status,
        status_text: "X".into(),
        url: "https://example.com/dir/api/data?x=1".into(),
        headers: vec![("x-h".into(), "1".into())],
        body: body.as_bytes().to_vec(),
        ..Default::default()
    }
}

#[test]
fn navigation_and_history() {
    let mut e = env();
    // Fragment navigation stays in the document: new history entry, popstate hook.
    e.eval("globalThis.ps = []; N.setHooks({ onPopState(u, i) { ps.push(u + ' @' + i); } }); 1");
    assert_eq!(e.eval("[N.historyIndex(), N.historyLength()]"), "[0,1]");
    assert_eq!(e.eval("N.navigate('#p', false)"), "true");
    assert_eq!(
        e.eval("N.location()"),
        "\"https://example.com/dir/page.html#p\""
    );
    assert_eq!(
        e.host.url_changes.borrow().last().unwrap(),
        "https://example.com/dir/page.html#p"
    );
    assert_eq!(
        e.host.history_pushes.borrow().last().unwrap(),
        &("https://example.com/dir/page.html#p".to_string(), false)
    );
    assert_eq!(
        e.eval("[ps, N.historyIndex(), N.historyLength()]"),
        r#"[["https://example.com/dir/page.html#p @1"],1,2]"#
    );
    // Navigating to the current fragment again only scrolls.
    e.eval("N.navigate('#p', false); 1");
    assert_eq!(e.eval("ps.length"), "1");
    // The host traverses back to the first entry.
    let doc = &mut e.doc;
    e.rt.history_traversed(doc, "https://example.com/dir/page.html", 0);
    assert_eq!(
        e.eval("[ps[1], N.location(), N.historyIndex(), N.historyLength()]"),
        r#"["https://example.com/dir/page.html @0","https://example.com/dir/page.html",0,2]"#
    );
    // Cross-document navigation goes to the host.
    assert_eq!(e.eval("N.navigate('other.html?x', true)"), "false");
    assert_eq!(
        e.host.navigations.borrow().last().unwrap(),
        &common::Nav {
            url: "https://example.com/dir/other.html?x".into(),
            replace: true,
            method: "GET".into(),
            body: None,
            content_type: None
        }
    );
    // javascript: URLs run in the page.
    assert_eq!(
        e.eval("N.navigate('javascript:globalThis.jsran=1', false); jsran"),
        "1"
    );
    // pushState-like URL changes
    e.eval("N.historyPush('/new/path?q', false); 1");
    assert_eq!(e.eval("N.location()"), "\"https://example.com/new/path?q\"");
    assert_eq!(e.rt.document_url(), "https://example.com/new/path?q");
    assert_eq!(e.eval("[N.historyIndex(), N.historyLength()]"), "[1,2]");
    e.eval("N.historyPush('/replaced', true); 1");
    assert_eq!(
        e.eval("[N.location(), N.historyIndex(), N.historyLength()]"),
        r#"["https://example.com/replaced",1,2]"#
    );
    assert_eq!(
        e.host.history_pushes.borrow().last().unwrap(),
        &("https://example.com/replaced".to_string(), true)
    );
    // referrer / window.open / clipboard go to the host
    *e.host.referrer.borrow_mut() = "https://ref.example/".into();
    e.eval("N.openWindow('popup.html', '_blank', ''); N.clipboardWrite('copied'); 1");
    assert_eq!(e.eval("N.referrer()"), r#""https://ref.example/""#);
    assert_eq!(
        e.host.new_tabs.borrow().last().unwrap(),
        "https://example.com/popup.html"
    );
    assert_eq!(
        e.host.clipboard.borrow().as_slice(),
        &["copied".to_string()]
    );
    let err = e.eval_err("N.historyPush('https://evil.com/', false)");
    assert!(err.contains("SecurityError"), "{err}");
    e.eval("N.historyGo(-1); N.setTitle('New'); N.reload(); N.log('warn', 'w'); 1");
    assert_eq!(e.host.history.borrow().as_slice(), &[-1]);
    assert_eq!(e.host.titles.borrow().as_slice(), &["New".to_string()]);
    assert!(
        e.host
            .console
            .borrow()
            .contains(&("warn".to_string(), "w".to_string()))
    );
}

#[test]
fn release_node_frees_detached_trees() {
    let mut e = env();
    let r = e.eval(
        r#"
        const a = N.createElement('div', '');
        N.setInnerHTML(a, '<span><b>x</b></span>');
        const inner = N.firstChild(a);           // exposed
        N.releaseNode(a);                        // `inner` still referenced: kept
        const aliveAfterFirst = N.localName(a);
        N.releaseNode(inner);                    // nothing exposed any more: tree freed
        let freed = false;
        try { N.localName(a); } catch (e) { freed = e instanceof TypeError; }
        // Connected nodes are never freed.
        const p = N.getElementById('p');
        N.releaseNode(p);
        [aliveAfterFirst, freed, N.localName(p), N.isConnected(p)]
    "#,
    );
    assert_eq!(r, r#"["div",true,"p",true]"#);
}

#[test]
fn element_events() {
    let mut e = env();
    e.eval("globalThis.ev = []; N.setHooks({ onElementEvent(id, t) { ev.push(N.getAttr(id, 'id') + ':' + t); } }); 1");
    let id = script::node_id_from_js(e.eval("N.getElementById('s1')").parse().unwrap()).unwrap();
    let doc = &mut e.doc;
    e.rt.element_event(doc, id, "load");
    let doc = &mut e.doc;
    e.rt.element_event(doc, id, "error");
    // Non-elements are ignored.
    let text = script::node_id_from_js(
        e.eval("N.firstChild(N.getElementById('s1'))")
            .parse()
            .unwrap(),
    )
    .unwrap();
    let doc = &mut e.doc;
    e.rt.element_event(doc, text, "load");
    assert_eq!(e.eval("ev"), r#"["s1:load","s1:error"]"#);
}

#[test]
fn frames() {
    let mut e = env();
    assert!(!e.rt.wants_frame());
    e.eval("globalThis.ts = null; N.setHooks({ onFrame(t) { ts = t; } }); N.requestFrame(); 1");
    assert!(e.rt.wants_frame());
    let doc = &mut e.doc;
    e.rt.run_frame(doc, 123.5);
    assert!(!e.rt.wants_frame());
    assert_eq!(e.eval("ts"), "123.5");
}

#[test]
fn watchdog_terminates_long_scripts() {
    let mut e = env();
    e.rt.set_script_timeout(std::time::Duration::from_millis(300));
    let t0 = std::time::Instant::now();
    let err = e.eval_err("while (true) {}");
    assert!(t0.elapsed() < std::time::Duration::from_secs(5));
    assert!(err.contains("terminated"), "{err}");
    assert!(e.host.errors().iter().any(|m| m.contains("script timeout")));
    // The runtime keeps working afterwards.
    assert_eq!(e.eval("1 + 1"), "2");
}

#[test]
fn natives_never_panic_on_garbage() {
    let mut e = env();
    // Call every native with a variety of bad arguments; all must either return or
    // throw a JS exception (a panic would abort the test).
    e.eval(
        r#"
        const bad = [undefined, null, 0, -1, 1e300, NaN, 'str', {}, [], Symbol('s'), () => 1, 2 ** 53, 3.5];
        let calls = 0;
        for (const name of Object.keys(N)) {
            if (['navigate', 'reload', 'historyGo', 'submitForm', 'requestSubmit', 'runDefaultAction', 'evalScript', 'setHooks'].includes(name)) continue;
            for (const a of bad) for (const b of bad) {
                try { N[name](a, b, a, b); } catch (e) {}
                calls++;
            }
        }
        calls
    "#,
    );
    assert!(
        e.host
            .errors()
            .iter()
            .all(|m| !m.contains("internal error")),
        "{:?}",
        e.host.errors()
    );
}
