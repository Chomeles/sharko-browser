'use strict';
const assert = require('assert');
const { createEnv } = require('../harness');

const ROUTES = {
  'https://example.com/api/data.json': { body: { items: [1, 2, 3] }, headers: { 'X-Custom': 'yes', 'Set-Cookie': 'a=b' } },
  'https://example.com/api/echo': (req) => ({ status: 201, statusText: 'Created', body: 'echo:' + req.method }),
  'https://example.com/api/redirect': { body: 'moved here', finalUrl: 'https://example.com/api/final' },
  'https://example.com/api/slow': { body: 'slow', delay: 100 },
  'https://example.com/api/missing': { status: 404, statusText: 'Not Found', body: 'nf' },
  'https://example.com/api/neterr': { status: 0, error: 'net::ERR_CONNECTION_REFUSED' },
  'https://other.org/cors': { body: 'x', headers: { 'Content-Type': 'text/plain', 'X-Secret': 's', 'X-Exposed': 'e', 'Access-Control-Expose-Headers': 'X-Exposed' } },
  'https://example.com/text.xml': { body: '<root><a>1</a></root>', headers: { 'Content-Type': 'application/xml' } },
  'https://example.com/bin': { body: Buffer.from([1, 2, 3, 250]), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' } },
};
async function env(extra) { return createEnv(Object.assign({ routes: ROUTES }, extra || {})); }
async function settle(e, code) {
  e.run(`window.__r = undefined; window.__e = undefined; Promise.resolve().then(async () => { ${code} }).then((v) => { window.__r = v; }, (err) => { window.__e = err; });`);
  await e.flush();
  const err = e.run('window.__e');
  if (err !== undefined) throw new Error('page promise rejected: ' + (err && err.stack ? err.stack : err));
  return e.run('window.__r');
}

test('fetch: GET/POST, Response properties and body mixins', async () => {
  const e = await env();
  const r = await settle(e, `
    const res = await fetch('/api/data.json');
    const j = await res.clone().json();
    const t = await res.text();
    let used; try { await res.text(); } catch (err) { used = err instanceof TypeError; }
    return [res.ok, res.status, res.statusText, res.url, res.type, res.redirected, res.headers.get('x-custom'), res.headers.get('set-cookie'), j.items.length, t, res.bodyUsed, used, res instanceof Response].join('|');
  `);
  assert.strictEqual(r, 'true|200|OK|https://example.com/api/data.json|basic|false|yes||3|{"items":[1,2,3]}|true|true|true');
  const post = await settle(e, `
    const res = await fetch('/api/echo', { method: 'post', headers: { 'Content-Type': 'application/json', 'X-A': '1' }, body: JSON.stringify({ a: 1 }) });
    return res.status + ':' + res.statusText + ':' + await res.text();
  `);
  assert.strictEqual(post, '201:Created:echo:POST');
  const req = e.requests.find((q) => q.url.endsWith('/api/echo'));
  assert.strictEqual(req.method, 'POST');
  assert.deepStrictEqual(req.headers, ['Content-Type', 'application/json', 'X-A', '1']);
  assert.strictEqual(req.body.toString(), '{"a":1}');
  const misc = await settle(e, `
    const r1 = await fetch('/api/redirect');
    const r2 = await fetch('/api/missing');
    let neterr; try { await fetch('/api/neterr'); } catch (err) { neterr = err.name + ':' + err.message; }
    const bin = new Uint8Array(await (await fetch('/bin')).arrayBuffer());
    const blob = await (await fetch('/bin')).blob();
    return [r1.redirected, r1.url, r2.ok, r2.status, neterr, Array.from(bin).join(','), blob.size, blob.type].join('|');
  `);
  assert.strictEqual(misc, 'true|https://example.com/api/final|false|404|TypeError:Failed to fetch|1,2,3,250|4|application/octet-stream');
});

test('fetch: abort, CORS filtering, opaque no-cors, data:/blob: URLs, Request object', async () => {
  const e = await env();
  const r = await settle(e, `
    const ac = new AbortController();
    const p = fetch('/api/slow', { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    let aborted; try { await p; } catch (err) { aborted = err.name; }
    let pre; try { await fetch('/api/data.json', { signal: AbortSignal.abort() }); } catch (err) { pre = err.name; }
    const cors = await fetch('https://other.org/cors');
    const hs = [...cors.headers.keys()].join(',');
    const opaque = await fetch('https://other.org/cors', { mode: 'no-cors' });
    const data = await (await fetch('data:text/plain;base64,aGVsbG8=')).text();
    const data2 = await fetch('data:application/json,%7B%22a%22%3A1%7D');
    const burl = URL.createObjectURL(new Blob(['blobby'], { type: 'text/x' }));
    const bres = await fetch(burl);
    const btext = await bres.text();
    URL.revokeObjectURL(burl);
    let revoked; try { await fetch(burl); } catch (err) { revoked = err.name; }
    const rq = new Request('/api/echo', { method: 'PUT', body: 'x', headers: [['a', 'b']] });
    const rr = await fetch(rq);
    return [aborted, pre, cors.type, hs, opaque.type, opaque.status, data, data2.headers.get('content-type'), (await data2.json()).a, btext, bres.headers.get('content-type'), revoked, rq.method, rq.url, rq.headers.get('A'), rq.bodyUsed, await rr.text()].join('|');
  `);
  assert.strictEqual(r, 'AbortError|AbortError|cors|content-type,x-exposed|opaque|0|hello|application/json|1|blobby|text/x|TypeError|PUT|https://example.com/api/echo|b|true|echo:PUT');
  assert.strictEqual(e.run("(() => { try { new Request('/x', { method: 'GET', body: 'a' }) } catch (err) { return err instanceof TypeError } })()"), true);
});

test('Headers, Response constructor and statics', async () => {
  const e = await env();
  assert.strictEqual(e.run(`
    const h = new Headers({ 'Content-Type': 'text/html', 'X-B': '2' });
    h.append('x-b', '3'); h.append('Set-Cookie', 'a=1'); h.append('set-cookie', 'b=2');
    [h.get('X-B'), h.has('content-type'), [...h].map(p => p.join('=')).join(';'), h.getSetCookie().join('+')].join('|')
  `), '2, 3|true|content-type=text/html;set-cookie=a=1;set-cookie=b=2;x-b=2, 3|a=1+b=2');
  assert.strictEqual(e.run("(() => { try { new Headers({ 'bad name': 'x' }) } catch (err) { return err instanceof TypeError } })()"), true);
  const r = await settle(e, `
    const a = new Response('hi', { status: 202, headers: { 'X-Y': 'z' } });
    const b = Response.json({ ok: 1 }, { status: 201 });
    const c = Response.error();
    const d = Response.redirect('https://example.com/r', 301);
    let bad; try { new Response('x', { status: 99 }); } catch (err) { bad = err instanceof RangeError; }
    let imm; try { d.headers.set('a', 'b'); } catch (err) { imm = err instanceof TypeError; }
    const s = new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode('str')); ctl.enqueue(new TextEncoder().encode('eam')); ctl.close(); } }));
    const reader = new Response('abc').body.getReader();
    const chunk = await reader.read();
    return [a.status, a.headers.get('content-type'), await a.text(), b.headers.get('content-type'), (await b.json()).ok, c.type, c.status, d.status, d.headers.get('location'), bad, imm, await s.text(), chunk.value.length, (await reader.read()).done].join('|');
  `);
  assert.strictEqual(r, '202|text/plain;charset=UTF-8|hi|application/json|1|error|0|301|https://example.com/r|true|true|stream|3|true');
});

test('XMLHttpRequest: async lifecycle, response types, headers, errors, abort, timeout, sync', async () => {
  const e = await env();
  e.run(`
    window.__x = [];
    var x = new XMLHttpRequest();
    x.onreadystatechange = () => __x.push('rs' + x.readyState + (x.readyState === 4 ? ':' + x.status : ''));
    ['loadstart', 'progress', 'load', 'loadend'].forEach(t => x.addEventListener(t, (ev) => __x.push(t + (t === 'progress' ? ':' + ev.loaded : ''))));
    x.open('GET', '/api/data.json');
    x.setRequestHeader('X-Req', '1');
    x.send();
    __x.push('sent:' + x.readyState);
  `);
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__x')), ['rs1', 'loadstart', 'sent:1', 'rs2', 'rs3', 'progress:17', 'rs4:200', 'load', 'loadend']);
  assert.strictEqual(e.run("x.responseText + '|' + x.getResponseHeader('X-CUSTOM') + '|' + x.getResponseHeader('set-cookie') + '|' + x.responseURL"), '{"items":[1,2,3]}|yes|null|https://example.com/api/data.json');
  assert.strictEqual(e.run("x.getAllResponseHeaders()"), 'content-type: application/json\r\nx-custom: yes\r\n');
  assert.deepStrictEqual(e.requests.find((q) => q.url.endsWith('data.json')).headers, ['X-Req', '1']);
  e.run(`
    window.__t = {};
    for (const [rt, url] of [['json', '/api/data.json'], ['arraybuffer', '/bin'], ['blob', '/bin'], ['document', '/text.xml'], ['', '/text.xml']]) {
      const y = new XMLHttpRequest(); y.open('GET', url); y.responseType = rt;
      y.onload = () => { __t[rt || 'default'] = rt === 'json' ? y.response.items.length : rt === 'arraybuffer' ? new Uint8Array(y.response)[3] : rt === 'blob' ? y.response.size + y.response.type : rt === 'document' ? y.response.documentElement.nodeName : y.responseXML.querySelector('a').textContent; };
      y.send();
    }
    var err = new XMLHttpRequest(); err.open('GET', '/api/neterr'); err.onerror = (ev) => { __t.error = err.readyState + ':' + err.status + ':' + (ev instanceof ProgressEvent); }; err.send();
    var nf = new XMLHttpRequest(); nf.open('GET', '/api/missing'); nf.onload = () => { __t.nf = nf.status + nf.statusText; }; nf.send();
    var ab = new XMLHttpRequest(); ab.open('GET', '/api/slow'); ab.onabort = () => { __t.abort = ab.readyState; }; ab.send(); setTimeout(() => ab.abort(), 5);
    var to = new XMLHttpRequest(); to.open('GET', '/api/slow'); to.timeout = 20; to.ontimeout = () => { __t.timeout = to.readyState + ':' + to.status; }; to.send();
    var post = new XMLHttpRequest(); post.open('POST', '/api/echo'); post.onload = () => { __t.post = post.status + post.responseText; }; post.send(new URLSearchParams({ q: 'a b' }));
  `);
  await e.flush();
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(__t)')), {
    json: 3, arraybuffer: 250, blob: '4application/octet-stream', document: 'root', default: '1', error: '4:0:true', nf: '404Not Found', abort: 4, timeout: '4:0', post: '201echo:POST',
  });
  assert.strictEqual(e.requests.find((q) => q.method === 'POST' && q.body && q.body.toString() === 'q=a+b').headers.join(), 'Content-Type,application/x-www-form-urlencoded;charset=UTF-8');
  assert.strictEqual(e.run("var s = new XMLHttpRequest(); s.open('GET', '/api/echo', false); s.send(); s.readyState + ':' + s.status + ':' + s.responseText"), '4:201:echo:GET');
  const e2 = await env({ disable: ['fetchSync'] });
  assert.strictEqual(e2.run("(() => { const s = new XMLHttpRequest(); s.open('GET', '/api/echo', false); try { s.send() } catch (err) { return err.name } })()"), 'InvalidAccessError');
});

