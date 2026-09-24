'use strict';
const assert = require('assert');
const { createEnv } = require('../harness');

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>  Hello   World </title><base href="https://example.com/app/"></head>
<body><div id="main" class="a b" data-user-id="42" title="t"><p id="p1">One <b>bold</b></p><p id="p2">Two</p><!-- c --></div>
<ul id="list"><li>1</li><li class="odd">2</li><li>3</li></ul><a id="lnk" href="page?x=1#top">link</a><img id="im" src="/i.png">
<svg id="svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/><foreignObject><div>fo</div></foreignObject></svg>
<table id="t"><tbody><tr><td>a</td><td>b</td></tr></tbody></table><template id="tpl"><span class="in-tpl">T</span></template></body></html>`;

async function env() { return createEnv({ html: PAGE, url: 'https://example.com/app/index.html' }); }

test('wrapper identity, prototype chains, toStringTag', async () => {
  const e = await env();
  assert.strictEqual(e.run("document.getElementById('main') === document.querySelector('div')"), true);
  assert.strictEqual(e.run("document.getElementById('p1').parentNode === document.getElementById('main')"), true);
  assert.strictEqual(e.run("document.body.firstElementChild === document.getElementById('main')"), true);
  assert.strictEqual(e.run(`[HTMLDivElement, HTMLElement, Element, Node, EventTarget].every(C => document.getElementById('main') instanceof C)`), true);
  assert.strictEqual(e.run("document.createTextNode('x') instanceof Text && document.createComment('c') instanceof CharacterData"), true);
  assert.strictEqual(e.run("document.createDocumentFragment() instanceof DocumentFragment"), true);
  assert.strictEqual(e.run("Object.getPrototypeOf(HTMLDocument.prototype) === Document.prototype"), true);
  assert.strictEqual(e.run("document.getElementById('svg') instanceof SVGSVGElement && document.querySelector('circle') instanceof SVGGraphicsElement && document.querySelector('circle') instanceof SVGElement"), true);
  assert.strictEqual(e.run("Object.prototype.toString.call(document.getElementById('p1'))"), '[object HTMLParagraphElement]');
  assert.strictEqual(e.run("Object.prototype.toString.call(document)"), '[object HTMLDocument]');
  assert.strictEqual(e.run("Object.prototype.toString.call(document.body.childNodes)"), '[object NodeList]');
  assert.strictEqual(e.run("Object.prototype.toString.call(document.body.children)"), '[object HTMLCollection]');
  assert.strictEqual(e.run("document.querySelector('foreignObject div') instanceof HTMLDivElement"), true);
  assert.strictEqual(e.run("new Text('hi').data + new Comment('c').nodeType + new DocumentFragment().nodeType"), 'hi811');
  assert.strictEqual(e.run("(() => { try { new Node(); } catch (e) { return e instanceof TypeError; } })()"), true);
  assert.strictEqual(e.run("(() => { try { document.createElement('<div>'); } catch (e) { return e.name; } })()"), 'InvalidCharacterError');
  assert.strictEqual(e.run("typeof Node.ELEMENT_NODE === 'number' && document.body.ELEMENT_NODE === 1"), true);
  assert.strictEqual(e.run("Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild').enumerable"), true);
});

test('tree accessors and mutation methods', async () => {
  const e = await env();
  e.run(`
    var main = document.getElementById('main');
    var d = document.createElement('div'); d.id = 'new';
    main.appendChild(d);
    var s = document.createElement('span');
    main.insertBefore(s, main.firstChild);
    d.append('text', document.createElement('i'));
    d.prepend(document.createElement('u'));
    s.after(document.createElement('em'));
    s.before('pre');
  `);
  assert.strictEqual(e.run("main.firstChild.nodeValue"), 'pre');
  assert.strictEqual(e.run("main.children[0].tagName + main.children[1].tagName"), 'SPANEM');
  assert.strictEqual(e.run("d.innerHTML"), '<u></u>text<i></i>');
  assert.strictEqual(e.run("d.childNodes.length"), 3);
  e.run("var li = document.querySelector('.odd'); li.replaceWith(document.createElement('hr'), 'x');");
  assert.strictEqual(e.run("document.getElementById('list').innerHTML"), '<li>1</li><hr>x<li>3</li>');
  e.run("document.getElementById('list').replaceChildren('a', 'b')");
  assert.strictEqual(e.run("document.getElementById('list').childNodes.length + document.getElementById('list').textContent"), '2ab');
  e.run("d.remove()");
  assert.strictEqual(e.run("d.parentNode === null && d.isConnected === false"), true);
  assert.strictEqual(e.run("(() => { try { main.appendChild(main); } catch (e) { return e.name; } })()"), 'HierarchyRequestError');
  assert.strictEqual(e.run("(() => { try { main.appendChild(document.body); } catch (e) { return e.name + (e instanceof DOMException) + e.code; } })()"), 'HierarchyRequestErrortrue3');
  assert.strictEqual(e.run("(() => { try { main.removeChild(document.createElement('x')); } catch (e) { return e.name; } })()"), 'NotFoundError');
  assert.strictEqual(e.run("(() => { try { main.insertBefore(document.createElement('x'), document.body); } catch (e) { return e.name; } })()"), 'NotFoundError');
  e.run("var old = document.getElementById('p2'); var r = main.replaceChild(document.createElement('section'), old);");
  assert.strictEqual(e.run("r === old && old.parentNode === null && main.querySelector('section') !== null"), true);
  // live NodeList
  e.run("var kids = main.childNodes; var n0 = kids.length; main.appendChild(document.createElement('z-z'));");
  assert.strictEqual(e.run("kids.length === n0 + 1 && kids[kids.length - 1].localName === 'z-z'"), true);
  e.run("var ch = main.children; while (ch.length) main.removeChild(ch[0]);");
  assert.strictEqual(e.run("main.children.length"), 0);
  // fragment insertion moves children
  e.run("var f = document.createDocumentFragment(); f.appendChild(document.createElement('a')); f.appendChild(document.createElement('b')); main.appendChild(f);");
  assert.strictEqual(e.run("f.childNodes.length + ':' + main.children.length"), '0:2');
  // siblings & element siblings
  assert.strictEqual(e.run("main.lastElementChild.previousElementSibling.localName + main.firstElementChild.nextElementSibling.localName"), 'ab');
  assert.strictEqual(e.run("main.contains(main.firstChild) && !main.firstChild.contains(main) && main.contains(main)"), true);
  assert.strictEqual(e.run("main.compareDocumentPosition(main.firstChild) & Node.DOCUMENT_POSITION_CONTAINED_BY ? 1 : 0"), 1);
  assert.strictEqual(e.run("main.firstChild.compareDocumentPosition(main.lastChild) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0"), 1);
  assert.strictEqual(e.run("main.getRootNode() === document && document.createElement('q').getRootNode().localName"), 'q');
  assert.strictEqual(e.run("main.ownerDocument === document && document.ownerDocument === null"), true);
  assert.strictEqual(e.run("main.hasChildNodes() && !document.createElement('x').hasChildNodes()"), true);
});

test('text nodes, normalize, splitText, CharacterData', async () => {
  const e = await env();
  e.run("var p = document.createElement('p'); p.append('a', 'b', ''); p.appendChild(document.createTextNode('c'));");
  assert.strictEqual(e.run("p.childNodes.length"), 4);
  e.run("p.normalize()");
  assert.strictEqual(e.run("p.childNodes.length + p.firstChild.data"), '1abc');
  e.run("var t2 = p.firstChild.splitText(1)");
  assert.strictEqual(e.run("p.childNodes.length + p.firstChild.data + t2.data + t2.wholeText"), '2abcabc');
  e.run("t2.appendData('X'); t2.insertData(0, '<'); t2.deleteData(1, 1); t2.replaceData(0, 1, '>');");
  assert.strictEqual(e.run("t2.data + t2.length + t2.substringData(1, 1)"), '>cX3c');
  assert.strictEqual(e.run("(() => { try { t2.substringData(10, 1) } catch (e) { return e.name } })()"), 'IndexSizeError');
  assert.strictEqual(e.run("document.createComment('x').nodeName + document.createTextNode('').nodeName + document.nodeName + document.createDocumentFragment().nodeName"), '#comment#text#document#document-fragment');
  e.run("p.firstChild.nodeValue = 'zz'");
  assert.strictEqual(e.run("p.textContent"), 'zz>cX');
});

test('attributes, Attr and NamedNodeMap, NS variants', async () => {
  const e = await env();
  e.run("var el = document.createElement('div'); el.setAttribute('Data-X', 'y'); el.setAttribute('title', 'hi');");
  assert.strictEqual(e.run("el.getAttribute('data-x') + el.getAttribute('DATA-X') + el.hasAttribute('data-x')"), 'yytrue');
  assert.deepStrictEqual(Array.from(e.run("el.getAttributeNames()")), ['data-x', 'title']);
  assert.strictEqual(e.run("el.attributes.length + el.attributes[0].name + el.attributes.title.value + el.attributes.getNamedItem('title').value"), '2data-xhihi');
  assert.strictEqual(e.run("el.attributes[0] === el.attributes.item(0) && el.getAttributeNode('title').ownerElement === el"), true);
  assert.strictEqual(e.run("Array.from(el.attributes).map(a => a.name + '=' + a.value).join('&')"), 'data-x=y&title=hi');
  e.run("el.getAttributeNode('title').value = 'changed'");
  assert.strictEqual(e.run("el.title"), 'changed');
  e.run("var a = document.createAttribute('lang'); a.value = 'de'; el.setAttributeNode(a);");
  assert.strictEqual(e.run("el.lang + a.ownerElement.localName"), 'dediv');
  assert.strictEqual(e.run("el.toggleAttribute('hidden') + ':' + el.hidden + ':' + el.toggleAttribute('hidden') + ':' + el.hasAttribute('hidden')"), 'true:true:false:false');
  assert.strictEqual(e.run("el.toggleAttribute('x', true) && el.toggleAttribute('x', true) && el.hasAttribute('x')"), true);
  e.run("el.removeAttribute('x'); el.removeAttribute('never')");
  assert.strictEqual(e.run("el.hasAttributes() && !el.hasAttribute('x')"), true);
  assert.strictEqual(e.run("(() => { try { el.setAttribute('a b', 1) } catch (e) { return e.name } })()"), 'InvalidCharacterError');
  e.run("var use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#icon');");
  assert.strictEqual(e.run("use.getAttributeNS('http://www.w3.org/1999/xlink', 'href') + use.getAttribute('xlink:href') + use.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')"), '#icon#icontrue');
  e.run("use.setAttribute('viewBox', '0 0 1 1')");
  assert.strictEqual(e.run("use.getAttribute('viewBox') + use.getAttribute('viewbox')"), '0 0 1 1null');
  e.run("use.removeAttributeNS('http://www.w3.org/1999/xlink', 'href')");
  assert.strictEqual(e.run("use.hasAttribute('xlink:href')"), false);
  assert.strictEqual(e.run("document.getElementById('svg').getAttribute('viewBox')"), '0 0 10 10');
});

test('id/className/classList/dataset/hidden/title/lang/dir/tabIndex reflection', async () => {
  const e = await env();
  e.run("var m = document.getElementById('main')");
  assert.strictEqual(e.run("m.id + m.className + m.title"), 'maina bt');
  assert.strictEqual(e.run("m.classList.length + m.classList[1] + m.classList.value"), '2ba b');
  e.run("m.classList.add('c', 'a'); m.classList.toggle('b'); m.classList.replace('c', 'd')");
  assert.strictEqual(e.run("m.className"), 'a d');
  assert.strictEqual(e.run("m.classList.toggle('e', false) + ':' + m.classList.toggle('e', true) + ':' + m.classList.contains('e')"), 'false:true:true');
  assert.strictEqual(e.run("(() => { try { m.classList.add('') } catch (e) { return e.name } })()"), 'SyntaxError');
  assert.strictEqual(e.run("(() => { try { m.classList.add('a b') } catch (e) { return e.name } })()"), 'InvalidCharacterError');
  assert.strictEqual(e.run("[...m.classList].join('|')"), 'a|d|e');
  assert.strictEqual(e.run("m.dataset.userId"), '42');
  e.run("m.dataset.fooBarBaz = 'x'; delete m.dataset.userId;");
  assert.strictEqual(e.run("m.getAttribute('data-foo-bar-baz') + m.hasAttribute('data-user-id') + ('fooBarBaz' in m.dataset) + Object.keys(m.dataset).join()"), 'xfalsetruefooBarBaz');
  assert.strictEqual(e.run("document.documentElement.lang"), 'en');
  e.run("m.hidden = true; m.dir = 'rtl'; m.tabIndex = 3;");
  assert.strictEqual(e.run("m.getAttribute('hidden') === '' && m.dir === 'rtl' && m.getAttribute('tabindex') === '3' && m.tabIndex === 3"), true);
  assert.strictEqual(e.run("document.createElement('a').tabIndex + ',' + document.getElementById('lnk').tabIndex + ',' + document.createElement('input').tabIndex + ',' + document.createElement('div').tabIndex"), '-1,0,0,-1');
  assert.strictEqual(e.run("document.getElementById('svg').className.baseVal === '' && typeof document.getElementById('svg').className === 'object'"), true);
  e.run("document.getElementById('svg').classList.add('icon')");
  assert.strictEqual(e.run("document.getElementById('svg').getAttribute('class')"), 'icon');
});

test('style: CSSStyleDeclaration, cssText, aliases, computed style', async () => {
  const e = await env();
  e.run("var el = document.createElement('div'); document.body.appendChild(el); el.style.backgroundColor = 'red'; el.style.webkitTransform = 'scale(2)'; el.style['margin-top'] = '1px'; el.style.cssFloat = 'left';");
  assert.strictEqual(e.run("el.style.backgroundColor + '|' + el.style.transform + '|' + el.style.WebkitTransform + '|' + el.style.marginTop + '|' + el.style.float"), 'red|scale(2)|scale(2)|1px|left');
  assert.strictEqual(e.run("el.getAttribute('style')"), 'background-color: red; transform: scale(2); margin-top: 1px; float: left;');
  e.run("el.style.setProperty('color', 'blue', 'important'); el.style.setProperty('--brand', '#123');");
  assert.strictEqual(e.run("el.style.getPropertyValue('color') + el.style.getPropertyPriority('color') + el.style.getPropertyValue('--brand')"), 'blueimportant#123');
  assert.strictEqual(e.run("el.style.removeProperty('color')"), 'blue');
  assert.strictEqual(e.run("el.style.length"), 5);
  assert.strictEqual(e.run("el.style.item(0) + el.style[1]"), 'background-colortransform');
  e.run("el.style.cssText = 'width: 10px; height: 20px'");
  assert.strictEqual(e.run("el.style.width + el.style.height + el.style.backgroundColor + el.style.length"), '10px20px2');
  e.run("el.style.width = null; el.style.height = ''");
  assert.strictEqual(e.run("el.style.length"), 0);
  e.run("el.style = 'color: green'");
  assert.strictEqual(e.run("el.style.color"), 'green');
  assert.strictEqual(e.run("el.style === el.style"), true);
  assert.strictEqual(e.run("'MozTransform' in el.style"), false);
  assert.strictEqual(e.run("'webkitTransform' in el.style && 'WebkitTransition' in el.style"), true);
  const cs = e.run("var cs = getComputedStyle(el); [cs.color, cs.getPropertyValue('color'), cs.display, getComputedStyle(document.querySelector('span') || document.createElement('span')).display]");
  assert.deepStrictEqual(Array.from(cs), ['green', 'green', 'block', 'inline']);
  assert.strictEqual(e.run("(() => { try { cs.color = 'red' } catch (e) { return e.name } })()"), 'NoModificationAllowedError');
  assert.strictEqual(e.run("cs.length > 100 && typeof cs[0] === 'string'"), true);
  assert.strictEqual(e.run("getComputedStyle(document.head).display"), 'none');
  assert.strictEqual(e.run("CSS.supports('display', 'grid') && CSS.supports('(display: flex) and (color: red)') && !CSS.supports('not-a-property', 'x')"), true);
  assert.strictEqual(e.run("CSS.escape('a b#c') + '|' + CSS.escape('1x')"), 'a\\ b\\#c|\\31 x');
});

test('innerHTML/outerHTML/insertAdjacentHTML/textContent/innerText', async () => {
  const e = await env();
  e.run("var m = document.getElementById('main')");
  assert.strictEqual(e.run("m.innerHTML"), '<p id="p1">One <b>bold</b></p><p id="p2">Two</p><!-- c -->');
  e.run("m.innerHTML = '<span>a &amp; b</span><br><img src=x onerror=\"window.XSS=1\">'");
  assert.strictEqual(e.run("m.innerHTML"), '<span>a &amp; b</span><br><img src="x" onerror="window.XSS=1">');
  assert.strictEqual(e.run("m.firstChild.textContent + m.childNodes.length"), 'a & b3');
  e.run("m.insertAdjacentHTML('beforeend', '<i>end</i>'); m.insertAdjacentHTML('afterbegin', '<i>start</i>'); m.insertAdjacentHTML('beforebegin', '<hr id=before>'); m.insertAdjacentHTML('afterend', '<hr id=after>')");
  assert.strictEqual(e.run("m.firstChild.textContent + m.lastChild.textContent + m.previousSibling.id + m.nextSibling.id"), 'startendbeforeafter');
  e.run("var tb = document.querySelector('#t tbody'); tb.insertAdjacentHTML('beforeend', '<tr><td>c</td></tr>')");
  assert.strictEqual(e.run("document.querySelectorAll('#t tr').length + ':' + tb.lastChild.firstChild.textContent"), '2:c');
  e.run("m.outerHTML = '<section id=sec>replaced</section>'");
  assert.strictEqual(e.run("document.getElementById('sec').textContent + (document.getElementById('main') === null) + m.parentNode"), 'replacedtruenull');
  e.run("var s = document.getElementById('sec'); s.textContent = '<b>raw</b>'");
  assert.strictEqual(e.run("s.innerHTML + s.childNodes.length"), '&lt;b&gt;raw&lt;/b&gt;1');
  e.run("s.textContent = ''");
  assert.strictEqual(e.run("s.childNodes.length"), 0);
  e.run("s.innerHTML = '<p>para one</p><p>two<br>lines</p><div style=\"display:none\">hidden</div><span>  x   y </span>'");
  assert.strictEqual(e.run("s.innerText"), 'para one\n\ntwo\nlines\n\nx y');
  e.run("s.innerText = 'a\\nb'");
  assert.strictEqual(e.run("s.innerHTML"), 'a<br>b');
  assert.strictEqual(e.run("document.createElement('div').innerText"), '');
  assert.strictEqual(e.run("document.title"), 'Hello World');
  e.run("document.title = 'New'");
  assert.strictEqual(e.run("document.title + document.querySelector('title').textContent"), 'NewNew');
  assert.deepStrictEqual(e.mock.titles.slice(-1), ['New']);
});

test('cloneNode, importNode, isEqualNode, template content', async () => {
  const e = await env();
  e.run("var m = document.getElementById('main'); var c = m.cloneNode(true); var sh = m.cloneNode(false)");
  assert.strictEqual(e.run("c !== m && c.id === 'main' && c.querySelector('b').textContent === 'bold' && c.parentNode === null"), true);
  assert.strictEqual(e.run("sh.childNodes.length + sh.className"), '0a b');
  assert.strictEqual(e.run("c.isEqualNode(m) && !sh.isEqualNode(m) && m.isSameNode(m)"), true);
  e.run("var tpl = document.getElementById('tpl')");
  assert.strictEqual(e.run("tpl.content instanceof DocumentFragment && tpl.content === tpl.content && tpl.childNodes.length === 0"), true);
  assert.strictEqual(e.run("tpl.content.firstChild.className + tpl.innerHTML"), 'in-tpl<span class="in-tpl">T</span>');
  e.run("var inst = document.importNode(tpl.content, true); document.body.appendChild(inst);");
  assert.strictEqual(e.run("document.querySelectorAll('.in-tpl').length + ':' + tpl.content.childNodes.length"), '1:1');
  e.run("var t2 = document.createElement('template'); t2.innerHTML = '<tr><td>x</td></tr>';");
  assert.strictEqual(e.run("t2.content.firstChild.localName + t2.content.firstChild.firstChild.localName + t2.childNodes.length"), 'trtd0');
  e.run("var t3 = tpl.cloneNode(true)");
  assert.strictEqual(e.run("t3.content.firstChild.className + (t3.content !== tpl.content)"), 'in-tpltrue');
  e.run("var i1 = document.createElement('input'); i1.value = 'typed'; i1.type = 'checkbox'; i1.checked = true; var i2 = i1.cloneNode()");
  assert.strictEqual(e.run("i2.checked"), true);
});

test('selectors: querySelector(All), matches, closest, getElementsBy*, :scope', async () => {
  const e = await env();
  assert.strictEqual(e.run("document.querySelectorAll('#list li:nth-child(odd)').length"), 2);
  assert.strictEqual(e.run("document.querySelector('ul > li.odd').textContent"), '2');
  assert.strictEqual(e.run("document.getElementById('p1').matches('#main p') && document.getElementById('p1').webkitMatchesSelector('p')"), true);
  assert.strictEqual(e.run("document.querySelector('b').closest('div').id + (document.querySelector('b').closest('table') === null)"), 'maintrue');
  assert.strictEqual(e.run("(() => { try { document.querySelector('##') } catch (e) { return e.name + (e instanceof DOMException) } })()"), 'SyntaxErrortrue');
  assert.strictEqual(e.run("document.getElementById('main').querySelectorAll(':scope > p').length"), 2);
  assert.strictEqual(e.run("document.getElementById('main').querySelector('div p') !== null"), true, 'selectors match against the whole tree');
  e.run("var lis = document.getElementsByTagName('li'); var byClass = document.getElementsByClassName('odd'); var n0 = lis.length;");
  e.run("document.getElementById('list').appendChild(document.createElement('li')).className = 'odd'");
  assert.strictEqual(e.run("lis.length - n0 + byClass.length"), 3, 'live HTMLCollections');
  assert.strictEqual(e.run("lis.item(0).textContent + lis[1].textContent + lis.namedItem('nope')"), '12null');
  e.run("document.getElementById('lnk').name = 'nm'");
  assert.strictEqual(e.run("document.getElementsByName('nm').length + document.getElementsByTagName('*').length > 10"), true);
  assert.strictEqual(e.run("document.links.length + document.images.length + document.forms.length + document.scripts.length"), 2);
  assert.strictEqual(e.run("document.querySelectorAll('li').forEach.name"), 'forEach');
  assert.strictEqual(e.run("Array.prototype.slice.call(document.querySelectorAll('li')).length"), 4);
  assert.strictEqual(e.run("[].map.call(document.body.children, c => c.localName).join()").startsWith('div,ul,a,img'), true);
});

test('URL reflection (href/src with <base>), hyperlink utils, document props', async () => {
  const e = await env();
  assert.strictEqual(e.run("document.getElementById('lnk').href"), 'https://example.com/app/page?x=1#top');
  assert.strictEqual(e.run("document.getElementById('lnk').getAttribute('href')"), 'page?x=1#top');
  assert.strictEqual(e.run("var a = document.getElementById('lnk'); a.pathname + a.search + a.hash + a.host + a.protocol + a.origin"), '/app/page?x=1#topexample.comhttps:https://example.com');
  e.run("a.search = '?y=2'; a.hash = 'h2'");
  assert.strictEqual(e.run("a.getAttribute('href')"), 'https://example.com/app/page?y=2#h2');
  assert.strictEqual(e.run("String(a) === a.href"), true);
  assert.strictEqual(e.run("document.getElementById('im').src"), 'https://example.com/i.png');
  assert.strictEqual(e.run("document.baseURI + '|' + document.URL"), 'https://example.com/app/|https://example.com/app/index.html');
  assert.strictEqual(e.run("document.characterSet + document.charset + document.inputEncoding + document.contentType + document.compatMode"), 'UTF-8UTF-8UTF-8text/htmlCSS1Compat');
  assert.strictEqual(e.run("document.defaultView === window && document.visibilityState === 'visible' && document.hidden === false && document.hasFocus()"), true);
  assert.strictEqual(e.run("document.activeElement === document.body && document.scrollingElement === document.documentElement"), true);
  assert.strictEqual(e.run("document.domain + document.referrer + document.execCommand('copy')"), 'example.comfalse');
  assert.strictEqual(e.run("document.doctype.name + document.doctype.nodeType"), 'html10');
  assert.strictEqual(e.run("typeof document.fonts.ready.then + document.fonts.check('12px x')"), 'functiontrue');
  e.run("var nb = document.createElement('body'); nb.id='nb'; document.body = nb");
  assert.strictEqual(e.run("document.body.id + document.querySelectorAll('body').length"), 'nb1');
  assert.strictEqual(e.run("document.head.localName + document.documentElement.localName"), 'headhtml');
  assert.strictEqual(e.run("document.createEvent('MouseEvents') instanceof MouseEvent && document.createEvent('HTMLEvents').type === ''"), true);
  assert.strictEqual(e.run("(() => { const ev = document.createEvent('Event'); try { document.dispatchEvent(ev) } catch (x) { return x.name } })()"), 'InvalidStateError');
});

test('geometry, scrolling, elementFromPoint', async () => {
  const e = await env();
  const id = e.id('#p1');
  e.mock.rects.set(id, [10, 20, 100, 50]);
  assert.deepStrictEqual(Array.from(e.run("var r = document.getElementById('p1').getBoundingClientRect(); [r.x, r.y, r.width, r.height, r.top, r.right, r.bottom, r.left, r instanceof DOMRect]")), [10, 20, 100, 50, 20, 110, 70, 10, true]);
  assert.strictEqual(e.run("var p = document.getElementById('p1'); p.offsetWidth + ',' + p.offsetHeight + ',' + p.clientWidth + ',' + p.getClientRects().length"), '100,50,100,1');
  assert.strictEqual(e.run("p.offsetParent === document.body"), true);
  e.run("p.scrollTop = 5; p.scrollLeft = 3");
  assert.strictEqual(e.run("p.scrollTop + ',' + p.scrollLeft"), '5,3');
  e.run("window.scrollTo(0, 100)");
  assert.strictEqual(e.run("scrollY + pageYOffset + document.documentElement.scrollTop"), 300);
  e.run("p.scrollIntoView()");
  assert.deepStrictEqual(e.mock.scrolledIntoView, [id]);
  e.run("p.scrollIntoView(false); p.scrollIntoView({block: 'nearest', inline: 'center', behavior: 'smooth'})");
  assert.deepStrictEqual(e.mock.scrollIntoViewArgs, [['start', 'nearest', 'auto'], ['end', 'nearest', 'auto'], ['nearest', 'center', 'smooth']]);
  assert.strictEqual(e.run("document.elementFromPoint(50, 30).id"), 'p1');
  assert.strictEqual(e.run("document.createElement('div').getBoundingClientRect().width"), 0);
  assert.strictEqual(e.run("innerWidth + 'x' + innerHeight + ' ' + devicePixelRatio + ' ' + screen.width"), '1280x720 1 1920');
});

test('TreeWalker and NodeIterator', async () => {
  const e = await env();
  assert.strictEqual(e.run(`
    var tw = document.createTreeWalker(document.getElementById('main'), NodeFilter.SHOW_ELEMENT);
    var names = []; while (tw.nextNode()) names.push(tw.currentNode.localName); names.join()`), 'p,b,p');
  assert.strictEqual(e.run(`
    var tw2 = document.createTreeWalker(document.getElementById('main'), NodeFilter.SHOW_TEXT, { acceptNode: n => n.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    var t = []; while (tw2.nextNode()) t.push(tw2.currentNode.data); t.join('|')`), 'One |bold|Two');
  assert.strictEqual(e.run(`
    var tw3 = document.createTreeWalker(document.getElementById('main'));
    tw3.lastChild(); var a = tw3.currentNode.nodeType; tw3.previousNode(); var b = tw3.currentNode.nodeName; tw3.parentNode(); a + b + tw3.currentNode.id`), '8#textp2');
  assert.strictEqual(e.run(`
    var it = document.createNodeIterator(document.getElementById('main'), NodeFilter.SHOW_COMMENT);
    var c = it.nextNode(); c.data + it.nextNode() + it.previousNode().data`), ' c null c ');
  assert.strictEqual(e.run(`
    var it2 = document.createNodeIterator(document.getElementById('list'), NodeFilter.SHOW_ELEMENT, n => n.className === 'odd' ? 1 : 3);
    it2.nextNode().textContent + it2.nextNode()`), '2null');
});

test('Range and Selection basics', async () => {
  const e = await env();
  e.run("var p = document.getElementById('p1'); var r = document.createRange(); r.selectNodeContents(p);");
  assert.strictEqual(e.run("r.toString() + '|' + r.startOffset + r.endOffset + r.collapsed"), 'One bold|02false');
  e.run("var f = r.cloneContents()");
  assert.strictEqual(e.run("f.childNodes.length + f.textContent + (f.firstChild !== p.firstChild)"), '2One boldtrue');
  e.run("var r2 = document.createRange(); r2.setStart(p.firstChild, 1); r2.setEnd(p.querySelector('b').firstChild, 2)");
  assert.strictEqual(e.run("r2.toString() + '|' + r2.commonAncestorContainer.id"), 'ne bo|p1');
  assert.strictEqual(e.run("r2.cloneContents().textContent"), 'ne bo');
  e.run("var frag = r2.extractContents()");
  assert.strictEqual(e.run("p.textContent + '|' + frag.textContent + '|' + r2.collapsed"), 'Old|ne bo|true');
  e.run("var r3 = document.createRange(); r3.selectNode(document.getElementById('p2')); r3.deleteContents()");
  assert.strictEqual(e.run("document.getElementById('p2')"), null);
  e.run("var r4 = document.createRange(); r4.setStart(p.firstChild, 1); r4.collapse(true); r4.insertNode(document.createElement('hr'))");
  assert.strictEqual(e.run("p.innerHTML"), 'O<hr><b>ld</b>');
  assert.strictEqual(e.run("document.createRange().createContextualFragment('<tr><td>1</td></tr>').firstChild.nodeName"), '#text', 'contextual fragment parsed in body context drops tr');
  const sel = e.run("var s = getSelection(); [s.rangeCount, s.type, s.isCollapsed, s.toString()]");
  assert.deepStrictEqual(Array.from(sel), [0, 'None', true, '']);
  e.run("s.selectAllChildren(p)");
  assert.strictEqual(e.run("s.rangeCount + s.type + s.toString() + (s.anchorNode === p)"), '1RangeOldtrue');
  e.run("s.removeAllRanges()");
  assert.strictEqual(e.run("'' + s.rangeCount + (document.getSelection() === s)"), '0true');
});

test('DOMParser, XMLSerializer, createHTMLDocument (native and fallback)', async () => {
  for (const disable of [[], ['parseHTMLDocument']]) {
    const e = await createEnv({ disable });
    e.run(`var doc = new DOMParser().parseFromString('<!DOCTYPE html><html lang="fr"><head><title>Parsed</title><meta name="d" content="x"></head><body class="b"><p id="q">Hi</p></body></html>', 'text/html')`);
    assert.strictEqual(e.run("doc instanceof Document && doc !== document && doc.title"), 'Parsed', disable.join());
    assert.strictEqual(e.run("doc.getElementById('q').textContent + doc.querySelector('meta').content + doc.body.className + doc.documentElement.lang"), 'Hixbfr', disable.join());
    assert.strictEqual(e.run("document.getElementById('q')"), null);
    assert.strictEqual(e.run("doc.body.ownerDocument === doc"), true);
    e.run("var hd = document.implementation.createHTMLDocument('X'); hd.body.innerHTML = '<form></form><form></form>'");
    assert.strictEqual(e.run("hd.body.childNodes.length + hd.title"), '2X');
    assert.strictEqual(e.run("document.adoptNode(doc.getElementById('q')).parentNode"), null);
  }
  const e = await createEnv();
  e.run(`var x = new DOMParser().parseFromString('<?xml version="1.0"?><rss version="2.0"><channel><title>T &amp; A</title><item><Link>u</Link></item><![CDATA[<raw>]]></channel></rss>', 'text/xml')`);
  assert.strictEqual(e.run("x.documentElement.nodeName + x.getElementsByTagName('title')[0].textContent + x.querySelector('item').firstChild.tagName"), 'rssT & ALink');
  assert.strictEqual(e.run("x.getElementsByTagName('parsererror').length"), 0);
  e.run("var bad = new DOMParser().parseFromString('<a><b></a>', 'application/xml')");
  assert.strictEqual(e.run("bad.getElementsByTagName('parsererror').length"), 1);
  e.run(`var svgDoc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="1"/></svg>', 'image/svg+xml')`);
  assert.strictEqual(e.run("svgDoc.documentElement instanceof SVGSVGElement && svgDoc.documentElement.firstChild instanceof SVGElement"), true);
  e.run("var svg = document.adoptNode(svgDoc.documentElement); document.body.appendChild(svg)");
  assert.strictEqual(e.run("new XMLSerializer().serializeToString(svg)"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="1" /></svg>');
  assert.strictEqual(e.run("new XMLSerializer().serializeToString(document.createElement('br'))"), '<br xmlns="http://www.w3.org/1999/xhtml" />');
});

test('MutationObserver records', async () => {
  const e = await createEnv({ html: '<div id="root"><p id="a">x</p></div>' });
  e.run(`
    var recs = [];
    var root = document.getElementById('root');
    var mo = new MutationObserver((list, obs) => { recs.push(...list.map(r => r.type + ':' + (r.attributeName || '') + ':' + r.addedNodes.length + ':' + r.removedNodes.length + ':' + r.oldValue + ':' + (r.target.id || r.target.nodeName))); window.obsOk = obs === mo; });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
    root.setAttribute('data-x', '1');
    root.setAttribute('data-x', '2');
    var b = document.createElement('b'); root.appendChild(b);
    document.getElementById('a').firstChild.data = 'y';
    root.removeChild(b);
    root.firstChild.className = 'c';
    root.style.color = 'red';
    root.innerHTML = '<i>1</i><i>2</i>';
  `);
  assert.strictEqual(e.run('recs.length'), 0, 'delivered in a microtask');
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('recs')), [
    'attributes:data-x:0:0:null:root', 'attributes:data-x:0:0:1:root', 'childList::1:0:null:root',
    'characterData::0:0:x:#text', 'childList::0:1:null:root', 'attributes:class:0:0:null:a',
    'attributes:style:0:0:null:root', 'childList::2:1:null:root',
  ]);
  assert.strictEqual(e.run('obsOk'), true);
  e.run(`recs = []; var mo2 = new MutationObserver(() => {}); mo2.observe(root, { attributes: true, attributeFilter: ['title'] }); root.id = 'root2'; root.title = 't'; var taken = mo2.takeRecords(); mo.disconnect(); root.title = 'u'`);
  await e.flush();
  assert.strictEqual(e.run("taken.length + ':' + taken[0].attributeName + ':' + recs.length"), '1:title:0');
  assert.strictEqual(e.run("(() => { try { mo.observe(root, {}) } catch (x) { return x instanceof TypeError } })()"), true);
  e.run("var prev; var mo3 = new MutationObserver(l => { prev = l[0].previousSibling && l[0].previousSibling.textContent; }); mo3.observe(root, {childList: true}); root.appendChild(document.createElement('u'))");
  await e.flush();
  assert.strictEqual(e.run('prev'), '2');
});

