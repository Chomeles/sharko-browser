'use strict';
// Real-library smoke tests: the libraries are loaded as classic scripts (UMD/global builds)
// into the vm context and driven through the native event path (hooks.onEvent).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('../harness');

const NM = path.join(__dirname, '..', 'node_modules');
const CACHE = path.join(NM, '.cache', 'js-layer-tests');

function bundleReact(mode) {
  const out = path.join(CACHE, `react-global.${mode}.js`);
  if (fs.existsSync(out)) return fs.readFileSync(out, 'utf8');
  fs.mkdirSync(CACHE, { recursive: true });
  const entry = path.join(CACHE, 'react-entry.js');
  fs.writeFileSync(entry, "import * as React from 'react';\nimport * as ReactDOMClient from 'react-dom/client';\nimport * as ReactDOM from 'react-dom';\nglobalThis.React = React;\nglobalThis.ReactDOM = Object.assign({}, ReactDOM, ReactDOMClient);\n");
  const esbuild = require('esbuild');
  const r = esbuild.buildSync({
    entryPoints: [entry], bundle: true, format: 'iife', write: false, minify: mode === 'production',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) }, nodePaths: [NM], logLevel: 'silent',
  });
  fs.writeFileSync(out, r.outputFiles[0].text);
  return r.outputFiles[0].text;
}
const read = (p) => fs.readFileSync(path.join(NM, p), 'utf8');

for (const mode of ['production', 'development']) {
  test(`React 19 (${mode}): createRoot, useState, onClick via native click, controlled input, effects`, async () => {
    const e = await createEnv({ html: '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>' });
    e.run(bundleReact(mode), `react.${mode}.js`);
    e.run(`
      window.__effects = [];
      const { useState, useEffect, useRef, useLayoutEffect } = React;
      function Item({ label }) { return React.createElement('li', { className: 'item' }, label); }
      function App() {
        const [n, setN] = useState(0);
        const [text, setText] = useState('init');
        const [checked, setChecked] = useState(false);
        const ref = useRef(null);
        useEffect(() => { __effects.push('effect:' + n); return () => __effects.push('cleanup:' + n); }, [n]);
        useLayoutEffect(() => { __effects.push('layout:' + (ref.current && ref.current.tagName)); }, []);
        return React.createElement('div', { className: 'app' },
          React.createElement('button', { id: 'b', ref, onClick: () => setN((c) => c + 1) }, 'count ' + n),
          React.createElement('input', { id: 'in', value: text, onChange: (ev) => setText(ev.target.value.toUpperCase()) }),
          React.createElement('input', { id: 'cb', type: 'checkbox', checked, onChange: (ev) => setChecked(ev.target.checked) }),
          React.createElement('span', { id: 'echo', style: { color: n % 2 ? 'red' : 'blue' } }, text + ':' + checked),
          React.createElement('ul', null, Array.from({ length: n + 1 }, (_, i) => React.createElement(Item, { key: i, label: 'i' + i }))),
          n >= 2 ? React.createElement('p', { id: 'many', dangerouslySetInnerHTML: { __html: '<b>many</b>' } }) : null);
      }
      window.root = ReactDOM.createRoot(document.getElementById('root'));
      root.render(React.createElement(App));
    `);
    await e.flush();
    assert.deepStrictEqual(e.errors(), []);
    assert.strictEqual(e.text('#b'), 'count 0');
    assert.strictEqual(e.run("document.querySelectorAll('.item').length"), 1);
    assert.deepStrictEqual(Array.from(e.run('__effects')), ['layout:BUTTON', 'effect:0']);
    const flags = e.click('#b');
    await e.flush();
    assert.strictEqual(flags & 1, 0);
    assert.strictEqual(e.text('#b'), 'count 1');
    assert.strictEqual(e.run("document.getElementById('echo').style.color"), 'red');
    e.click('#b');
    await e.flush();
    assert.strictEqual(e.text('#b'), 'count 2');
    assert.strictEqual(e.run("document.querySelectorAll('.item').length + document.getElementById('many').innerHTML"), '3<b>many</b>');
    assert.deepStrictEqual(Array.from(e.run('__effects')).slice(2), ['cleanup:0', 'effect:1', 'cleanup:1', 'effect:2']);
    // controlled text input: Rust edits the value, then dispatches a native input event
    e.mock.n(e.id('#in')).state.value = 'hello';
    e.event('input', '#in', { bubbles: true, inputType: 'insertText', data: 'o' });
    await e.flush();
    assert.strictEqual(e.run("document.getElementById('in').value"), 'HELLO');
    assert.strictEqual(e.text('#echo'), 'HELLO:false');
    // checkbox: React listens to click and reads the (pre-activation toggled) checked state
    e.click('#cb');
    await e.flush();
    assert.strictEqual(e.text('#echo'), 'HELLO:true');
    assert.strictEqual(e.run("document.getElementById('cb').checked"), true);
    e.run('root.unmount()');
    await e.flush();
    assert.strictEqual(e.run("document.getElementById('root').childNodes.length"), 0);
    assert.deepStrictEqual(e.errors(), []);
  }, { timeout: 60000 });
}