async function urlChecks(e) {
  assert.strictEqual(e.run(`
    const u = new URL('https://user:pw@example.com:8080/a/b?x=1&y=2#frag');
    [u.protocol, u.username, u.password, u.host, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin, u.searchParams.get('y')].join('|')
  `), 'https:|user|pw|example.com:8080|example.com|8080|/a/b|?x=1&y=2|#frag|https://example.com:8080|2');
  assert.strictEqual(e.run(`
    const v = new URL('/p?q=1', 'https://example.com/base/');
    v.searchParams.append('z', 'a b&c'); v.hash = 'h'; v.pathname = 'new path'; v.port = '81'; v.hostname = 'other.org'; v.protocol = 'http'; v.username = 'u@x';
    v.href
  `), 'http://u%40x@other.org:81/new%20path?q=1&z=a+b%26c#h');
  assert.strictEqual(e.run("const w = new URL('https://e.com/?a=1'); const sp = w.searchParams; w.search = '?b=2'; sp.get('b') + sp.has('a') + (w.searchParams === sp)"), '2falsetrue');
  assert.strictEqual(e.run("const w2 = new URL('https://e.com/?a=1'); w2.searchParams.delete('a'); w2.href"), 'https://e.com/');
  assert.strictEqual(e.run("URL.canParse('nope') + ':' + URL.canParse('/x', 'https://a.b') + ':' + URL.parse('::') + ':' + (() => { try { new URL('nope') } catch (err) { return err instanceof TypeError } })()"), 'false:true:null:true');
  assert.strictEqual(e.run(`
    const p = new URLSearchParams('?a=1&b=%20x+y&a=3&c');
    p.set('b', 'new'); p.append('d', '€'); p.sort();
    [p.getAll('a').join(), p.get('c'), p.toString(), p.size, [...p.keys()].join(), new URLSearchParams({ k: 'v' }).toString(), new URLSearchParams([['x', '1']]).get('x'), p.has('a', '3')].join('|')
  `), '1,3||a=1&a=3&b=new&c=&d=%E2%82%AC|5|a,a,b,c,d|k=v|1|true');
  assert.strictEqual(e.run("new URLSearchParams('%zz=%E2%82%AC&x=%FF').toString()"), '%25zz=%E2%82%AC&x=%EF%BF%BD');
  // setter edge cases (WHATWG): invalid ports/hosts are ignored, special-scheme rules
  assert.strictEqual(e.run(`
    const s = new URL('https://a.com:1/p');
    s.port = '99999999'; const r1 = s.port; s.port = 'x'; const r2 = s.port; s.port = '443'; const r3 = s.port + '|' + s.host;
    s.protocol = 'foo'; const r4 = s.protocol; s.hostname = ''; const r5 = s.hostname; s.pathname = 'a?b#c';
    [r1, r2, r3, r4, r5, s.pathname, (s.search = '#x', s.search), (s.hash = '', s.href)].join('|')
  `), '1|1||a.com|https:|a.com|/a%3Fb%23c|?%23x|https://a.com/a%3Fb%23c?%23x');
}
test('URL and URLSearchParams (setters via native N.urlSet)', async () => {
  await urlChecks(await env());
});
test('URL and URLSearchParams (JS setter fallback)', async () => {
  await urlChecks(await env({ disable: ['urlSet'] }));
});