test('live children/childNodes stay correct with per-parent invalidation', async () => {
  const e = await env();
  assert.strictEqual(e.run(`
    var a = document.createElement('div'), b = document.createElement('div');
    document.body.append(a, b);
    for (var i = 0; i < 3; i++) a.appendChild(document.createElement('span'));
    var ac = a.children, an = a.childNodes, bc = b.children;
    var r = [ac.length, an.length, bc.length];
    a.firstChild.textContent = 'x';                       // grandchild change: a's lists unchanged
    r.push(ac.length, an.length);
    b.appendChild(a.firstChild);                           // move: both parents change
    r.push(ac.length, an.length, bc.length);
    var f = document.createDocumentFragment(); f.append(document.createElement('i'), 'txt');
    var fn = f.childNodes; r.push(fn.length);
    a.appendChild(f);                                      // fragment emptied
    r.push(fn.length, ac.length, an.length);
    b.replaceChildren(a.lastElementChild);                 // replaceChildren moves out of a
    r.push(ac.length, bc.length);
    a.replaceChild(b.firstChild, a.firstChild);            // replaceChild moves out of b
    r.push(ac.length, bc.length);
    a.textContent = '';
    r.push(ac.length, an.length);
    r.join(',');
  `), '3,3,0,3,3,2,2,1,2,0,3,4,2,1,2,0,0,0');
});