test('Preact 10 + hooks (UMD): render, useState, click, effects', async () => {
  const e = await createEnv({ html: '<div id="app"></div>' });
  e.run(read('preact/dist/preact.umd.js'), 'preact.umd.js');
  e.run(read('preact/hooks/dist/hooks.umd.js'), 'hooks.umd.js');
  e.run(`
    const { h, render } = preact;
    const { useState, useEffect } = preactHooks;
    window.__pe = [];
    function Counter() {
      const [n, setN] = useState(0);
      useEffect(() => { __pe.push('effect' + n); }, [n]);
      return h('div', null,
        h('button', { id: 'pb', onClick: () => setN(n + 1), class: 'btn' + n }, 'clicked ' + n),
        h('input', { id: 'pi', onInput: (ev) => setN(ev.currentTarget.value.length) }),
        n > 1 && h('em', { id: 'big', style: { fontWeight: 'bold', marginTop: 4 } }, 'big'));
    }
    render(h(Counter), document.getElementById('app'));
  `);
  await e.flush();
  assert.strictEqual(e.text('#pb'), 'clicked 0');
  e.click('#pb');
  await e.flush();
  assert.strictEqual(e.text('#pb'), 'clicked 1');
  assert.strictEqual(e.run("document.getElementById('pb').className"), 'btn1');
  e.mock.n(e.id('#pi')).state.value = 'abcd';
  e.event('input', '#pi', { bubbles: true, inputType: 'insertText', data: 'd' });
  await e.flush();
  assert.strictEqual(e.text('#pb'), 'clicked 4');
  assert.strictEqual(e.run("document.getElementById('big').style.cssText"), 'font-weight: bold; margin-top: 4px;');
  assert.deepStrictEqual(Array.from(e.run('__pe')), ['effect0', 'effect1', 'effect4']);
  assert.deepStrictEqual(e.errors(), []);
});

test('Vue 3 (global build with runtime compiler): reactivity, v-model, v-for, click', async () => {
  const e = await createEnv({ html: '<div id="app"><button id="vb" @click="n++">{{ n }} {{ doubled }}</button><input id="vi" v-model="msg"><p id="vp">{{ msg.toUpperCase() }}</p><ul><li v-for="x in list" :key="x" :class="{ even: x % 2 === 0 }">{{ x }}</li></ul><span v-if="n > 1" id="vif">shown</span></div>' });
  e.run(read('vue/dist/vue.global.prod.js'), 'vue.global.prod.js');
  e.run(`
    window.__watch = [];
    window.vm = Vue.createApp({
      data() { return { n: 0, msg: 'hi', list: [1, 2] }; },
      computed: { doubled() { return this.n * 2; } },
      watch: { n(v) { __watch.push(v); this.list.push(this.list.length + 1); } },
      mounted() { __watch.push('mounted:' + this.$el.nodeName); },
    }).mount('#app');
  `);
  await e.flush();
  assert.strictEqual(e.text('#vb'), '0 0');
  assert.strictEqual(e.text('#vp'), 'HI');
  e.click('#vb');
  await e.flush();
  assert.strictEqual(e.text('#vb'), '1 2');
  e.click('#vb');
  await e.flush();
  assert.strictEqual(e.text('#vb'), '2 4');
  assert.strictEqual(e.run("document.querySelectorAll('li').length + ':' + document.querySelectorAll('li.even').length + ':' + !!document.getElementById('vif')"), '4:2:true');
  e.mock.n(e.id('#vi')).state.value = 'typed';
  e.event('input', '#vi', { bubbles: true, inputType: 'insertText', data: 'd' });
  await e.flush();
  assert.strictEqual(e.text('#vp'), 'TYPED');
  e.run("vm.msg = 'from js'");
  await e.flush();
  assert.strictEqual(e.run("document.getElementById('vi').value"), 'from js');
  assert.deepStrictEqual(Array.from(e.run('__watch')), ['mounted:#text', 1, 2]);
  assert.deepStrictEqual(e.errors(), []);
});