test('TextEncoder/TextDecoder, atob/btoa, structuredClone, crypto', async () => {
  const e = await env();
  assert.strictEqual(e.run(`
    const enc = new TextEncoder();
    const bytes = enc.encode('a€😀');
    const into = new Uint8Array(5); const res = enc.encodeInto('a€😀', into);
    const dec = new TextDecoder();
    const s1 = dec.decode(bytes.subarray(0, 2), { stream: true }); const s2 = dec.decode(bytes.subarray(2));
    [bytes.length, res.read, res.written, s1 + '|' + s2, new TextDecoder('latin1').encoding, new TextDecoder('utf-16le').decode(new Uint8Array([104, 0, 105, 0])), (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])) } catch (err) { return err instanceof TypeError } })(), (() => { try { new TextDecoder('nope') } catch (err) { return err instanceof RangeError } })(), new TextDecoder().decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41]))].join(',')
  `), '8,2,4,a|€😀,windows-1252,hi,true,true,A');
  assert.strictEqual(e.run("btoa('\\xff\\x00') + atob(' YWJj ') + (() => { try { btoa('€') } catch (err) { return err.name } })() + (() => { try { atob('a') } catch (err) { return err.name } })()"), '/wA=abcInvalidCharacterErrorInvalidCharacterError');
  assert.strictEqual(e.run(`
    const o = { d: new Date(5), m: new Map([[1, { x: 2 }]]), s: new Set([1]), a: [1, , 3], r: /x/g, t: new Uint8Array([1, 2]) }; o.self = o;
    const c = structuredClone(o);
    [c !== o, c.self === c, c.d.getTime(), c.m.get(1).x, c.s.has(1), c.a.length, c.r.flags, c.t[1], (() => { try { structuredClone(() => 1) } catch (err) { return err.name } })(), (() => { try { structuredClone(document.body) } catch (err) { return err.name } })()].join()
  `), 'true,true,5,2,true,3,g,2,DataCloneError,DataCloneError');
  const r = await settle(e, `
    const arr = crypto.getRandomValues(new Uint32Array(4));
    let quota; try { crypto.getRandomValues(new Uint8Array(70000)); } catch (err) { quota = err.name; }
    let mismatch; try { crypto.getRandomValues(new Float32Array(2)); } catch (err) { mismatch = err.name; }
    const hex = (b) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, '0')).join('');
    const d256 = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
    const d1 = hex(await crypto.subtle.digest({ name: 'SHA-1' }, new TextEncoder().encode('abc')));
    const d512 = hex(await crypto.subtle.digest('SHA-512', new TextEncoder().encode('abc')));
    return [arr.length, quota, mismatch, /^[0-9a-f-]{36}$/.test(crypto.randomUUID()), crypto.randomUUID()[14], d256, d1, d512.slice(0, 16)].join('|');
  `);
  assert.strictEqual(r, '4|QuotaExceededError|TypeMismatchError|true|4|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad|a9993e364706816aba3e25717850c26c9cd0d89d|ddaf35a193617aba');
});

