'use strict';
// XPath 1.0 (25_xpath.js): document.evaluate, createExpression, createNSResolver,
// XPathEvaluator, XPathExpression and XPathResult. Expected values follow the XPath 1.0
// Recommendation and what Chromium and Firefox return; several cases come from the WPT
// domxpath tests.
const assert = require('assert');
const { createEnv } = require('../harness');

const PAGE = '<!DOCTYPE html><html><head><title>T</title></head><body>' +
  '<div id="a" class="x y"><span>one</span><span>two</span><p>three<b>bold</b></p></div>' +
  '<div id="b"><!--c--><i>i</i> tail</div></body></html>';

// Page-side helpers. X(expression, context, resolver, doc) evaluates with ANY_TYPE and returns
// a number, string or boolean, or the node-set as "[a b c]": elements as name#id, attributes as
// @name=value, text as "data", comments as <!--data-->, processing instructions as
// <?target data?>. An exception comes back as "ERR <name>".
const HELPERS = `
  function describe(n) {
    switch (n.nodeType) {
      case 1: return n.localName + (n.id ? '#' + n.id : '');
      case 2: return '@' + n.name + '=' + n.value;
      case 3: case 4: return '"' + n.data + '"';
      case 7: return '<?' + n.target + ' ' + n.data + '?>';
      case 8: return '<!--' + n.data + '-->';
      case 9: return '#document';
      case 10: return '<!doctype>';
      default: return '#' + n.nodeType;
    }
  }
  function show(r) {
    switch (r.resultType) {
      case 1: return r.numberValue;
      case 2: return r.stringValue;
      case 3: return r.booleanValue;
      default: { const a = []; for (let n; (n = r.iterateNext());) a.push(describe(n)); return '[' + a.join(' ') + ']'; }
    }
  }
  function X(expr, ctx, resolver, doc) {
    try { return show((doc || document).evaluate(expr, ctx || document, resolver || null, 0, null)); } catch (x) { return 'ERR ' + x.name; }
  }
  function xml(s, type) { return new DOMParser().parseFromString(s, type || 'text/xml'); }
`;

async function pageEnv(html) {
  const e = await createEnv({ html: html === undefined ? PAGE : html });
  e.run(HELPERS);
  return e;
}

// Evaluate every [expression, expected] pair against a context (a page expression).
function table(e, cases, ctx) {
  const got = e.run(`(${JSON.stringify(cases.map((c) => c[0]))}).map((x) => X(x, ${ctx || 'document'}))`);
  cases.forEach(([expr, want], i) => assert.strictEqual(got[i], want, `${expr}: ${got[i]} !== ${want}`));
}

const catcher = (f) => `(() => { try { ${f}; return 'no'; } catch (x) { return x.constructor === TypeError ? 'TypeError' : x.name + '/' + x.code; } })()`;