test('jQuery 3: selectors, DOM manipulation, events, css, data, ajax/getJSON, ready, deferred', async () => {
  const e = await createEnv({
    html: '<!DOCTYPE html><html><head></head><body><div id="c"><p class="a">one</p><p class="a b">two</p><input id="t" type="text" value="val"><select id="s"><option value="1">A</option><option value="2" selected>B</option></select><input id="ch" type="checkbox"></div></body></html>',
    routes: {
      'https://example.com/data.json': { body: { name: 'jq', list: [1, 2] } },
      'https://example.com/fail': { status: 500, statusText: 'Server Error', body: 'x' },
      'https://example.com/post': (req) => ({ body: 'posted', headers: { 'Content-Type': 'text/plain' } }),
      'https://example.com/script.js': "window.__gotScript = 'yes';",
    },
  });
  e.run(read('jquery/dist/jquery.js'), 'jquery.js');
  e.run(`
    window.__j = [];
    $(function () { __j.push('ready'); });
    __j.push($('p.a').length, $('#c > p:last').text(), $('p').eq(0).hasClass('a'), $('.b').is('.a'), $('#s').val(), $('#t').val(), $('p:contains(two)').length, $('input:checkbox').length, $(':input').length);
    $('#c').append('<span class="new">s</span>').prepend($('<em>', { text: 'em', 'data-x': 5 }));
    __j.push($('#c').children().first().prop('tagName'), $('em').data('x'), $('.new').html(), $('#c span').length);
    $('p').addClass('added').removeClass('b').toggleClass('t');
    __j.push($('p.added.t').length, $('p.b').length);
    $('#c').on('click', 'p', function (ev) { __j.push('delegated:' + $(this).text() + ':' + ev.type + ':' + (ev.target === this)); });
    $('#t').on('custom', (ev, x) => __j.push('custom:' + x));
    $('#t').trigger('custom', ['arg']);
    $('p').first().trigger('click');
    $('#c p').last().css({ color: 'red', 'margin-left': '10px' });
    __j.push($('#c p').last().css('color'), $('#c p').last().attr('style'));
    $('#ch').prop('checked', true); __j.push($('#ch').is(':checked'));
    $('#t').val('new'); __j.push($('#t').val());
    $('.new').remove(); __j.push($('.new').length);
    $.each([1, 2], (i, v) => __j.push('each' + v));
    __j.push($('<div><b>x</b></div>').find('b').text(), $.trim('  x  '), $.isPlainObject({}), typeof $.fn.animate);
    $('#t').hide(); __j.push($('#t').css('display'), $('#t').is(':visible')); $('#t').show(); __j.push($('#t').css('display'));
    $.getJSON('/data.json').done((d) => __j.push('getJSON:' + d.name + d.list.length));
    $.ajax({ url: '/fail', dataType: 'text' }).fail((xhr, status, err) => __j.push('fail:' + xhr.status + ':' + status + ':' + err));
    $.post('/post', { a: 1 }, (d) => __j.push('post:' + d));
    $.getScript('/script.js').then(() => __j.push('getScript:' + window.__gotScript));
    const d = $.Deferred(); d.then((v) => __j.push('deferred:' + v)); d.resolve(7);
  `);
  e.click('#c p:nth-of-type(2)'); // "two" (class b was removed by the page script)
  await e.flush();
  const got = Array.from(e.run('__j'));
  assert.deepStrictEqual(got.slice(0, 9), [2, 'two', true, true, '2', 'val', 1, 1, 3]);
  assert.deepStrictEqual(got.slice(9, 15), ['EM', 5, 's', 1, 2, 0]);
  assert.deepStrictEqual(got.slice(15, 18), ['custom:arg', 'delegated:one:click:true', 'red']);
  assert.ok(/color: red;.*margin-left: 10px;/.test(got[18]), got[18]);
  assert.deepStrictEqual(got.slice(19, 29), [true, 'new', 0, 'each1', 'each2', 'x', 'x', true, 'function', 'none']);
  assert.deepStrictEqual(got.slice(29, 31), [false, 'inline-block']);
  const rest = got.slice(31);
  for (const expected of ['ready', 'delegated:two:click:true', 'deferred:7', 'getJSON:jq2', 'fail:500:error:Server Error', 'post:posted', 'getScript:yes']) {
    assert.ok(rest.includes(expected), `missing ${expected} in ${JSON.stringify(rest)}`);
  }
  const post = e.requests.find((r) => r.url.endsWith('/post'));
  assert.strictEqual(post.body.toString(), 'a=1');
  assert.deepStrictEqual(e.errors(), []);
});