test('Blob, File, FileReader, FormData (incl. from a form and multipart fetch bodies)', async () => {
  const e = await env({ html: `<form id="f"><input name="a" value="1"><input name="b" type="checkbox" checked value="on2"><input name="c" type="checkbox"><select name="s"><option>x</option><option selected value="Y">y</option></select><textarea name="t">tt</textarea><input name="d" disabled value="no"><button name="btn" value="bv">b</button><input type="radio" name="r" value="r1" checked></form>` });
  const r = await settle(e, `
    const b = new Blob(['ab', new Uint8Array([99]), new Blob(['d'])], { type: 'Text/Plain' });
    const sl = b.slice(1, 3, 'x/y');
    const f = new File(['file!'], 'n.txt', { type: 'text/plain', lastModified: 5 });
    const fr = new FileReader();
    const url = await new Promise((res) => { fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
    const txt = await new Promise((res) => { const r2 = new FileReader(); r2.addEventListener('loadend', () => res(r2.result + r2.readyState)); r2.readAsText(f); });
    const fd = new FormData(document.getElementById('f'));
    const fd2 = new FormData(document.getElementById('f'), document.querySelector('button'));
    const multi = new FormData(); multi.append('k', 'v'); multi.append('file', f); multi.set('k', 'w');
    await fetch('/api/echo', { method: 'POST', body: multi });
    return [b.size, b.type, await sl.text(), sl.type, f.name, f.lastModified, f instanceof Blob, url, txt, [...fd].map(p => p.join('=')).join('&'), fd2.get('btn'), multi.getAll('k').join(), multi.get('file').name, await b.text(), new Uint8Array(await b.arrayBuffer())[2]].join('|');
  `);
  assert.strictEqual(r, '4|text/plain|bc|x/y|n.txt|5|true|data:text/plain;base64,YWJjZA==|file!2|a=1&b=on2&s=Y&t=tt&r=r1|bv|w|n.txt|abcd|99');
  const req = e.requests.find((q) => q.method === 'POST');
  const ct = req.headers[req.headers.indexOf('Content-Type') + 1];
  assert.ok(/^multipart\/form-data; boundary=----WebKitFormBoundary/.test(ct), ct);
  const body = req.body.toString();
  assert.ok(body.includes('Content-Disposition: form-data; name="k"\r\n\r\nw\r\n'));
  assert.ok(body.includes('name="file"; filename="n.txt"\r\nContent-Type: text/plain\r\n\r\nfile!\r\n'));
});