test('XPath: interfaces and API surface', async () => {
  const e = await pageEnv();
  assert.strictEqual(e.run('[typeof XPathResult, typeof XPathExpression, typeof XPathEvaluator, typeof XPathNSResolver].join()'), 'function,function,function,undefined');
  assert.strictEqual(e.run(`[XPathResult.ANY_TYPE, XPathResult.NUMBER_TYPE, XPathResult.STRING_TYPE, XPathResult.BOOLEAN_TYPE,
    XPathResult.UNORDERED_NODE_ITERATOR_TYPE, XPathResult.ORDERED_NODE_ITERATOR_TYPE, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, XPathResult.ANY_UNORDERED_NODE_TYPE, XPathResult.FIRST_ORDERED_NODE_TYPE].join()`), '0,1,2,3,4,5,6,7,8,9');
  assert.strictEqual(e.run("XPathResult.prototype.FIRST_ORDERED_NODE_TYPE + ':' + Object.getOwnPropertyDescriptor(XPathResult, 'ANY_TYPE').writable"), '9:false');
  // Document and XPathEvaluator carry the same three methods (XPathEvaluatorBase).
  assert.strictEqual(e.run(`['evaluate', 'createExpression', 'createNSResolver'].map((m) => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, m);
    return [d.enumerable, d.writable, d.configurable, typeof d.value, XPathEvaluator.prototype.hasOwnProperty(m), document[m].length].join(':');
  }).join(' ')`), 'true:true:true:function:true:2 true:true:true:function:true:1 true:true:true:function:true:1');
  assert.strictEqual(e.run('[XPathExpression.prototype.evaluate.length, XPathResult.prototype.snapshotItem.length].join()'), '1,1');
  assert.strictEqual(e.run("String(document.evaluate) + '|' + Object.prototype.toString.call(document.evaluate('1', document)) + '|' + Object.prototype.toString.call(document.createExpression('1'))"),
    'function evaluate() { [native code] }|[object XPathResult]|[object XPathExpression]');
  assert.strictEqual(e.run(`['resultType', 'numberValue', 'stringValue', 'booleanValue', 'singleNodeValue', 'invalidIteratorState', 'snapshotLength']
    .map((k) => typeof Object.getOwnPropertyDescriptor(XPathResult.prototype, k).get).join()`), 'function,function,function,function,function,function,function');
  // Available on documents of every kind
  assert.strictEqual(e.run(`[xml('<r/>'), document.implementation.createHTMLDocument(''), new Document()]
    .map((d) => typeof d.evaluate + typeof d.createExpression + typeof d.createNSResolver).join()`), 'functionfunctionfunction,functionfunctionfunction,functionfunctionfunction');

  // Constructors: only XPathEvaluator has one
  assert.strictEqual(e.run(`[${catcher('new XPathEvaluator()')}, ${catcher('XPathEvaluator()')}, ${catcher('new XPathResult()')}, ${catcher('new XPathExpression()')}].join()`), 'no,TypeError,TypeError,TypeError');
  assert.strictEqual(e.run('new XPathEvaluator() instanceof XPathEvaluator'), true);

  // Arguments: required ones, Node, resolver and XPathResult conversions
  const bad = [
    "document.evaluate('1')", "document.evaluate('1', 5)", "document.evaluate('1', null)", "document.evaluate('1', document, 'str')",
    "document.evaluate('1', document, null, 0, {})", 'document.createExpression()', "document.createExpression('1', 7)", 'document.createNSResolver()',
    'document.createNSResolver({})', "document.createExpression('1').evaluate()", "document.createExpression('1').evaluate({})",
    "document.evaluate('1', document).snapshotItem()", "document.evaluate('//b', document, null, 7).snapshotItem()",
  ];
  for (const code of bad) assert.strictEqual(e.run(catcher(code)), 'TypeError', code);
  assert.strictEqual(e.run("try { document.evaluate('1'); } catch (x) { x.message }"), "Failed to execute 'evaluate' on 'Document': 2 arguments required, but only 1 present.");
  assert.strictEqual(e.run("try { new XPathEvaluator().evaluate('1', 5); } catch (x) { x.message }"), "Failed to execute 'evaluate' on 'XPathEvaluator': parameter 2 is not of type 'Node'.");
  // Methods refuse receivers that are not documents or evaluators, results and expressions
  for (const code of ["Document.prototype.evaluate.call({}, '1', document)", "XPathEvaluator.prototype.createNSResolver.call(document, document)",
    'XPathResult.prototype.iterateNext.call({})', "Object.getOwnPropertyDescriptor(XPathResult.prototype, 'resultType').get.call({})", 'XPathExpression.prototype.evaluate.call({}, document)']) {
    assert.strictEqual(e.run(catcher(code)), 'TypeError', code);
  }
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: location paths, axes and node tests', async () => {
  const e = await pageEnv();
  table(e, [
    ['/', '[#document]'],
    ['/html', '[html]'],
    ['/html/body/div', '[div#a div#b]'],
    ['/html/body/div[2]/i', '[i]'],
    ['//span', '[span span]'],
    ['//div//b', '[b]'],
    ['//div/b', '[]'],
    ['/*', '[html]'],
    ['/html/*', '[head body]'],
    ['//body/*', '[div#a div#b]'],
    ['//*[self::b or self::i]', '[b i]'],
    ['.', '[#document]'],
    ['//p/.', '[p]'],
    ['//b/..', '[p]'],
    ['//b/../..', '[div#a]'],
    ['//b/parent::p', '[p]'],
    ['//b/parent::div', '[]'],
    ['//b/ancestor::*', '[html body div#a p]'],
    ['//b/ancestor-or-self::*', '[html body div#a p b]'],
    ['//b/ancestor::div', '[div#a]'],
    ['//div/descendant::*', '[span span p b i]'],
    ['//div/descendant-or-self::*', '[div#a span span p b div#b i]'],
    ['//div[1]/descendant::text()', '["one" "two" "three" "bold"]'],
    ['//span[1]/following-sibling::*', '[span p]'],
    ['//p/preceding-sibling::*', '[span span]'],
    ['//span[1]/following::*', '[span p b div#b i]'],
    ['//p/preceding::*', '[head title span span]'],
    ['//b/following::text()', '["i" " tail"]'],
    ['//b/preceding::text()', '["T" "one" "two" "three"]'],
    ['//i/preceding::*', '[head title div#a span span p b]'],
    // Results are in document order, not axis order, even for the reverse axes
    ['//i/preceding::span', '[span span]'],
    ['//i/ancestor::*', '[html body div#b]'],
    // Node tests
    ['//div[2]/node()', '[<!--c--> i " tail"]'],
    ['//div[2]/text()', '[" tail"]'],
    ['//comment()', '[<!--c-->]'],
    ['//text()', '["T" "one" "two" "three" "bold" "i" " tail"]'],
    ['count(/node())', 2], // the doctype and <html>
    ['/node()[1]', '[<!doctype>]'],
    ['count(//node())', 20],
    ['count(//*)', 11],
    ['//processing-instruction()', '[]'],
    // Attributes
    ['//@id', '[@id=a @id=b]'],
    ['//@*', '[@id=a @class=x y @id=b]'],
    ['//div/@class', '[@class=x y]'],
    ['//div[@class]', '[div#a]'],
    ['//@id/..', '[div#a div#b]'],
    ['//@class/parent::*', '[div#a]'],
    ['//div/@*[1]', '[@id=a @id=b]'],
    ['//div/attribute::id', '[@id=a @id=b]'],
    ['//@*/self::node()', '[@id=a @class=x y @id=b]'],
    ['count(//@*/ancestor::*)', 4],
    ['//@class/following-sibling::node()', '[]'],
    ['//@class/child::node()', '[]'],
    ['//@id/descendant::*', '[]'],
    ['//div/@node()', '[@id=a @class=x y @id=b]'],
    ['//div/@text()', '[]'],
    ['//@id/ancestor::div', '[div#a div#b]'],
    ['//div/namespace::*', '[]'],
    // Following/preceding from an attribute start at its element: the element's own subtree is not "following" (as in Blink and libxml2)
    ['//div[@id="a"]/@class/following::*', '[div#b i]'],
    ['//div[@id="b"]/@id/preceding::*', '[head title div#a span span p b]'],
    // Spelling: whitespace between tokens, names that look like operators
    ['child :: html', '[html]'],
    ['/ child::html / descendant :: b', '[b]'],
    ['//p [ b ]', '[p]'],
    ['  //span  ', '[span span]'],
    ['\t\r\n//span\n', '[span span]'],
    ['//*[@id = "a"]/*[position() = 1]', '[span]'],
    ['//*[local-name() = "b"]', '[b]'],
    ['*', '[html]'],
    ['html', '[html]'],
    ['//nothing/at/all', '[]'],
    ['//div[and]', '[]'],
    ['//and | //or | //div | //mod', '[div#a div#b]'],
    ['//*[div div div]', '[]'],
    ['/html/body/div[@id="a"]/p/b/text()', '["bold"]'],
  ]);
  // Relative paths start at the context node
  table(e, [
    ['span', '[span span]'],
    ['./span[2]', '[span]'],
    ['p/b', '[b]'],
    ['.//b', '[b]'],
    ['..', '[body]'],
    ['../div', '[div#a div#b]'],
    ['*', '[span span p]'],
    ['@id', '[@id=a]'],
    ['@*', '[@id=a @class=x y]'],
    ['/html/head/title', '[title]'],
    ['//title', '[title]'],
    ['ancestor::*', '[html body]'],
    ['self::div', '[div#a]'],
    ['self::span', '[]'],
    ['string(.)', 'onetwothreebold'],
    ['name()', 'div'],
    ['string()', 'onetwothreebold'],
    ['count(.//*)', 4],
  ], "document.getElementById('a')");
  // A context node that is not an element
  table(e, [
    ['.', '["one"]'],
    ['..', '[span]'],
    ['string()', 'one'],
    ['string-length()', 3],
    ['following::text()', '["two" "three" "bold" "i" " tail"]'],
    ['preceding::text()', '["T"]'],
    ['ancestor::*', '[html body div#a span]'],
    ['child::node()', '[]'],
    ['following-sibling::node()', '[]'],
    ['self::text()', '["one"]'],
    ['self::node()', '["one"]'],
    ['self::comment()', '[]'],
    ['@id', '[]'],
    ['*', '[]'],
  ], "document.querySelector('span').firstChild");
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: predicates, position() and last(), document order', async () => {
  const e = await pageEnv();
  table(e, [
    ['//span[1]', '[span]'],
    ['//span[2]', '[span]'],
    ['//span[3]', '[]'],
    ['//span[0]', '[]'],
    ['//span[1.5]', '[]'],
    ['//span[last()]', '[span]'],
    ['//div[1]', '[div#a]'],
    ['(//div)[1]', '[div#a]'],
    ['(//div)[2]', '[div#b]'],
    ['(//div)[last()]', '[div#b]'],
    ['(//span | //p)[last()]', '[p]'],
    ['(//p | //span)[1]/text()', '["one"]'],
    ['//div/*[1]', '[span i]'],
    ['//div/*[last()]', '[p i]'],
    ['//div/node()[last()]', '[p " tail"]'],
    ['//div[2]/node()[2]', '[i]'],
    ['//div[position() = 2]', '[div#b]'],
    ['//div[position() < 2]', '[div#a]'],
    ['//*[position() = last()]', '[html title body p b div#b i]'],
    ['//span[position() mod 2 = 1]', '[span]'],
    ['//span[position() > 1]/text()', '["two"]'],
    ['//span[. = "two"]', '[span]'],
    ['//span[. = "two"][1]', '[span]'],
    ['//span[. = "two"][2]', '[]'],
    ['//div[span[2]]', '[div#a]'],
    ['//div[span][@class]', '[div#a]'],
    ['//div[p/b]/@id', '[@id=a]'],
    ['//div[not(@class)]', '[div#b]'],
    ['//div[@class and @id]', '[div#a]'],
    ['//div[@class or @id]', '[div#a div#b]'],
    ['//*[@id="a" or @id="b"]', '[div#a div#b]'],
    ['//div[count(*) = 3]', '[div#a]'],
    ['//div[count(node()) > 2]', '[div#a div#b]'],
    ['//div[string-length(@id) = 1]', '[div#a div#b]'],
    ['//div[contains(@class, "y")]', '[div#a]'],
    ['//div[contains(., "tail")]', '[div#b]'],
    ['//*[.//b]', '[html body div#a p]'],
    ['//div[. = "onetwothreebold"]', '[div#a]'],
    ['//div[1 = 1]', '[div#a div#b]'],
    ['//div[false()]', '[]'],
    ['//div[""]', '[]'],
    ['//div["x"]', '[div#a div#b]'],
    ['//div[@nothing]', '[]'],
    ['//div[@id][2]', '[div#b]'],
    ['//div[@id][3]', '[]'],
    // Reverse axes count from the context node outwards
    ['//b/ancestor::*[1]', '[p]'],
    ['//b/ancestor::*[2]', '[div#a]'],
    ['//b/ancestor::*[last()]', '[html]'],
    ['//b/ancestor-or-self::*[1]', '[b]'],
    ['//span[2]/preceding-sibling::*[1]', '[span]'],
    ['//p/preceding-sibling::*[2]', '[span]'],
    ['string(//p/preceding-sibling::*[1])', 'two'],
    ['string(//p/preceding-sibling::*[2])', 'one'],
    ['//i/preceding::*[1]', '[b]'],
    ['string(//i/preceding::span[1])', 'two'],
    ['string(//i/preceding::span[2])', 'one'],
    ['string(//b/ancestor::*[position() = 2]/@id)', 'a'],
    ['name(//b/ancestor::*[position() = 3])', 'body'],
    ['string(//span[1]/following::*[1])', 'two'],
    ['//span[1]/following::*[last()]', '[i]'],
    // Predicates on a filter expression apply to the whole node-set in document order
    ['string((//span)[2])', 'two'],
    ['(//div/span)[position() > 1]', '[span]'],
    ['(//div//*)[position() = 4]', '[b]'],
    ['(//i | //b | //span)[3]', '[b]'],
    ['(//i | //b | //span)[position() >= 3]', '[b i]'],
    ['(/descendant::*)[last()]', '[i]'],
    ['(//span)[2]/../@id', '[@id=a]'],
    ['(//div)[1]//b', '[b]'],
    ['(//div)[1]/span[2]', '[span]'],
    // Each step and each predicate has its own position and size
    ['//div[span[last()]]/@id', '[@id=a]'],
    ['//div[count(.//*[position() = 1]) = 2]/@id', '[@id=a]'],
    ['//div[count(.//*[position() = 1]) = 1]/@id', '[@id=b]'],
    ['//span[1 + 1]', '[span]'],
    ['string(//span[1 + 1])', 'two'],
    ['string(//span[last() - 1])', 'one'],
    ['string(//span[count(//b) + 1])', 'two'],
  ]);
  // Sets built from several nodes are put in document order without duplicates
  table(e, [
    ['//i | //span | //b', '[span span b i]'],
    ['//i | //i', '[i]'],
    ['//div | //div/span | //div', '[div#a span span div#b]'],
    ['//b/ancestor::* | //i/ancestor::*', '[html body div#a p div#b]'],
    ['//@id | //i | //div/@class', '[@id=a @class=x y @id=b i]'],
    ['count(//span | //p | //b | //span)', 4],
    ['//span/.. | //i/..', '[div#a div#b]'],
    ['//span/following-sibling::*', '[span p]'],
    ['//b/preceding-sibling::* | //p/preceding-sibling::*', '[span span]'],
    ['//span/following::i', '[i]'],
    ['//b/following::* | //span/following::*', '[span p b div#b i]'],
    ['//div/descendant::*/ancestor::div', '[div#a div#b]'],
    ['//div/descendant-or-self::*/child::b', '[b]'],
    ['//*/child::*/child::*/parent::*', '[head body div#a p div#b]'],
    ['//div | //nothing', '[div#a div#b]'],
    ['//nothing | //div', '[div#a div#b]'],
    ['//p/b | //span[1]', '[span b]'],
    ['//title/following::* | //b/preceding::span', '[body div#a span span p b div#b i]'],
  ]);
  // Where a node-set is required
  table(e, [
    ['//b | 1', 'ERR SyntaxError'],
    ['"x" | //b', 'ERR SyntaxError'],
    ['(1)[1]', 'ERR SyntaxError'],
    ['(1)/x', 'ERR SyntaxError'],
    ['1[1]', 'ERR SyntaxError'],
    ['count(1)', 'ERR SyntaxError'],
    ['count("x")', 'ERR SyntaxError'],
  ]);
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: operators, comparisons and type conversions', async () => {
  const e = await pageEnv();
  table(e, [
    // Arithmetic
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['10 mod 3', 1],
    ['-10 mod 3', -1],
    ['5 mod -2', 1],
    ['5.5 mod 2', 1.5],
    ['10 div 4', 2.5],
    ['7 div 2 * 2', 7],
    ['2 * 3 mod 4', 2],
    ['1 - 1 - 1', -1],
    ['3 - -2', 5],
    ['--2', 2],
    ['- - -2', -2],
    ['1 div 0', Infinity],
    ['-1 div 0', -Infinity],
    ['0 div 0', NaN],
    ['5 mod 0', NaN],
    ['-(1 + 2)', -3],
    ['count(//span) + count(//b)', 3],
    ['count(//span) * count(//div)', 4],
    ['count(//span) div count(//div)', 1],
    ['count(//span) mod count(//div)', 0],
    ['1 + "2"', 3],
    ['"3" * "4"', 12],
    ['1 + //nothing', NaN],
    ['1 + true()', 2],
    ['.5 + .5', 1],
    ['5. + 1', 6],
    ['- //nothing', NaN],
    ['-"abc"', NaN],
    ['- "5"', -5],
    // Booleans and comparisons
    ['true() and false()', false],
    ['true() or false()', true],
    ['false() or false() or true()', true],
    ['1 and 2', true],
    ['1 and 0', false],
    ['"" or ""', false],
    ['//nothing or //span', true],
    ['//span and //nothing', false],
    ['not(//nothing)', true],
    ['not(1)', false],
    ['1 = 1', true],
    ['1 != 1', false],
    ['1 < 2', true],
    ['2 <= 2', true],
    ['3 > 2', true],
    ['2 >= 3', false],
    ['1 = 1.0', true],
    ['"a" = "a"', true],
    ['"a" != "a"', false],
    ['"a" = "A"', false],
    ['"2" < "10"', true],
    ['"b" < "a"', false],
    ['"10" = 10', true],
    ['"10.0" = 10', true],
    ['" 10 " = 10', true],
    ['"abc" = 0', false],
    ['"abc" != 0', true],
    ['0 div 0 = 0 div 0', false],
    ['0 div 0 != 0 div 0', true],
    ['0 div 0 < 1', false],
    ['1 < 2 < 3', true],
    ['3 > 2 > 1', false],
    ['2 > 1 > 0', true],
    ['1 = 1 = 1', true],
    ['3 = 3 = true()', true],
    ['true() = "x"', true],
    ['false() = ""', true],
    ['true() = 2', true],
    ['false() = 0', true],
    ['1 = true()', true],
    ['true() != "x"', false],
    ['true() > false()', true],
    ['"1" < "2"', true],
    ['"-1" < "0"', true],
    ['"1.5" < "1.25"', false],
    ['"" < "1"', false],
    ['"" >= "1"', false],
    ['"" = ""', true],
    // Node-sets against other types
    ['//span = "one"', true],
    ['//span = "two"', true],
    ['//span = "three"', false],
    ['//span != "one"', true],
    ['"one" = //span', true],
    ['//nothing = ""', false],
    ['//nothing != ""', false],
    ['//nothing = //nothing', false],
    ['//span = //span', true],
    ['//span != //span', true],
    ['//span = //i', false],
    ['//span != //i', true],
    ['//div = "onetwothreebold"', true],
    ['//span = true()', true],
    ['//nothing = false()', true],
    ['//nothing = true()', false],
    ['//span != true()', false],
    ['//nothing != true()', true],
    ['true() = //span', true],
    ['//span > "one"', false],
    ['//b = 0', false],
    ['count(//span) = 2', true],
    ['//@id = "b"', true],
    ['//@id = //div/@id', true],
    ['//@id != //div/@id', true],
    ['//@class = "x y"', true],
    ['//span[. = //i] or //div', true],
    ['//span < "two"', false],
    ['1 < //span', false],
    ['1 > //nothing', false],
    // Conversions
    ['boolean(//span)', true],
    ['boolean(//nothing)', false],
    ['boolean("")', false],
    ['boolean("false")', true],
    ['boolean(0)', false],
    ['boolean(-0)', false],
    ['boolean(0 div 0)', false],
    ['boolean(1 div 0)', true],
    ['boolean(0.1)', true],
    ['boolean(//div/@id)', true],
    ['string(true())', 'true'],
    ['string(false())', 'false'],
    ['string(//nothing)', ''],
    ['string(1 = 1)', 'true'],
    ['number(true())', 1],
    ['number(false())', 0],
    ['number(//nothing)', NaN],
    ['number("  12  ")', 12],
    ['number("\t12\n")', 12],
    ['number("-.5")', -0.5],
    ['number("5.")', 5],
    ['number("007")', 7],
    ['number("1e3")', NaN],
    ['number("+5")', NaN],
    ['number("")', NaN],
    ['number(" ")', NaN],
    ['number("- 5")', NaN],
    ['number("--5")', NaN],
    ['number("5 5")', NaN],
    ['number("0x10")', NaN],
    ['number("Infinity")', NaN],
    ['number("NaN")', NaN],
    ['number(//span)', NaN],
    ['number(//div/@id)', NaN],
  ]);
  // Numbers in the page are numbers
  const n = await pageEnv('<!DOCTYPE html><html><body><p id="p">42</p><p> 7 </p><p>1.5</p><p>x</p><s>3</s><s>4</s></body></html>');
  table(n, [
    ['number(//p)', 42],
    ['sum(//p)', NaN],
    ['sum(//s)', 7],
    ['sum(//p[1] | //p[2] | //p[3])', 50.5],
    ['sum(//nothing)', 0],
    ['//p = 42', true],
    ['//p = 7', true],
    ['//p = "42"', true],
    ['//p > 41', true],
    ['//p < 2', true],
    ['//p > 42', false],
    ['//p >= 42', true],
    ['//s = //s[2]', true],
    ['//s < //p', true],
    ['//s > //p', true],
    ['//p[. > 10]', '[p#p]'],
    ['//p[. > 5][. < 20]', '[p]'],
    ['//p[number(.) = 1.5]', '[p]'],
    ['count(//p[. = 42 or . = 7])', 2],
    ['//p[. = 7]/preceding-sibling::p', '[p#p]'],
    ['(//p)[. * 2 = 84]', '[p#p]'],
    ['number(//s[2]) - number(//s[1])', 1],
    ['//s[1] + //s[2]', 7],
    ['//s[1] * //s[2]', 12],
    ['//s[1] div //s[2]', 0.75],
    ['//s[2] mod //s[1]', 1],
    ['-//s[1]', -3],
    ['round(//p[3])', 2],
    ['floor(//p[3])', 1],
    ['ceiling(//p[3])', 2],
    ['string(//p[3] * 2)', '3'],
  ]);
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: number formatting and parsing', async () => {
  const e = await pageEnv();
  table(e, [
    ['string(0)', '0'],
    ['string(-0)', '0'],
    ['string(0 div 1)', '0'],
    ['string(-1 * 0)', '0'],
    ['string(1)', '1'],
    ['string(-1)', '-1'],
    ['string(10)', '10'],
    ['string(1000000)', '1000000'],
    ['string(1.5)', '1.5'],
    ['string(-1.5)', '-1.5'],
    ['string(.5)', '0.5'],
    ['string(-.5)', '-0.5'],
    ['string(0.1 + 0.2)', '0.30000000000000004'],
    ['string(1 div 3)', '0.3333333333333333'],
    ['string(2 div 3)', '0.6666666666666666'],
    ['string(100 div 3)', '33.333333333333336'],
    ['string(1 div 0)', 'Infinity'],
    ['string(-1 div 0)', '-Infinity'],
    ['string(0 div 0)', 'NaN'],
    ['string(number("x"))', 'NaN'],
    // No exponent notation, whatever the magnitude
    ['string(100000000000000000000)', '100000000000000000000'],
    ['string(1000000000000000000000)', '1000000000000000000000'],
    ['string(1000000000000000000000000000000)', '1000000000000000000000000000000'],
    ['string(123456789012345678)', '123456789012345680'],
    ['string(-1000000000000000000000)', '-1000000000000000000000'],
    ['string(0.000001)', '0.000001'],
    ['string(0.0000001)', '0.0000001'],
    ['string(0.00000001)', '0.00000001'],
    ['string(-0.0000001)', '-0.0000001'],
    ['string(0.00000000000000000001)', '0.00000000000000000001'],
    ['string(1.5 div 1000000000)', '0.0000000015'],
    ['string(1234567.891 * 1000000000000000)', '1234567891000000000000'],
    ['concat(1, 2)', '12'],
    ['concat(0.5, "|", -0)', '0.5|0'],
    ['string(3.0)', '3'],
    ['string(1.10)', '1.1'],
    ['string(number("007.500"))', '7.5'],
    // round, floor, ceiling
    ['string(round(2.5))', '3'],
    ['string(round(-2.5))', '-2'],
    ['string(round(-0.4))', '0'],
    ['string(round(0.5))', '1'],
    ['string(round(1.5))', '2'],
    ['string(round(-1.5))', '-1'],
    ['string(round(0 div 0))', 'NaN'],
    ['string(round(1 div 0))', 'Infinity'],
    ['string(floor(-0.5))', '-1'],
    ['string(ceiling(-0.5))', '0'],
    ['string(floor(1 div 0))', 'Infinity'],
    ['floor(2.7)', 2],
    ['floor(-2.5)', -3],
    ['ceiling(2.1)', 3],
    ['ceiling(-2.1)', -2],
    ['round(2.5)', 3],
    ['round(-2.5)', -2],
    ['round(2.4)', 2],
    ['round(-2.6)', -3],
    ['round(1 div 0)', Infinity],
    ['round("x")', NaN],
    // No exponent in the input either
    ['1e3', 'ERR SyntaxError'],
    ['5e0', 'ERR SyntaxError'],
    ['1.5.5', 'ERR SyntaxError'],
    ['0x10', 'ERR SyntaxError'],
  ]);
  // A number result is the number itself, including the sign of zero
  assert.strictEqual(e.run("document.evaluate('1 div 3', document, null, 1).numberValue"), 1 / 3);
  assert.ok(Object.is(e.run("document.evaluate('-1 * 0', document, null, 1).numberValue"), -0));
  assert.ok(Object.is(e.run("document.evaluate('round(-0.4)', document, null, 1).numberValue"), -0));
  assert.ok(Number.isNaN(e.run("document.evaluate('0 div 0', document, null, 1).numberValue")));
});