test('localStorage/sessionStorage, cookies', async () => {
  const e = await env();
  assert.strictEqual(e.run(`
    localStorage.clear();
    localStorage.setItem('a', 1); localStorage.b = { x: 1 }; localStorage['c'] = 'z';
    const keys = Object.keys(localStorage).join();
    delete localStorage.c;
    [localStorage.getItem('a'), typeof localStorage.getItem('a'), localStorage.b, keys, localStorage.length, localStorage.key(0), 'a' in localStorage, localStorage.getItem('nope'), String(localStorage.nope), localStorage instanceof Storage, JSON.stringify(localStorage), sessionStorage.length].join('|')
  `), '1|string|[object Object]|a,b,c|2|a|true||undefined|true|{"a":"1","b":"[object Object]"}|0');
  assert.strictEqual(e.run("sessionStorage.setItem('s', 'v'); localStorage.removeItem('a'); sessionStorage.s + localStorage.length + typeof localStorage.getItem"), 'v1function');
  assert.strictEqual(e.run("document.cookie = 'x=1; path=/'; document.cookie = 'y=2'; document.cookie = 'x=; expires=Thu, 01 Jan 1970 00:00:00 GMT'; document.cookie"), 'y=2');
});

test('location, history, popstate, hashchange', async () => {
  const e = await env({ url: 'https://example.com/start?q=1' });
  e.run(`
    window.__h = [];
    addEventListener('popstate', (ev) => __h.push('pop:' + JSON.stringify(ev.state) + ':' + location.pathname + location.hash));
    addEventListener('hashchange', (ev) => __h.push('hash:' + ev.oldURL.split('/').pop() + '>' + ev.newURL.split('/').pop()));
    history.pushState({ page: 1 }, '', '/p1');
    history.pushState({ page: 2 }, '', 'p2?z=1');
    __h.push('now:' + location.href + ':' + history.state.page + ':' + history.length);
    history.replaceState({ page: 22 }, '');
  `);
  assert.deepStrictEqual(Array.from(e.run('__h')), ['now:https://example.com/p2?z=1:2:3']);
  e.run('history.back()');
  await e.flush();
  e.run('history.forward()');
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__h')).slice(1), ['pop:{"page":1}:/p1', 'pop:{"page":22}:/p2']);
  e.run("__h = []; location.hash = 'sec'");
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__h')), ['pop:null:/p2#sec', 'hash:p2?z=1>p2?z=1#sec']);
  assert.strictEqual(e.run("location.hash + location.search + location.origin + location.host + location.protocol + String(location)"), '#sec?z=1https://example.comexample.comhttps:https://example.com/p2?z=1#sec');
  assert.strictEqual(e.run("(() => { try { history.pushState(null, '', 'https://evil.com/') } catch (err) { return err.name } })()"), 'SecurityError');
  e.run("location.href = '/other'; location.assign('https://x.org/a'); location.replace('rel'); window.location = '/win'; location.search = 'k=v'");
  assert.deepStrictEqual(e.mock.navigations, [
    { url: 'https://example.com/other', replace: false }, { url: 'https://x.org/a', replace: false }, { url: 'https://example.com/rel', replace: true },
    { url: 'https://example.com/win', replace: false }, { url: 'https://example.com/p2?k=v#sec', replace: false },
  ]);
  assert.strictEqual(e.run("history.scrollRestoration = 'manual'; history.scrollRestoration + (history.state && history.state.page)"), 'manualnull');
});

test('matchMedia and viewport changes', async () => {
  const e = await env();
  e.run(`
    window.__mq = [];
    var mql = matchMedia('(min-width: 1000px)');
    mql.addEventListener('change', (ev) => __mq.push('change:' + ev.matches + ':' + ev.media));
    mql.addListener((ev) => __mq.push('legacy:' + ev.matches));
    addEventListener('resize', () => __mq.push('resize:' + innerWidth));
    __mq.push('initial:' + mql.matches + ':' + matchMedia('(prefers-color-scheme: dark)').matches + ':' + (mql instanceof MediaQueryList));
  `);
  e.mock.vp.w = 800;
  e.hook('onViewportChanged');
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__mq')), ['initial:true:false:true', 'resize:800', 'change:false:(min-width: 1000px)', 'legacy:false']);
});

test('IntersectionObserver and ResizeObserver', async () => {
  const e = await env({ html: '<div id="a" style="width:100px;height:50px"></div><div id="b"></div>' });
  const a = e.id('#a'), b = e.id('#b');
  e.mock.rects.set(a, [0, 0, 100, 50]);
  e.mock.rects.set(b, [0, 2000, 100, 100]);
  e.run(`
    window.__io = [];
    var io = new IntersectionObserver((entries, obs) => { for (const en of entries) __io.push(en.target.id + ':' + en.isIntersecting + ':' + en.intersectionRatio + ':' + (obs === io)); }, { threshold: [0, 0.5, 1] });
    io.observe(document.getElementById('a')); io.observe(document.getElementById('b'));
    window.__ro = [];
    var ro = new ResizeObserver((entries) => { for (const en of entries) __ro.push(en.target.id + ':' + en.contentRect.width + 'x' + en.contentRect.height + ':' + en.borderBoxSize[0].inlineSize); });
    ro.observe(document.getElementById('a'));
  `);
  assert.deepStrictEqual(Array.from(e.run('__io')), [], 'initial callback is async');
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__io')), ['a:true:1:true', 'b:false:0:true']);
  assert.deepStrictEqual(Array.from(e.run('__ro')), ['a:100x50:100']);
  e.mock.rects.set(b, [0, 680, 100, 100]);
  e.mock.rects.set(a, [0, 0, 200, 50]);
  e.run("document.getElementById('b').setAttribute('data-moved', '1')");
  await e.flush();
  assert.deepStrictEqual(Array.from(e.run('__io')).slice(2), ['b:true:0.4:true'], 'a stays fully visible: no new entry');
  assert.deepStrictEqual(Array.from(e.run('__ro')).slice(1), ['a:200x50:200']);
  e.run("io.unobserve(document.getElementById('a')); io.disconnect(); ro.disconnect(); __io = []; __ro = []");
  e.mock.rects.set(a, [0, 0, 1, 1]);
  e.run("document.body.appendChild(document.createElement('p'))");
  await e.flush();
  assert.strictEqual(e.run('__io.length + __ro.length'), 0);
  assert.strictEqual(e.run("new IntersectionObserver(() => {}, { rootMargin: '10px 5%' }).rootMargin"), '10px 5% 10px 5%');
});