test('XPath: string functions', async () => {
  const e = await pageEnv();
  table(e, [
    ['string(/)', 'Tonetwothreeboldi tail'],
    ['string(//p)', 'threebold'],
    ['string(//div[2])', 'i tail'],
    ['string(//comment())', 'c'],
    ['string(//div/@id)', 'a'],
    ['string(//i/text())', 'i'],
    ['string(//nothing)', ''],
    ['string()', 'Tonetwothreeboldi tail'],
    ['string-length("")', 0],
    ['string-length("abc")', 3],
    ['string-length("é€")', 2],
    ['string-length(//p)', 9],
    ['string-length(//nothing)', 0],
    ['string-length()', 22],
    ['concat("a", "b")', 'ab'],
    ['concat("a", "b", "c", "d", "e")', 'abcde'],
    ['concat("a", //span, 1, true())', 'aone1true'],
    ['starts-with("abc", "ab")', true],
    ['starts-with("abc", "bc")', false],
    ['starts-with("abc", "")', true],
    ['starts-with("", "")', true],
    ['starts-with("", "a")', false],
    ['starts-with(//p, "three")', true],
    ['contains("abc", "b")', true],
    ['contains("abc", "")', true],
    ['contains("abc", "abcd")', false],
    ['contains("abc", "B")', false],
    ['contains(//p, "eb")', true],
    ['contains(//nothing, "x")', false],
    ['contains(//nothing, "")', true],
    ['substring-before("1999/04/01", "/")', '1999'],
    ['substring-before("1999/04/01", "x")', ''],
    ['substring-before("abc", "")', ''],
    ['substring-before("abc", "a")', ''],
    ['substring-after("1999/04/01", "/")', '04/01'],
    ['substring-after("1999/04/01", "19")', '99/04/01'],
    ['substring-after("1999/04/01", "x")', ''],
    ['substring-after("abc", "")', 'abc'],
    ['substring-after("abc", "c")', ''],
    ['substring("12345", 2)', '2345'],
    ['substring("12345", 2, 3)', '234'],
    ['substring("12345", 1.5, 2.6)', '234'],
    ['substring("12345", 0)', '12345'],
    ['substring("12345", 0, 3)', '12'],
    ['substring("12345", -1, 4)', '12'],
    ['substring("12345", 6)', ''],
    ['substring("12345", 5)', '5'],
    ['substring("12345", 2, 0)', ''],
    ['substring("12345", 2, -1)', ''],
    ['substring("12345", 0 div 0, 3)', ''],
    ['substring("12345", 1, 0 div 0)', ''],
    ['substring("12345", -42, 1 div 0)', '12345'],
    ['substring("12345", -1 div 0, 1 div 0)', ''],
    ['substring("12345", 1 div 0)', ''],
    ['substring("12345", 2.5)', '345'],
    ['substring("12345", 1.4999, 1)', '1'],
    ['substring("", 1, 5)', ''],
    ['substring(//p, 2, 3)', 'hre'],
    ['normalize-space("  a   b  ")', 'a b'],
    ['normalize-space("a\t\n\r b")', 'a b'],
    ['normalize-space("")', ''],
    ['normalize-space("   ")', ''],
    ['normalize-space(" a ")', ' a '],
    ['normalize-space("y\u000b\u000cz")', 'y\u000b\u000cz'],
    ['normalize-space("　a")', '　a'],
    ['normalize-space()', 'Tonetwothreeboldi tail'],
    ['translate("bar", "abc", "ABC")', 'BAr'],
    ['translate("--aaa--", "abc-", "ABC")', 'AAA'],
    ['translate("abc", "", "x")', 'abc'],
    ['translate("abc", "abc", "")', ''],
    ['translate("aabb", "aa", "xy")', 'xxbb'],
    ['translate("abc", "abc", "xyzw")', 'xyz'],
    ['translate(//p, "eb", "EB")', 'thrEEBold'],
  ]);
  // Arguments that depend on the context node
  const c = await pageEnv('<!DOCTYPE html><html><body><div id="context"><span>^^^bar$$$</span><span><b>^^^</b></span><b>bar</b><b>foo</b><br><br><br><br></div></body></html>');
  table(c, [
    ['substring((./span)[1], count(./br))', 'bar$$$'],
    ['translate((./span)[1], (./b)[1], ./b[2])', '^^^foo$$$'],
    ['normalize-space()', '^^^bar$$$^^^barfoo'],
    ['string-length()', 18],
    ['concat(name(), ".", count(*))', 'div.8'],
    ['contains(., "foo")', true],
    ['starts-with(., "^")', true],
    ['substring-before(., "bar")', '^^^'],
    ['substring-after(., "foo")', ''],
    ['string-length(./b[1])', 3],
  ], "document.getElementById('context')");
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: name(), local-name(), namespace-uri() and string-values in XML documents', async () => {
  const e = await pageEnv();
  const src = '<root xmlns:alpha="http://example.com/alpha" xmlns:gamma="http://example.com/gamma"><alpha:beta gamma:delta="epsilon"></alpha:beta><plain zeta="1"/></root>';
  e.run(`
    var nd = xml(${JSON.stringify(src)});
    var res = (p) => ({ alpha: 'http://example.com/alpha', gamma: 'http://example.com/gamma', xmlns: 'http://www.w3.org/2000/xmlns/' })[p] || null;
  `);
  const cases = [
    ['name(./*[1])', 'alpha:beta'],
    ['local-name(./*[1])', 'beta'],
    ['namespace-uri(./*[1])', 'http://example.com/alpha'],
    ['name(./*[1]/@*)', 'gamma:delta'],
    ['local-name(./*[1]/@*)', 'delta'],
    ['namespace-uri(./*[1]/@*)', 'http://example.com/gamma'],
    ['name(./*[2])', 'plain'],
    ['local-name(./*[2])', 'plain'],
    ['namespace-uri(./*[2])', ''],
    ['name(./*[2]/@*)', 'zeta'],
    ['local-name(./*[2]/@*)', 'zeta'],
    ['namespace-uri(./*[2]/@*)', ''],
    ['name()', 'root'],
    ['local-name()', 'root'],
    ['namespace-uri()', ''],
    ['name(/)', ''],
    ['name(//nothing)', ''],
    ['name(.//text())', ''],
    ['name(1)', ''],
    ['local-name("x")', ''],
    ['namespace-uri(1 = 1)', ''],
    // Namespace declarations are not attributes
    ['count(//@*)', 2],
    ['count(@*)', 0],
    ['count(/*/@*)', 0],
    ['count(namespace::*)', 0],
    ['count(//@xmlns)', 0],
    ['count(//@xmlns:alpha)', 0],
    ['count(//@*[name() = "xmlns:alpha"])', 0],
    ['//*[local-name() = "beta"]/@*', '[@gamma:delta=epsilon]'],
    ['count(//*[namespace-uri() = "http://example.com/alpha"])', 1],
    ['count(//*[name() = "alpha:beta"])', 1],
    ['count(//alpha:beta)', 1],
    ['count(//@gamma:delta)', 1],
    ['count(//@delta)', 0],
    ['count(//@*[local-name() = "delta"])', 1],
    ['string(//@gamma:delta)', 'epsilon'],
  ];
  const got = e.run(`(${JSON.stringify(cases.map((c) => c[0]))}).map((x) => X(x, nd.documentElement, res, nd))`);
  cases.forEach(([expr, want], i) => assert.strictEqual(got[i], want, `${expr}: ${got[i]} !== ${want}`));

  // id(): the first element with that id for each whitespace-separated token; case-sensitive
  const idCases = [
    ['id("test1")', '<root><div id="test1">Match</div></root>', '[div#test1]'],
    ['id("test1 test2")', '<root><div id="test1">First</div><div id="test2">Second</div></root>', '[div#test1 div#test2]'],
    ['id("test2 test1")', '<root><div id="test1">First</div><div id="test2">Second</div></root>', '[div#test1 div#test2]'],
    ['id("nonexistent")', '<root><div id="test1">No match</div></root>', '[]'],
    ['id("Test1")', '<root><div id="test1">No match</div></root>', '[]'],
    ['id("duplicate")', '<root><div id="duplicate">First</div><div id="duplicate">Second</div></root>', '[div#duplicate]'],
    ['id("test-1")', '<root><div id="test-1">Match</div></root>', '[div#test-1]'],
    ['id("")', '<root><div id="">Empty ID</div></root>', '[]'],
    ['id(" test1 ")', '<root><div id="test1">Match</div></root>', '[div#test1]'],
    ['id("a\tb\nc")', '<root><i id="a"/><i id="b"/><i id="c"/></root>', '[i#a i#b i#c]'],
    ['id(//ref)', '<root><ref>x y</ref><ref>z</ref><i id="x"/><i id="y"/><i id="z"/><i id="w"/></root>', '[i#x i#y i#z]'],
    ['id(//nothing)', '<root><i id="x"/></root>', '[]'],
    ['id(1)', '<root><i id="1"/></root>', '[i#1]'],
    ['id("x")/@id', '<root><i id="x"/></root>', '[@id=x]'],
    ['string(id("x")/b)', '<root><i id="x"><b>bee</b></i></root>', 'bee'],
    ['count(id("x")/following::*)', '<root><i id="x"/><i/><i/></root>', 2],
    ['id("x")', '<root><i xml:id="x"/></root>', '[]'],
  ];
  for (const [expr, source, want] of idCases) {
    assert.strictEqual(e.run(`(() => { const d = xml(${JSON.stringify(source)}); return X(${JSON.stringify(expr)}, d, null, d); })()`), want, `${expr} on ${source}`);
  }
  // ... in the HTML document from any context in it, and in detached trees (a tree is searched on its own)
  table(e, [['id("a")', '[div#a]'], ['id("a b")', '[div#a div#b]'], ['id("b a")', '[div#a div#b]'], ['id("nothing")', '[]']]);
  table(e, [['id("b")/i', '[i]'], ['string(id("a")/span)', 'one']], "document.querySelector('i')");
  assert.strictEqual(e.run(`
    const t = document.createElement('div'); t.innerHTML = '<p id="tp">x</p><p id="tq">y</p>';
    [X('id("tp")', t), X('id("a")', t), X('id("tp tq")', t.firstChild), X('id("tq")', t.lastChild), X('id("x")', document.createElement('div'))].join('|')`),
  '[p#tp]|[]|[p#tp p#tq]|[p#tq]|[]');

  // lang(): xml:lang of the context node or its nearest ancestor, ASCII case-insensitive, with subtags
  const langCases = [
    ['lang("en")', '<root><match xml:lang="en"/></root>', true],
    ['lang("en")', '<root><match xml:lang="EN"/></root>', true],
    ['lang("EN")', '<root><match xml:lang="en"/></root>', true],
    ['lang("en")', '<root><match xml:lang="en-us"/></root>', true],
    ['lang("en-US")', '<root><match xml:lang="en-us"/></root>', true],
    ['lang("en-us")', '<root><unmatch xml:lang="en"/></root>', false],
    ['lang("en")', '<root><unmatch xml:lang="english"/></root>', false],
    ['lang("en")', '<root><unmatch/></root>', false],
    ['lang("ja")', '<root xml:lang="ja"><match/></root>', true],
    ['lang("ja")', '<root xml:lang="ja-jp"><match/></root>', true],
    ['lang("ja")', '<root xml:lang="ja-jp"><unmatch xml:lang="ja_JP"/></root>', false],
    ['lang("ja")', '<root xml:lang="ja"><unmatch xml:lang="de"/></root>', false],
    ['lang("ko")', '<root><unmatch xml:lang="Ko"/></root>', false],
    ['lang("")', '<root><match xml:lang=""/></root>', true],
    ['lang("")', '<root><unmatch xml:lang="en"/></root>', false],
    ['lang(//nothing)', '<root xml:lang="en"><unmatch/></root>', false],
  ];
  for (const [expr, source, want] of langCases) {
    const r = e.run(`(() => {
      const d = xml(${JSON.stringify(source)});
      const r = d.evaluate(${JSON.stringify(expr)}, d.documentElement.firstChild, null, XPathResult.BOOLEAN_TYPE, null);
      return [r.resultType, r.booleanValue].join();
    })()`);
    assert.strictEqual(r, '3,' + want, `${expr} on ${source}`);
  }
  // Ancestors, and attributes and text nodes as context
  assert.strictEqual(e.run(`
    const ld = xml('<root xml:lang="en"><a><b>text<match/></b></a></root>');
    const deep = ld.getElementsByTagName('match')[0];
    [X('lang("en")', deep, null, ld), X('lang("en-GB")', deep, null, ld), X('lang("en")', deep.previousSibling, null, ld), X('lang("en")', ld.documentElement.getAttributeNode('xml:lang'), null, ld), X('lang("en")', ld, null, ld)].join()`),
  'true,false,true,true,false');

  // String-values of every kind of node, and processing-instruction() tests
  assert.strictEqual(e.run(`
    const sd = xml('<r a="v1"><!--cm--><![CDATA[c<d]]>t<e>x<f>y</f></e></r>');
    sd.documentElement.appendChild(sd.createProcessingInstruction('tgt', 'some data'));
    ['string(/)', 'string(/r)', 'string(/r/@a)', 'string(/r/comment())', 'string(/r/processing-instruction())', 'string(/r/processing-instruction("tgt"))', 'string(/r/text())',
     'count(/r/text())', 'string(/r/e)', 'name(/r/processing-instruction())', 'local-name(/r/processing-instruction("tgt"))', 'namespace-uri(/r/processing-instruction())',
     'count(/r/processing-instruction("nothing"))', 'count(/r/processing-instruction(" tgt "))', 'count(//node())', 'count(/r/*)']
      .map((x) => X(x, sd, null, sd)).join('|')`), 'c<dtxy|c<dtxy|v1|cm|some data|some data|c<d|2|xy|tgt|tgt||0|1|9|1');
  assert.strictEqual(e.run("X('//processing-instruction() | //comment()', sd, null, sd)"), '[<!--cm--> <?tgt some data?>]');
  assert.strictEqual(e.run("X('//text()', sd, null, sd)"), '["c<d" "t" "x" "y"]');
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: name matching in HTML documents', async () => {
  const e = await pageEnv('<!DOCTYPE html><html><head><meta charset="utf8"><title>XPath in text/html</title></head><body>' +
    '<div id="log" nonÄsciiAttribute><span></span></div><div><span></span></div><dØdd></dØdd>' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><path id="a" refx /><path id="b" nonÄscii xlink:href /></svg>' +
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math></body></html>');
  e.run(`
    const NSMAP = { html: 'http://www.w3.org/1999/xhtml', svg: 'http://www.w3.org/2000/svg', math: 'http://www.w3.org/1998/Math/MathML', xlink: 'http://www.w3.org/1999/xlink' };
    function nsr(p) { return Object.prototype.hasOwnProperty.call(NSMAP, p) ? NSMAP[p] : null; }
    const tags = (n) => Array.from(document.getElementsByTagName(n));
    // The nodes a path selects (snapshot, in order) as a comma-separated list of what the page can compare: names
    function sel(path, resolver) {
      const r = document.evaluate(path, document, resolver || null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0, n; (n = r.snapshotItem(i)); i++) out.push(n);
      return out;
    }
    function same(path, expected, resolver) {
      const got = sel(path, resolver);
      return got.length === expected.length && got.every((n, i) => n === expected[i]) ? 'ok' : path + ': got ' + got.length + ', want ' + expected.length;
    }
  `);
  const same = (path, expected, resolver) => assert.strictEqual(e.run(`same(${JSON.stringify(path)}, ${expected}, ${resolver ? 'nsr' : 'null'})`), 'ok', path);
  // Elements: an unprefixed name matches HTML elements whatever their case; other elements need a prefix and exact case
  same('//div', "tags('div')");
  same('//html:div', "tags('div')", true);
  same('//html:div/span', "tags('span')", true);
  same('//html:*[html:span]', "tags('div')", true);
  same('//path', '[]');
  same('//svg:path', "tags('path')", true);
  same('//svg:*', "[document.querySelector('svg'), ...tags('path')]", true);
  same('/html/body/svg/path', '[]');
  same('/html/body/svg:svg/svg:path', "tags('path')", true);
  same('//DiV', "tags('div')");
  same('//html:DIV', "tags('div')", true);
  same('//svg:PatH', '[]', true);
  same('//math:mi', "tags('mi')", true);
  same('//math:MI', '[]', true);
  same('//mi', '[]');
  same('//*[name() = "PATH"]', '[]');
  same('//*[local-name() = "path" and namespace-uri() = "http://www.w3.org/2000/svg"]', "tags('path')");
  // Non-ASCII letters are not case-folded
  same('//dØdd', "tags('dØdd')", true);
  same('//dødd', '[]', true);
  same('//DØDD', "tags('dØdd')", true);
  assert.strictEqual(e.run(catcher("document.evaluate('//invalid:path', document)")), 'NamespaceError/14');
  // Attributes: HTML elements' are case-insensitive, foreign ones exact; namespace declarations are not attributes
  same("//div[@id='log']", "[document.getElementById('log')]");
  same("//div[@Id='log']", "[document.getElementById('log')]");
  same('//*[@id]', "[document.getElementById('log'), ...tags('path')]");
  same('//*[@nonÄsciiattribute]', "[document.getElementById('log')]");
  same('//*[@nonäsciiattribute]', '[]');
  same('//*[@nonÄsciiAttribute]', "[document.getElementById('log')]");
  same('//svg:path[@Id]', '[]', true);
  same('//*[@Id]', "[document.getElementById('log')]");
  same('//*[@refX]', "[document.getElementById('a')]");
  same('//*[@Refx]', '[]');
  same('//*[@refx]', '[]');
  same('//*[@nonÄscii]', "[document.getElementById('b')]");
  same('//*[@nonäscii]', '[]');
  same('//*[@xmlns]', '[]');
  same('//*[@xlink:href]', "[document.getElementById('b')]", true);
  same('//@xlink:*', "[document.getElementById('b').getAttributeNode('xlink:href')]", true);
  same('//*[@*]', "[document.querySelector('meta'), document.getElementById('log'), ...tags('path')]");
  assert.strictEqual(e.run("document.evaluate('count(//svg:svg/@*)', document, nsr, 1).numberValue"), 0);
  assert.strictEqual(e.run("document.evaluate('count(//@*)', document, null, 1).numberValue"), 8);
  // Documents that are not HTML documents match exactly, and XHTML needs the namespace
  assert.strictEqual(e.run(`(() => {
    const ns = 'http://www.w3.org/1999/xhtml';
    const xd = xml('<html xmlns="' + ns + '"><body><DIV Id="a"/><div id="b"/></body></html>', 'application/xhtml+xml');
    const cnt = (x) => xd.evaluate('count(' + x + ')', xd, (p) => (p === 'h' ? ns : null), 1).numberValue;
    return [cnt('//div'), cnt('//h:div'), cnt('//h:DIV'), cnt('//h:div[@id]'), cnt('//h:DIV[@Id]'), cnt('//h:*[@ID]'), cnt('//*[local-name() = "div"]'), cnt('//*')].join();
  })()`), '0,1,1,1,1,0,1,4');
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: namespaces in XML documents and createNSResolver', async () => {
  const e = await pageEnv();
  const src = '<r xmlns="urn:def" xmlns:a="urn:a" xmlns:b="urn:b"><a:x id="1"/><x id="2"/><b:x a:at="v" at="w" b:at="z"/><a:y><a:x id="3"/></a:y></r>';
  e.run(`
    var nd = xml(${JSON.stringify(src)});
    var res = (p) => ({ d: 'urn:def', a: 'urn:a', b: 'urn:b', other: 'urn:a' })[p] || null;
  `);
  const tableNs = (cases) => {
    const got = e.run(`(${JSON.stringify(cases.map((c) => c[0]))}).map((x) => X(x, nd, res, nd))`);
    cases.forEach(([expr, want], i) => assert.strictEqual(got[i], want, `${expr}: ${got[i]} !== ${want}`));
  };
  tableNs([
    // A default namespace declaration does not apply to names in the expression
    ['count(//x)', 0],
    ['count(//r)', 0],
    ['count(//d:x)', 1],
    ['//d:r', '[r]'],
    ['//a:x', '[x#1 x#3]'],
    ['//b:x', '[x]'],
    ['//other:x', '[x#1 x#3]'],
    ['count(//a:*)', 3],
    ['count(//b:*)', 1],
    ['count(//d:*)', 2],
    ['count(//*)', 6],
    ['count(//*[local-name() = "x"])', 4],
    ['count(//*[local-name() = "x" and namespace-uri() = "urn:a"])', 2],
    ['count(//*[namespace-uri() = "urn:def"])', 2],
    ['count(//*[namespace-uri() = ""])', 0],
    ['//a:x/@id', '[@id=1 @id=3]'],
    ['//d:x/@id', '[@id=2]'],
    ['//a:y/a:x/@id', '[@id=3]'],
    ['//a:y//x', '[]'],
    ['//a:y//a:x', '[x#3]'],
    ['/d:r/*[2]', '[x#2]'],
    ['/d:r/a:y/*', '[x#3]'],
    ['//a:x[@id = 3]/ancestor::*', '[r y]'],
    ['//a:x[1]', '[x#1 x#3]'],
    ['//a:x[2]', '[]'],
    ['(//a:x)[2]', '[x#3]'],
    ['//*[self::a:x or self::b:x]', '[x#1 x x#3]'],
    ['name(//a:x)', 'a:x'],
    ['name(//d:x)', 'x'],
    ['local-name(//a:x)', 'x'],
    ['namespace-uri(//a:x)', 'urn:a'],
    ['namespace-uri(//d:x)', 'urn:def'],
    ['namespace-uri(/*)', 'urn:def'],
    // Attributes: never in the default namespace; prefixes resolve through the declarations in scope
    ['count(//b:x/@*)', 3],
    ['//b:x/@a:at', '[@a:at=v]'],
    ['//b:x/@b:at', '[@b:at=z]'],
    ['//b:x/@at', '[@at=w]'],
    ['//b:x/@other:at', '[@a:at=v]'],
    ['//b:x/@a:*', '[@a:at=v]'],
    ['//b:x/@d:at', '[]'],
    ['count(//b:x/@*[local-name() = "at"])', 3],
    ['//b:x/@*[namespace-uri() = "urn:a"]', '[@a:at=v]'],
    ['//b:x/@*[name() = "b:at"]', '[@b:at=z]'],
    ['string(//b:x/@a:at)', 'v'],
    ['count(//@*)', 6],
    ['count(//@xmlns)', 0],
    ['count(//r/@*)', 0],
    ['count(/*/namespace::*)', 0],
  ]);
  // An unknown prefix is a NamespaceError before anything is evaluated; there is no default for expressions
  assert.strictEqual(e.run("X('//zz:x', nd, res, nd)"), 'ERR NamespaceError');
  assert.strictEqual(e.run("X('//zz:x/@id | //a:x', nd, () => null, nd)"), 'ERR NamespaceError');
  assert.strictEqual(e.run("X('//x[@zz:id]', nd, null, nd)"), 'ERR NamespaceError');
  assert.strictEqual(e.run("X('//a:x', nd, null, nd)"), 'ERR NamespaceError');
  assert.strictEqual(e.run("X('count(//x)', nd, null, nd)"), 0);
  // createNSResolver hands the node back; its lookupNamespaceURI does the work (in-scope declarations)
  assert.strictEqual(e.run(`
    const nr = nd.createNSResolver(nd.documentElement);
    [nr === nd.documentElement, nr.lookupNamespaceURI('a'), nr.lookupNamespaceURI('b'), nr.lookupNamespaceURI(null), nr.lookupNamespaceURI('nothing'), nr.lookupNamespaceURI('xml')].join('|')`),
  'true|urn:a|urn:b|urn:def||http://www.w3.org/XML/1998/namespace');
  assert.strictEqual(e.run("X('//a:x | //b:x', nd, nd.createNSResolver(nd.documentElement), nd)"), '[x#1 x x#3]');
  assert.strictEqual(e.run("X('//a:x', nd, nd.createNSResolver(nd), nd)"), '[x#1 x#3]');
  assert.strictEqual(e.run("X('/d:r', nd, { lookupNamespaceURI: (p) => (p === 'd' ? 'urn:def' : null) }, nd)"), '[r]');
  // Redeclared prefixes: the resolver node decides
  assert.strictEqual(e.run(`
    const d2 = xml('<o xmlns:p="urn:1"><i xmlns:p="urn:2"><p:z id="in"/></i><p:z id="out"/></o>');
    const inner = d2.getElementsByTagName('i')[0];
    [X('//p:z', d2, d2.createNSResolver(d2.documentElement), d2), X('//p:z', d2, d2.createNSResolver(inner), d2), X('//p:z/@id', d2, d2.createNSResolver(d2.documentElement), d2)].join()`),
  '[z#out],[z#in],[@id=out]');
  // No-namespace elements match an unprefixed test; a prefix that resolves to "" matches nothing
  assert.strictEqual(e.run(`
    const d3 = xml('<r><a/><b xmlns="urn:x"/></r>');
    [X('//a', d3, null, d3), X('//b', d3, null, d3), X('//q:b', d3, (p) => 'urn:x', d3), X('//q:a', d3, (p) => '', d3), X('//q:*', d3, (p) => '', d3)].join()`),
  '[a],[],[b],[],[]');
  // Elements made through the DOM keep the namespaces they were given
  assert.strictEqual(e.run(`
    const d4 = document.implementation.createDocument('urn:root', 'root');
    d4.documentElement.appendChild(d4.createElementNS('urn:kid', 'k:kid'));
    d4.documentElement.appendChild(d4.createElementNS(null, 'plain'));
    const rr = (p) => ({ r: 'urn:root', k: 'urn:kid' })[p] || null;
    [X('/r:root/k:kid', d4, rr, d4), X('/r:root/plain', d4, rr, d4), X('//kid', d4, rr, d4), X('/*/*', d4, rr, d4), X('name(/*/*[1])', d4, rr, d4), X('namespace-uri(/*/*[1])', d4, rr, d4),
     X('namespace-uri(/*/*[2])', d4, rr, d4), X('count(//k:*)', d4, rr, d4)].join('|')`),
  '[kid]|[plain]|[]|[kid plain]|k:kid|urn:kid||1');
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: namespace resolvers are callback interface values', async () => {
  const e = await pageEnv();
  e.run(`
    var reported = [];
    addEventListener('error', (ev) => reported.push(ev.error));
    function ev(expr, resolver) { try { document.evaluate(expr, document.documentElement, resolver); return 'ok'; } catch (x) { return x.name + '/' + x.code; } }
  `);
  // A function is called once per prefixed name test, every time, without looking up lookupNamespaceURI on it
  assert.strictEqual(e.run(`(() => {
    let calls = 0, gets = 0; const seen = [];
    const fn = function (prefix) { 'use strict'; calls++; seen.push(prefix + ':' + (this === undefined)); return ''; };
    Object.defineProperty(fn, 'lookupNamespaceURI', { get() { gets++; } });
    return [ev('/foo:bar', fn), ev('/foo:bar', fn), ev('/foo:bar/baz:x | //foo:y', fn), calls, gets, seen.join()].join('|');
  })()`),
  'ok|ok|ok|5|0|foo:true,foo:true,foo:true,baz:true,foo:true');
  // An object is asked through its lookupNamespaceURI method, looked up anew each time
  assert.strictEqual(e.run(`(() => {
    let thisValue, prefixArg, gets = 0, calls = 0;
    const obj = { lookupNamespaceURI(prefix) { thisValue = this; prefixArg = prefix; return ''; } };
    ev('/foo:bar', obj);
    const holder = { get lookupNamespaceURI() { gets++; return () => { calls++; return ''; }; } };
    ev('/foo:bar', holder); ev('/foo:bar', holder);
    return [thisValue === obj, prefixArg, gets, calls].join();
  })()`), 'true,foo,2,2');
  // What it returns: null and undefined leave the prefix unresolved, anything else is converted to a string
  assert.strictEqual(e.run(`[() => undefined, () => null, () => '', () => 0, () => false, () => ({ toString: () => 'urn:x' }), () => 'urn:x']
    .map((f) => ev('/foo:bar', f)).join()`), 'NamespaceError/14,NamespaceError/14,ok,ok,ok,ok,ok');
  assert.strictEqual(e.run("document.evaluate('count(//p:html)', document, (p) => 'http://www.w3.org/1999/xhtml', 1).numberValue"), 1);
  assert.strictEqual(e.run("document.evaluate('count(//p:html)', document, () => new String('http://www.w3.org/1999/xhtml'), 1).numberValue"), 1);
  assert.strictEqual(e.run("document.evaluate('count(//p:html)', document, () => 42, 1).numberValue"), 0);
  // Exceptions in the resolver, a missing method and a Symbol result are reported to window.onerror; the evaluation fails with a NamespaceError
  assert.strictEqual(e.run(`(() => {
    reported.length = 0;
    const boom = { name: 'boom' };
    const out = [ev('/foo:bar', () => { throw boom; }), ev('/foo:bar', { get lookupNamespaceURI() { throw boom; } }),
      ev('/foo:bar', { lookupNamespaceURI: {} }), ev('/foo:bar', {}), ev('/foo:bar', () => Symbol()),
      ev('/foo:bar', () => ({ toString() { throw boom; }, valueOf() { throw new Error('valueOf must not be called'); } }))];
    return [out.join(), reported.map((r) => (r === boom ? 'boom' : r instanceof TypeError ? 'TypeError' : String(r))).join()].join('|');
  })()`),
  'NamespaceError/14,NamespaceError/14,NamespaceError/14,NamespaceError/14,NamespaceError/14,NamespaceError/14|boom,boom,TypeError,TypeError,TypeError,boom');
  // Not an object at all: a plain TypeError before any evaluation
  assert.strictEqual(e.run("[1, 'x', true, Symbol()].map((r) => { try { document.evaluate('1', document, r); return 'no'; } catch (x) { return x.constructor === TypeError; } }).join()"), 'true,true,true,true');
  // null and undefined mean no resolver
  assert.strictEqual(e.run("[ev('//x', null), ev('//x', undefined), ev('/foo:bar', null), ev('/foo:bar', undefined)].join()"), 'ok,ok,NamespaceError/14,NamespaceError/14');
  // Expressions without prefixes never call the resolver
  assert.strictEqual(e.run("(() => { let never = 0; document.evaluate('//div[@id]/span | //@id', document, () => { never++; return null; }); return never; })()"), 0);
  // createExpression resolves at creation time and evaluate() never asks again
  assert.strictEqual(e.run(`(() => {
    let n = 0; const rs = () => { n++; return 'http://www.w3.org/1999/xhtml'; };
    const ex = document.createExpression('//h:div', rs);
    const before = n;
    const r1 = ex.evaluate(document, 7), r2 = ex.evaluate(document.body, 7);
    return [before, n, r1.snapshotLength, r2.snapshotLength].join();
  })()`), '1,1,2,2');
  assert.strictEqual(e.run(catcher("document.createExpression('//h:div')")), 'NamespaceError/14');
  assert.strictEqual(e.run(catcher("document.createExpression('//div[')")), 'SyntaxError/12');
  // (what the resolvers threw was logged as uncaught errors, as reported exceptions are)
  assert.ok(e.errors().length >= 6 && e.errors().every((m) => m.startsWith('Uncaught')));
});

test('XPath: results: types, conversions, iterators and snapshots', async () => {
  const e = await pageEnv();
  const type = (expr, ty) => e.run(`document.evaluate(${JSON.stringify(expr)}, document, null${ty === undefined ? '' : ', ' + ty}).resultType`);
  // The natural type, when none is asked for
  for (const [expr, want] of [['1', 1], ['"s"', 2], ['true()', 3], ['//span', 4], ['//nothing', 4], ['count(//span)', 1], ['.', 4], ['string(.)', 2]]) {
    assert.strictEqual(type(expr), want, expr);
    assert.strictEqual(type(expr, 0), want, expr + ' (ANY_TYPE)');
    assert.strictEqual(type(expr, 42), want, expr + ' (unknown type)');
  }
  assert.strictEqual(e.run("document.evaluate('1', document, undefined, undefined, undefined).resultType"), 1);
  // Forced primitive types convert node-sets and other primitives
  const conv = (expr, ty, prop) => e.run(`(() => { const r = document.evaluate(${JSON.stringify(expr)}, document, null, ${ty}); return [r.resultType, r.${prop}].join(':'); })()`);
  assert.strictEqual(conv('//span', 1, 'numberValue'), '1:NaN');
  assert.strictEqual(conv('//div/@id', 2, 'stringValue'), '2:a');
  assert.strictEqual(conv('//span', 2, 'stringValue'), '2:one');
  assert.strictEqual(conv('//nothing', 2, 'stringValue'), '2:');
  assert.strictEqual(conv('//span', 3, 'booleanValue'), '3:true');
  assert.strictEqual(conv('//nothing', 3, 'booleanValue'), '3:false');
  assert.strictEqual(conv('"12"', 1, 'numberValue'), '1:12');
  assert.strictEqual(conv('12', 2, 'stringValue'), '2:12');
  assert.strictEqual(conv('0', 3, 'booleanValue'), '3:false');
  assert.strictEqual(conv('"0"', 3, 'booleanValue'), '3:true');
  assert.strictEqual(conv('true()', 1, 'numberValue'), '1:1');
  assert.strictEqual(conv('true()', 2, 'stringValue'), '2:true');
  assert.strictEqual(conv('1 div 0', 2, 'stringValue'), '2:Infinity');
  // Node-set types need a node-set
  for (const ty of [4, 5, 6, 7, 8, 9]) {
    for (const expr of ['string(/)', '1', 'true()']) assert.strictEqual(e.run(catcher(`document.evaluate(${JSON.stringify(expr)}, document, null, ${ty})`)), 'TypeError', `${expr} as ${ty}`);
  }
  // The accessors of another type throw TypeError
  assert.strictEqual(e.run(`
    const props = ['numberValue', 'stringValue', 'booleanValue', 'singleNodeValue', 'snapshotLength'];
    const exprs = ['', '1', '"s"', 'true()'];
    const attempt = (f) => { try { f(); return 'v'; } catch (x) { return x instanceof TypeError ? 'T' : '?'; } };
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((ty) => {
      const r = document.evaluate(ty <= 3 ? exprs[ty] : '//span', document, null, ty);
      return props.map((p) => attempt(() => r[p])).join('') + ':' + [r.invalidIteratorState, attempt(() => r.iterateNext()), attempt(() => r.snapshotItem(0))].join();
    }).join(' ')`),
  ['vTTTT:false,T,T', 'TvTTT:false,T,T', 'TTvTT:false,T,T', 'TTTTT:false,v,T', 'TTTTT:false,v,T', 'TTTTv:false,T,v', 'TTTTv:false,T,v', 'TTTvT:false,T,T', 'TTTvT:false,T,T'].join(' '));
  // Iterators
  assert.strictEqual(e.run(`
    const it = document.evaluate('//span | //i', document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    const seen = []; for (let n; (n = it.iterateNext());) seen.push(n.localName);
    [seen.join(), it.iterateNext(), it.iterateNext(), it.invalidIteratorState].join('|')`), 'span,span,i|||false');
  assert.strictEqual(e.run(`
    const it2 = document.evaluate('//nothing', document, null, XPathResult.UNORDERED_NODE_ITERATOR_TYPE);
    [it2.iterateNext(), it2.invalidIteratorState].join()`), ',false');
  assert.strictEqual(e.run(`
    const first = document.querySelector('span');
    const it3 = document.evaluate('//span', document, null, 4);
    [it3.iterateNext() === first, it3.iterateNext() === first.nextSibling, it3.iterateNext()].join()`), 'true,true,');
  // Snapshots
  assert.strictEqual(e.run(`
    const sn = document.evaluate('//span', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE);
    [sn.snapshotLength, sn.snapshotItem(0) === first, sn.snapshotItem(1) === first.nextSibling, sn.snapshotItem(2), sn.snapshotItem(-1), sn.snapshotItem(4294967296) === first,
     sn.snapshotItem('1') === first.nextSibling, sn.snapshotItem(1.9) === first.nextSibling].join()`), '2,true,true,,,true,true,true');
  assert.strictEqual(e.run(`
    const un = document.evaluate('//nothing', document, null, 6);
    [un.snapshotLength, un.snapshotItem(0), un.invalidIteratorState].join()`), '0,,false');
  // A snapshot survives changes to the document; an iterator goes stale, exhausted or not
  assert.strictEqual(e.run(`
    const snap = document.evaluate('//span', document, null, 7), iter = document.evaluate('//span', document, null, 5), iter2 = document.evaluate('//span', document, null, 5);
    iter2.iterateNext();
    const extra = document.createElement('span'); document.body.appendChild(extra);
    const res = [snap.snapshotLength, snap.snapshotItem(0) === first, iter.invalidIteratorState, iter2.invalidIteratorState];
    for (const it of [iter, iter2]) { try { it.iterateNext(); res.push('no'); } catch (x) { res.push(x.name + '/' + x.code); } }
    extra.remove();
    res.push(iter.invalidIteratorState);
    res.join()`), '2,true,true,true,InvalidStateError/11,InvalidStateError/11,true');
  assert.strictEqual(e.run(`
    const itA = document.evaluate('//span', document, null, 5); itA.iterateNext(); itA.iterateNext(); itA.iterateNext();
    document.body.setAttribute('data-x', '1');
    const afterAttr = (() => { try { itA.iterateNext(); return 'no'; } catch (x) { return x.name; } })();
    const nonIter = document.evaluate('count(//span)', document, null, 1); document.body.appendChild(document.createElement('u'));
    [afterAttr, nonIter.invalidIteratorState, nonIter.numberValue].join()`), 'InvalidStateError,false,2');
  // Single nodes
  assert.strictEqual(e.run(`
    const one = document.evaluate('//span', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE), any = document.evaluate('//span', document, null, XPathResult.ANY_UNORDERED_NODE_TYPE);
    const none = document.evaluate('//nothing', document, null, 9);
    [one.singleNodeValue === first, one.resultType, any.singleNodeValue === first || any.singleNodeValue === first.nextSibling, none.singleNodeValue].join()`), 'true,9,true,');
  // The nodes in results are the page's own objects, attributes included
  assert.strictEqual(e.run(`
    const d = document.getElementById('a');
    const attrRes = document.evaluate('//div[@id="a"]/@id', document, null, 9).singleNodeValue;
    [attrRes === d.getAttributeNode('id'), attrRes.ownerElement === d, attrRes instanceof Attr, attrRes.nodeType,
     document.evaluate('//div[@id="a"]', document, null, 9).singleNodeValue === d,
     document.evaluate('//text()', document, null, 9).singleNodeValue.nodeType, document.evaluate('//comment()', document, null, 9).singleNodeValue instanceof Comment,
     document.evaluate('/', document, null, 9).singleNodeValue === document].join()`), 'true,true,true,2,true,3,true,true');
  // Passing a result to reuse (the fifth argument) is allowed; the outcome is a correct result
  assert.strictEqual(e.run(`
    const rr = document.evaluate('..', document.documentElement, null, 0, null);
    const first1 = rr.iterateNext(), end1 = rr.iterateNext();
    const rr2 = document.evaluate('..', document.documentElement, null, 0, rr);
    [first1 === document, end1, rr2.iterateNext() === document, rr2.iterateNext()].join()`), 'true,,true,');
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: syntax errors, arity and other failures', async () => {
  const e = await pageEnv();
  const outcome = (expr) => e.run(`(() => { try { document.evaluate(${JSON.stringify(expr)}, document, null, 0); return 'ok'; } catch (x) { return x.name + '/' + x.code + '/' + (x instanceof DOMException); } })()`);
  const bad = ['', ' ', '/ /', '//', '///a', '/a//', 'a/', 'a//', '/a[', '/a]', '/a[]', 'a[1', '(', ')', '()', '(1', '1)', 'a b', 'a,b', ',', '1 2', '1 +', '+ 1', '* 2', '1 *', 'a |', '| a', 'a ||b',
    '"unterminated', "'unterminated", '’xyz’', '\x0B\x0C .', '\x0E\x0F .', '　 .', '  .', ' .', '!', 'a ! b', 'a !', '1 == 1', '1 <> 2', '=', '@', '@@a', 'a@b',
    'a::b', 'unknown::a', 'child::', 'child::node(', 'child::node(1)', 'text(1)', 'comment("x")', 'node("x")', 'processing-instruction(1)', 'processing-instruction("a", "b")',
    'processing-instruction(', 'processing-instruction("a"', '.[1]', '..[1]', './/.[1]', 'a/1', 'a/"x"', 'a/(b)', 'a/count(b)', '$', '$1', '$a:', 'a[$]',
    'a:', ':a', 'a::', 'a:b:c', '1a', '1.2.3', 'a/@', 'a/@*x', 'foo()', 'position(1)', 'last(1)', 'count()', 'count(a, b)', 'true(1)', 'not()', 'not(1, 2)', 'substring()', 'substring("1")',
    'substring("1", 1, 1, 1)', 'string(1, 2)', 'lang()', 'id()', 'sum()', 'floor()', 'round(1, 2)', 'translate("a", "b")', 'contains("a")', 'starts-with("a")', 'concat("a")', 'concat()',
    'name(1, 2)', 'x:foo()', 'a b c', 'and a', 'a and', 'or or', 'a div', 'mod 1', 'a mod', '5 5', '(a)(b)', 'a[b][', 'a[b]]', '- ', 'a/-b', 'a/+b', '//@', '//*[', "//a[@b='", '@a[', '1 <',
    '< 1', '1 <= ', 'position(', '//  ', '1e3', '0x10', '1.5.5'];
  for (const expr of bad) assert.strictEqual(outcome(expr), 'SyntaxError/12/true', JSON.stringify(expr));
  const good = ['/', '/ ', ' / ', '/ a', '/ * ', '. ', ' .. ', './/a', '..//a', '//a', '//*', '/*', 'a', '*', '@*', '@a', 'a/b', 'a | b', 'a|b', '(a)', '(a)[1]', '(a)/b', '(a)//b', '(a | b)/c', 'a[b]', 'a[b][c]',
    'a[b or c]', 'a[b and c]', 'a[.]', 'a[..]', 'a[1]', 'a[last()]', 'a[position()=1]', '1', '.5', '5.', '1.5', '"a"', "'a'", '"a\'b"', "'a\"b'", '-1', '- -1', '1-1', '1 -1', 'a-b', 'a.b', 'a_b', 'a-',
    'a.', '_a', 'é', 'ǅ', 'á', 'true()', 'true ( )', 'text()', 'text ( )', 'comment()', 'node()', 'processing-instruction()', "processing-instruction('x')", 'processing-instruction("x")',
    'child::a', 'child :: a', 'child::*', 'child::node()', 'descendant::a', 'descendant-or-self::a', 'ancestor::a', 'ancestor-or-self::a', 'following::a', 'following-sibling::a', 'preceding::a',
    'preceding-sibling::a', 'parent::a', 'self::a', 'attribute::a', 'namespace::a', 'child::text()', 'attribute::*', 'a and b', 'a or b', 'a and b or c', 'a = b', 'a != b', 'a < b', 'a <= b',
    'a > b', 'a >= b', 'a + b', 'a - b', 'a * b', 'a div b', 'a mod b', '* * *', '* div *', 'div div div', 'mod mod mod', 'and and and', 'or | and', 'and', 'or', 'div', 'mod', 'text', 'node', 'a/div', 'a/and',
    'a/or/mod', 'count(a)', 'count( a )', 'concat(a, b, c, d)', 'not(a)', 'sum(a)', 'id(a)', 'lang("en")', 'name()', 'name(a)', 'string()', 'position()', 'last()', 'number()', 'normalize-space()',
    'string-length()', 'a[1]/b[2]/c', 'a//b//c', '//a//b', '//a/b', 'a[b[c]]', 'a[b/c = "x"]', '//a[@b][@c]', '//a[@b and @c]', '/a/b/../c', '/a/*/b', '/a/b/@c', '@a/b', '../a', '../../a', '//@a',
    '//text()', '//comment()', '/a/text()', '/child::a/child::b'];
  for (const expr of good) assert.strictEqual(outcome(expr), 'ok', JSON.stringify(expr));
  // Errors in the middle of a long expression; arguments are converted like DOMStrings
  assert.strictEqual(outcome('//a[1]/b[c = "x" and (d or e)]/@f | //g[h(]'), 'SyntaxError/12/true');
  assert.strictEqual(e.run("document.evaluate(null, document).resultType"), 4, '"null" is an element name');
  assert.strictEqual(e.run("document.evaluate({ toString: () => '1 + 1' }, document).numberValue"), 2);
  assert.strictEqual(e.run(catcher('document.evaluate(Symbol(), document)')), 'TypeError');
  // Message shape
  assert.strictEqual(e.run("try { document.evaluate('//div[', document); } catch (x) { x.message }"), "Failed to execute 'evaluate' on 'Document': The string '//div[' is not a valid XPath expression.");
  assert.strictEqual(e.run("try { document.evaluate('//x:div', document); } catch (x) { x.message }"), "Failed to execute 'evaluate' on 'Document': The string '//x:div' contains unresolvable namespaces.");
  assert.strictEqual(e.run("try { new XPathEvaluator().createExpression('x['); } catch (x) { x.message }"), "Failed to execute 'createExpression' on 'XPathEvaluator': The string 'x[' is not a valid XPath expression.");
  // Nothing binds a variable: it is the empty string, as in Blink
  table(e, [
    ['$foo', ''],
    ['string($foo)', ''],
    ['concat("a", $p:q, "b")', 'ab'],
    ['string-length($x)', 0],
    ['$x = ""', true],
    ['//div[@id = $x]', '[]'],
    ['//div[$x]', '[]'],
    ['//div[contains(@id, $x)]', '[div#a div#b]'],
    ['count($x)', 'ERR SyntaxError'],
    ['$x/a', 'ERR SyntaxError'],
  ]);
  // Context nodes of the wrong kind
  assert.strictEqual(e.run("[document.createDocumentFragment(), document.doctype].map((n) => { try { document.evaluate('.', n); return 'no'; } catch (x) { return x.name + '/' + x.code; } }).join()"), 'NotSupportedError/9,NotSupportedError/9');
  assert.strictEqual(e.run("try { document.evaluate('.', document.doctype); } catch (x) { x.message }"), "Failed to execute 'evaluate' on 'Document': The node provided is 'html', which is not a valid context node type.");
  assert.strictEqual(e.run("try { document.createExpression('.').evaluate(document.createDocumentFragment()); } catch (x) { x.name + ': ' + x.message }"),
    "NotSupportedError: Failed to execute 'evaluate' on 'XPathExpression': The node provided is '#document-fragment', which is not a valid context node type.");
  // Deeply nested expressions fail cleanly instead of overflowing the stack
  assert.strictEqual(outcome('('.repeat(200000) + '1' + ')'.repeat(200000)), 'SyntaxError/12/true');
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: context nodes: attributes, other documents, detached trees', async () => {
  const e = await pageEnv();
  // An Attr as context node: its parent is its element; it has no children or siblings
  table(e, [
    ['..', '[div#a]'],
    ['parent::*', '[div#a]'],
    ['ancestor::*', '[html body div#a]'],
    ['ancestor-or-self::node()', '[#document html body div#a @class=x y]'],
    ['.', '[@class=x y]'],
    ['self::node()', '[@class=x y]'],
    ['self::*', '[]'],
    ['string()', 'x y'],
    ['name()', 'class'],
    ['../@id', '[@id=a]'],
    ['../span', '[span span]'],
    ['/html/body/div', '[div#a div#b]'],
    ['//span', '[span span]'],
    ['following::*', '[div#b i]'],
    ['preceding::*', '[head title]'],
    ['preceding::text()', '["T"]'],
    ['following-sibling::node()', '[]'],
    ['preceding-sibling::node()', '[]'],
    ['child::node()', '[]'],
    ['descendant-or-self::node()', '[@class=x y]'],
    ['attribute::*', '[]'],
    ['id("b")', '[div#b]'],
    ['count(//@*)', 3],
    ['lang("x")', false],
  ], "document.getElementById('a').getAttributeNode('class')");
  // An attribute without an element is a tree of its own
  assert.strictEqual(e.run(`
    ['..', 'parent::*', 'ancestor::*', 'ancestor-or-self::*', 'following::*', 'preceding::*', '.', 'self::node()', '/', '//*', 'id("a")', 'string()', 'name()', '../x', '@*', 'descendant::node()', 'following-sibling::*']
      .map((x) => { const a = document.createAttribute('foo'); a.value = 'v'; return X(x, a); }).join(' ')`),
  '[] [] [] [] [] [] [@foo=v] [@foo=v] [@foo=v] [] [] v foo [] [] [] []');
  assert.strictEqual(e.run("[document.createAttribute('foo'), document.createAttributeNS('urn:a', 'p:bar')].map((a) => new XPathEvaluator().evaluate('name()', a, null, 2).stringValue).join()"), 'foo,p:bar');
  // Other documents: names are matched by the node's own document, whichever document evaluates
  assert.strictEqual(e.run(`
    const html_ns = 'http://www.w3.org/1999/xhtml';
    const xml_doc = document.implementation.createDocument(html_ns, 'html');
    const html_doc = document.implementation.createHTMLDocument();
    const nr = (x) => (x === 'html' ? html_ns : null);
    const list = (r) => { const a = []; for (let n; (n = r.iterateNext());) a.push(n); return a; };
    const same = (r, expected) => { const a = list(r); return a.length === expected.length && a.every((n, i) => n === expected[i]); };
    [same(xml_doc.evaluate('//html', xml_doc), []), same(html_doc.evaluate('//html', html_doc), [html_doc.documentElement]),
     same(xml_doc.evaluate('//html', html_doc), [html_doc.documentElement]), same(html_doc.evaluate('//html', xml_doc), []),
     same(xml_doc.evaluate('//html', xml_doc, nr), []), same(html_doc.evaluate('//html', html_doc, nr), [html_doc.documentElement]),
     same(xml_doc.evaluate('//html', html_doc, nr), [html_doc.documentElement]), same(html_doc.evaluate('//html', xml_doc, nr), []),
     same(xml_doc.evaluate('//html:html', xml_doc, nr), [xml_doc.documentElement]),
     same(xml_doc.createExpression('//html').evaluate(xml_doc), []), same(html_doc.createExpression('//html').evaluate(html_doc), [html_doc.documentElement]),
     same(xml_doc.createExpression('//html').evaluate(html_doc), [html_doc.documentElement]), same(html_doc.createExpression('//html').evaluate(xml_doc), []),
     same(html_doc.createExpression('//html', nr).evaluate(xml_doc), []), same(xml_doc.createExpression('//html', nr).evaluate(html_doc), [html_doc.documentElement])].join()`),
  new Array(15).fill('true').join());
  // A compiled expression belongs to no document
  assert.strictEqual(e.run(`
    const ex = document.createExpression('count(//*)');
    [ex.evaluate(document, 1).numberValue, ex.evaluate(html_doc, 1).numberValue, ex.evaluate(xml_doc, 1).numberValue,
     ex.evaluate(xml('<a><b/><b/></a>'), 1).numberValue, ex.evaluate(document.createElement('div'), 1).numberValue].join()`), '11,3,1,3,0');
  // Detached trees: "/" is the root of the tree the context node is in, and a detached tree is not part of the document
  assert.strictEqual(e.run(`
    const tree = document.createElement('section'); tree.innerHTML = '<p id="x">a<b>b</b></p><p>c</p>';
    const inner = tree.firstChild.firstChild;
    [X('/', tree.firstChild), X('/*', tree), X('name(/)', inner), X('//p', tree.lastChild), X('count(//*)', inner), X('..', tree), X('ancestor::*', tree.firstChild.lastChild),
     X('following::text()', inner), X('string(/)', inner), X('count(//text())', tree), X('count(//p)', document), X('count(//p)', tree)].join('|')`),
  '[section]|[p#x p]|section|[p#x p]|3|[]|[section p#x]|["b" "c"]|abc|3|1|2');
  // Text and comment nodes as context
  assert.strictEqual(e.run(`
    const cm = document.querySelector('#b').firstChild;
    [X('..', cm), X('string()', cm), X('following-sibling::*', cm), X('name()', cm), X('self::comment()', cm), X('count(preceding::*)', cm)].join('|')`),
  '[div#b]|c|[i]||[<!--c-->]|7');
  assert.deepStrictEqual(e.errors(), []);
});

test('XPath: the document is read live; compiled expressions are reusable', async () => {
  const e = await pageEnv();
  assert.strictEqual(e.run(`
    const cnt = document.createExpression('count(//li)');
    const out = [];
    const ul = document.createElement('ul'); document.body.appendChild(ul);
    out.push(cnt.evaluate(document, 1).numberValue);
    for (let i = 0; i < 3; i++) { const li = document.createElement('li'); li.id = 'l' + i; li.textContent = 'item' + i; ul.appendChild(li); }
    out.push(cnt.evaluate(document, 1).numberValue);
    ul.firstChild.remove();
    out.push(cnt.evaluate(document, 1).numberValue);
    out.push(document.evaluate('string(//li[1])', document, null, 2).stringValue);
    ul.firstChild.firstChild.data = 'changed';
    out.push(document.evaluate('string(//li[1])', document, null, 2).stringValue);
    ul.firstChild.setAttribute('class', 'k');
    out.push(document.evaluate('count(//li[@class="k"])', document, null, 1).numberValue);
    ul.innerHTML = '';
    out.push(cnt.evaluate(document, 1).numberValue);
    out.join()`), '0,3,2,item1,changed,1,0');
  // Nodes created by scripts are found where they were put, in document order
  assert.strictEqual(e.run(`
    const host = document.getElementById('b');
    const s = document.createElement('section'); s.id = 's'; host.insertBefore(s, host.firstChild);
    [X('//div[@id="b"]/*'), X('//div[@id="b"]/node()[1]'), X('count(id("s"))'), X('//section/following-sibling::*')].join('|')`),
  '[section#s i]|[section#s]|1|[i]');
  assert.deepStrictEqual(e.errors(), []);
});

test('perf: XPath does not go quadratic (following::, nested descendants, unions, large sets)', async () => {
  const e = await pageEnv('<!DOCTYPE html><html><body></body></html>');
  e.run(`
    let html = '';
    for (let i = 0; i < 800; i++) html += '<div class="c' + (i % 7) + '" id="d' + i + '"><span>s' + i + '</span><p><a href="#">a</a> text <b>b</b></p><ul><li>1</li><li>2</li><li>3</li></ul></div>';
    document.body.innerHTML = html;
    let nest = '', close = '';
    for (let i = 0; i < 120; i++) { nest += '<section>'; close += '</section>'; }
    document.body.insertAdjacentHTML('beforeend', nest + '<em>deep</em>' + close);
  `);
  const t0 = process.hrtime.bigint();
  const out = e.run(`[
    document.evaluate('//b/following::li', document, null, 7).snapshotLength,
    document.evaluate('//li/preceding::a', document, null, 7).snapshotLength,
    document.evaluate('//div//li', document, null, 7).snapshotLength,
    document.evaluate('//a | //b | //li', document, null, 7).snapshotLength,
    document.evaluate('//section//section//em', document, null, 7).snapshotLength,
    document.evaluate('//em/ancestor::section', document, null, 7).snapshotLength,
    document.evaluate('//section/descendant-or-self::*', document, null, 7).snapshotLength,
    document.evaluate('//div[@class="c3"]/p/a', document, null, 7).snapshotLength,
    document.evaluate('//li[last()]', document, null, 7).snapshotLength,
    document.evaluate('count(//*)', document, null, 1).numberValue,
    document.evaluate('count(//text())', document, null, 1).numberValue,
    document.evaluate('//div[contains(., "s79")]', document, null, 7).snapshotLength,
  ].join()`);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // (800 divs of 9 elements and 7 text nodes each, plus html, head, body and the nested sections)
  assert.strictEqual(out, '2400,800,2400,4000,1,120,121,114,800,7324,5601,11');
  assert.ok(ms < 4000, `took ${ms.toFixed(0)}ms`);
});

test('XPath: xmlns, xml:lang and xlink attributes: plain on HTML elements, namespaced on foreign ones', async () => {
  const e = await pageEnv('<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><body><div xlink:href="x" xmlns:foo="urn:f"></div>' +
    '<svg xml:lang="de" xmlns:xlink="http://www.w3.org/1999/xlink"><g xml:lang="de-AT"/></svg></body></html>');
  e.run("var nr = (p) => ({ xml: 'http://www.w3.org/XML/1998/namespace', xlink: 'http://www.w3.org/1999/xlink', svg: 'http://www.w3.org/2000/svg', xmlns: 'http://www.w3.org/2000/xmlns/' })[p] || null;");
  const nsTable = (cases, ctx) => {
    const got = e.run(`(${JSON.stringify(cases.map((c) => c[0]))}).map((x) => X(x, ${ctx || 'document'}, nr))`);
    cases.forEach(([expr, want], i) => assert.strictEqual(got[i], want, `${expr}: ${got[i]} !== ${want}`));
  };
  nsTable([
    // On HTML elements the parser makes plain attributes: no namespace, colons in the name, no declarations
    ['//html/@*', '[@xmlns=http://www.w3.org/1999/xhtml @xml:lang=en]'],
    ['//html/@xmlns', '[@xmlns=http://www.w3.org/1999/xhtml]'],
    ['count(//html/@xml:lang)', 0],
    ['local-name(//html/@*[2])', 'xml:lang'],
    ['namespace-uri(//html/@*[2])', ''],
    ['count(//div/@*)', 2],
    ['local-name(//div/@*[1])', 'xlink:href'],
    ['name(//div/@*[2])', 'xmlns:foo'],
    ['count(//div/@xlink:href)', 0],
    ['count(//div/@xlink:*)', 0],
    // On foreign elements they are namespaced attributes, and xmlns ones are declarations
    ['//svg:svg/@*', '[@xml:lang=de]'],
    ['count(//svg:svg/@xml:lang)', 1],
    ['local-name(//svg:svg/@*)', 'lang'],
    ['namespace-uri(//svg:svg/@*)', 'http://www.w3.org/XML/1998/namespace'],
    ['//svg:g/@xml:lang', '[@xml:lang=de-AT]'],
    ['count(//svg:*/@xlink:*)', 0],
    ['count(//svg:svg/@xmlns:xlink)', 0],
    ['count(//@*)', 6],
    // lang() reads xml:lang in the XML namespace only
    ['lang("en")', false],
  ]);
  const lang = (sel, expr) => e.run(`X(${JSON.stringify(expr)}, document.querySelector(${JSON.stringify(sel)}))`);
  assert.strictEqual(lang('html', 'lang("en")'), false);
  assert.strictEqual(lang('div', 'lang("en")'), false);
  assert.strictEqual(lang('svg', 'lang("de")'), true);
  assert.strictEqual(lang('g', 'lang("de")'), true);
  assert.strictEqual(lang('g', 'lang("de-AT")'), true);
  assert.strictEqual(lang('g', 'lang("en")'), false);
  assert.deepStrictEqual(e.errors(), []);
});