test('performance, console formatting, navigator, screen, misc window props', async () => {
  const e = await env();
  const r = await settle(e, `
    performance.mark('a');
    await new Promise(r => setTimeout(r, 20));
    performance.mark('b');
    const m = performance.measure('a-b', 'a', 'b');
    const got = [];
    const po = new PerformanceObserver((list) => got.push(...list.getEntries().map(x => x.entryType + ':' + x.name)));
    po.observe({ entryTypes: ['mark', 'measure'] });
    performance.mark('c');
    await new Promise(r => setTimeout(r, 0));
    return [m.duration, performance.getEntriesByName('a')[0].entryType, performance.getEntriesByType('mark').length, got.join(), performance.getEntriesByType('navigation')[0].type, typeof performance.timeOrigin, performance.timing.navigationStart > 0, PerformanceObserver.supportedEntryTypes.includes('mark')].join('|');
  `);
  assert.strictEqual(r, '20|mark|3|mark:c|navigate|number|true|true');
  e.mock.logs.length = 0;
  e.run(`
    console.log('a %s b %d %i %f %o %c!', 'x', '42.9', 3.7, '1.5', { k: [1, { deep: { deeper: { deepest: 1 } } }] }, 'color: red');
    console.info({ a: 1, s: 'str', n: null, u: undefined, f: function named() {}, arr: [1, 'two'], date: new Date(0), map: new Map([[1, 2]]), set: new Set(['x']), el: document.body, err: new TypeError('te') }.a);
    console.warn([1, 2, 3], 'tail', 5);
    console.error(new Error('oops'));
    console.group('G'); console.log('inside'); console.groupEnd(); console.log('outside');
    console.count(); console.count(); console.count('x');
    console.assert(1 === 2, 'assert %s', 'msg');
    console.debug(document.createElement('div'));
    const circ = { name: 'c' }; circ.me = circ; console.log(circ);
    console.table([{ a: 1, b: 2 }, { a: 3 }]);
    console.dir({ x: 1 });
  `);
  const logs = e.mock.logs;
  assert.deepStrictEqual(logs[0], ['log', "a x b 42 3 1.5 {k: [1, {deep: {deeper: {deepest: 1}}}]} !"]);
  assert.deepStrictEqual(logs[1], ['info', '1']);
  assert.deepStrictEqual(logs[2], ['warn', '[1, 2, 3] tail 5']);
  assert.strictEqual(logs[3][0], 'error');
  assert.ok(logs[3][1].startsWith('Error: oops\n    at '), logs[3][1]);
  assert.deepStrictEqual(logs.slice(4, 10), [['log', 'G'], ['log', '  inside'], ['log', 'outside'], ['log', 'default: 1'], ['log', 'default: 2'], ['log', 'x: 1']]);
  assert.deepStrictEqual(logs[10], ['error', 'Assertion failed: assert msg']);
  assert.deepStrictEqual(logs[11], ['debug', '<div>']);
  assert.deepStrictEqual(logs[12], ['log', "{name: 'c', me: [Circular *]}"]);
  assert.ok(logs[13][1].includes('│ (index) │ a │ b │'), logs[13][1]);
  assert.deepStrictEqual(logs[14], ['log', '{x: 1}']);
  assert.strictEqual(e.run(`[navigator.language, navigator.languages.join(), navigator.platform, navigator.vendor, navigator.onLine, navigator.cookieEnabled, navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints, navigator.webdriver, navigator.mediaDevices, navigator.serviceWorker, navigator.plugins.length, navigator.mimeTypes[0].type, navigator.userAgentData.brands.length, navigator.appVersion.startsWith('5.0'), typeof navigator.clipboard.writeText].join('|')`),
    'de-DE|de-DE,de,en-US,en|Win32|Google Inc.|true|true|8|8|0|false|||5|application/pdf|3|true|function');
  const r2 = await settle(e, `
    const p = await navigator.permissions.query({ name: 'geolocation' });
    const hi = await navigator.userAgentData.getHighEntropyValues(['platformVersion']);
    await navigator.clipboard.writeText('x');
    const lockRes = await navigator.locks.request('L', async (lock) => lock.name + ':' + lock.mode);
    return [p.state, hi.platform, hi.platformVersion, navigator.sendBeacon('/beacon', 'data'), lockRes].join('|');
  `);
  assert.strictEqual(r2, 'prompt|Windows|15.0.0|true|L:exclusive');
  assert.ok(e.requests.some((q) => q.url === 'https://example.com/beacon' && q.method === 'POST'));
  assert.strictEqual(e.run("[window === self, self === top, top === parent, frames === window, globalThis === window, window.opener, window.closed, window.length, isSecureContext, origin, typeof visualViewport.width, screen.colorDepth, screen.availWidth, screen.orientation.type].join('|')"),
    'true|true|true|true|true||false|0|true|https://example.com|number|24|1920|landscape-primary');
  assert.strictEqual(e.run("[window.open('/x', '_blank'), confirm('q'), prompt('p'), alert('a')].join('|')"), '|false||');
  assert.deepStrictEqual(e.mock.opened, [{ url: 'https://example.com/x', target: '_blank', features: '' }]);
  e.run("window.open('/self', '_self')");
  assert.strictEqual(e.mock.navigations.pop().url, 'https://example.com/self');
  e.run("var named = document.createElement('div'); named.id = 'namedThing'; document.body.appendChild(named)");
  assert.strictEqual(e.run("window.namedThing === named && namedThing === named && 'namedThing' in window && typeof notDefinedAnywhere"), 'undefined');
  assert.strictEqual(e.run("Object.getOwnPropertyDescriptor(window, 'document').configurable + ':' + typeof Object.getOwnPropertyDescriptor(window, 'innerWidth').get"), 'false:function');
  e.run("window.innerWidth = 5");
  assert.strictEqual(e.run('innerWidth'), 5, '[Replaceable]');
  assert.strictEqual(e.run("String(fetch) + '|' + String(Object.getOwnPropertyDescriptor(Node.prototype, 'firstChild').get) + '|' + Function.prototype.toString.call(function mine() { return 1; })"), 'function fetch() { [native code] }|function get firstChild() { [native code] }|function mine() { return 1; }');
});

test('WebSocket: handshake, messages, bufferedAmount, close and failures', async () => {
  const e = await env();
  const err = (code) => e.run(`try { ${code}; 'no error' } catch (x) { x.name + ': ' + x.message }`);
  e.run(`window.log = []; window.ws = new WebSocket('/chat', ['a', 'b']); ws.binaryType = 'arraybuffer';
    for (const t of ['open', 'message', 'error', 'close']) ws.addEventListener(t, (ev) => log.push(t + ':' +
      (t === 'message' ? (typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data).join(',')) + '@' + ev.origin
        : t === 'close' ? ev.code + '/' + ev.reason + '/' + ev.wasClean + '/' + (ev instanceof CloseEvent) : '')));`);
  assert.deepStrictEqual(e.mock.ws[0], ['open', 1, 'wss://example.com/chat', ['a', 'b'], 'https://example.com']);
  assert.strictEqual(e.run('ws.readyState + " " + ws.url + " " + WebSocket.OPEN'), '0 wss://example.com/chat 1');
  assert.match(err("ws.send('x')"), /^InvalidStateError: .*CONNECTING/);
  e.hook('onWebSocket', 1, 'open', 'a', '');
  assert.strictEqual(e.run('ws.readyState + ws.protocol'), '1a');
  e.run("ws.send('h\u00e9llo'); ws.send(new Uint8Array([1, 2])); ws.send(new Blob(['xyz']))");
  assert.strictEqual(e.run('ws.bufferedAmount'), 11);
  e.hook('onWebSocket', 1, 'sent', 6);
  assert.strictEqual(e.run('ws.bufferedAmount'), 5);
  e.hook('onWebSocket', 1, 'message', 'hi');
  e.hook('onWebSocket', 1, 'message', e.mock.ab(Buffer.from([7, 8])));
  assert.match(err('ws.close(1001)'), /^InvalidAccessError/);
  assert.match(err("ws.close(1000, 'x'.repeat(124))"), /^SyntaxError/);
  e.run("ws.close(1000, 'bye')");
  assert.strictEqual(e.run('ws.readyState'), 2);
  e.run("ws.send('late')");
  e.hook('onWebSocket', 1, 'close', 1000, 'bye', true);
  assert.strictEqual(e.run('ws.readyState'), 3);
  assert.deepStrictEqual(Array.from(e.run('log')), ['open:', 'message:hi@wss://example.com', 'message:7,8@wss://example.com', 'close:1000/bye/true/true']);
  assert.deepStrictEqual(e.mock.ws.slice(1), [['send', 1, 'h\u00e9llo'], ['send', 1, [1, 2]], ['send', 1, [120, 121, 122]], ['close', 1, 1000, 'bye']]);

  assert.match(err("new WebSocket('ftp://x/')"), /^SyntaxError: .*scheme/);
  assert.match(err("new WebSocket('wss://x/#f')"), /^SyntaxError: .*fragment/);
  assert.match(err("new WebSocket('wss://x/', ['a', 'a'])"), /^SyntaxError: .*duplicated/);
  assert.match(err("new WebSocket('wss://x/', 'a b')"), /^SyntaxError: .*invalid/);
  assert.match(err("new WebSocket('ws://insecure.example/')"), /^SecurityError/);

  // A failed connection fires error, then close (1006, not clean); blob is the default binaryType.
  e.run(`window.log2 = []; window.ws2 = new WebSocket('https://down.example/');
    ws2.onerror = () => log2.push('error'); ws2.onclose = (ev) => log2.push('close:' + ev.code + ':' + ev.wasClean);`);
  assert.strictEqual(e.run('ws2.url + " " + ws2.binaryType'), 'wss://down.example/ blob');
  e.hook('onWebSocket', 2, 'error', 'refused');
  e.hook('onWebSocket', 2, 'close', 1006, '', false);
  assert.deepStrictEqual(Array.from(e.run('log2')), ['error', 'close:1006:false']);
});
