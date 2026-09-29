'use strict';
// Windows of other frames as the page sees them when their realm isn't reachable (cross-origin,
// or not loaded yet): the WindowProxy stand-in and its Location follow the HTML "cross-origin
// objects" rules (CrossOriginProperties, per-window function objects that act on their `this`).
const assert = require('assert');
const { createEnv } = require('../harness');

const PAGE = '<!DOCTYPE html><html><body><iframe id="f" src="https://other.example/x.html"></iframe><iframe id="g"></iframe></body></html>';
const THROWS = "var thrown = (f) => { try { f(); return 'ok'; } catch (x) { return x.name + (x.name === 'TypeError' ? ':' + x.message : ''); } };";

test('cross-origin window: postMessage/focus/blur/close are own functions that work detached or with another this', async () => {
  const e = await createEnv({ html: PAGE });
  e.run(THROWS + "var cw = f.contentWindow; var got = []; addEventListener('message', (ev) => got.push([ev.data, ev.origin, ev.source === window]));");
  // the pattern of login bridges: `const post = parent.postMessage; post(msg, '*')`; a null/undefined this is
  // the realm's own window (WebIDL [Global]), so the message goes to the caller, not to the target
  assert.strictEqual(e.run("var post = cw.postMessage; thrown(() => post('detached', '*'))"), 'ok');
  assert.strictEqual(e.run("thrown(() => post.call(undefined, 'undef', '*')) + thrown(() => post.call(null, 'null', '*')) + thrown(() => post.call(window, 'self', '*'))"), 'okokok');
  assert.strictEqual(e.mock.framePosts.length, 0, 'nothing was sent to the frame');
  await e.flush();
  assert.deepStrictEqual(JSON.parse(e.run('JSON.stringify(got)')), [
    ['detached', 'https://example.com', true], ['undef', 'https://example.com', true],
    ['null', 'https://example.com', true], ['self', 'https://example.com', true]]);
  // called as a method, or with the cross-origin window itself as this: the frame's window
  e.run("cw.postMessage('method', '*'); post.call(cw, 'via call', 'https://other.example');");
  const fid = e.id('#f');
  assert.deepStrictEqual(e.mock.framePosts.map((p) => [p.path, p.message, p.targetOrigin]),
    [[[fid], 'method', '*'], [[fid], 'via call', 'https://other.example']]);
  // any other this is a brand check failure
  assert.strictEqual(e.run("thrown(() => post.call({}, 'x', '*')) + '|' + thrown(() => post.call(1, 'x', '*')) + '|' + thrown(() => post.call(document, 'x', '*'))"),
    'TypeError:Illegal invocation|TypeError:Illegal invocation|TypeError:Illegal invocation');
  // arguments are still checked
  assert.strictEqual(e.run("thrown(() => cw.postMessage())"), "TypeError:Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
  assert.strictEqual(e.run("thrown(() => cw.postMessage('x', 'not a url'))"), 'SyntaxError');
  // focus, blur and close do nothing, also detached; the same brand check
  assert.strictEqual(e.run("var { focus, blur, close } = cw; [focus(), blur(), close(), cw.focus(), cw.blur(), cw.close(), focus.call(window), close.call(null)].every((v) => v === undefined)"), true);
  assert.strictEqual(e.run("thrown(() => focus.call({})) + '|' + thrown(() => blur.call('x')) + '|' + thrown(() => close.call(f))"),
    'TypeError:Illegal invocation|TypeError:Illegal invocation|TypeError:Illegal invocation');
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin window in a frame: the disney bridge pattern with a cross-origin parent', async () => {
  const e = await createEnv({ framePath: [77], url: 'https://login.example/bridge' });
  e.run(THROWS + "var got = []; addEventListener('message', (ev) => got.push(ev.data.type + ':' + (ev.source === window)));");
  assert.strictEqual(e.run("let i = window.parent.postMessage; i({ type: 'getData' }, '*'), i({ type: 'guest' }, '*'); thrown(() => i.call(window.top, { type: 'top' }, '*'))"), 'ok');
  await e.flush();
  assert.strictEqual(e.run("got.join()"), 'getData:true,guest:true');
  assert.deepStrictEqual(e.mock.framePosts.map((p) => [p.path, p.message.type, p.targetOrigin]), [[[], 'top', '*']], 'this = top posts to the page');
  e.run("window.parent.postMessage({ type: 'plain' }, '*')");
  assert.deepStrictEqual(e.mock.framePosts.map((p) => [p.path, p.message.type]), [[[], 'top'], [[], 'plain']]);
  // parent, top and the page are one window here (the page is the frame's parent)
  assert.strictEqual(e.run("[parent === top, parent.parent === parent, parent.top === parent, parent.self === parent, parent.window === parent, parent.frames === parent, parent !== window, window.frames === window].every(Boolean)"), true);
  assert.strictEqual(e.run("[parent.opener, parent.closed].join()"), ',false');
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin window: function identity, name, length, native toString', async () => {
  const e = await createEnv({ html: PAGE });
  e.run("var cw = f.contentWindow");
  assert.strictEqual(e.run("cw.postMessage === cw.postMessage && cw.focus === cw.focus && cw.close === cw.close"), true);
  assert.strictEqual(e.run("cw.postMessage !== window.postMessage && cw.focus !== cw.blur"), true);
  assert.strictEqual(e.run("[cw.postMessage, cw.focus, cw.blur, cw.close].map((m) => m.name + '/' + m.length).join()"), 'postMessage/1,focus/0,blur/0,close/0');
  assert.strictEqual(e.run("String(cw.postMessage)"), 'function postMessage() { [native code] }');
  assert.strictEqual(e.run("[typeof cw.postMessage, cw.postMessage.hasOwnProperty('prototype'), Object.getPrototypeOf(cw.postMessage) === Function.prototype].join()"), 'function,false,true');
  // each frame has its own
  assert.strictEqual(e.run("cw.postMessage !== g.contentWindow.postMessage"), true);
  const d = e.run("var d = Object.getOwnPropertyDescriptor(cw, 'postMessage'); [d.value === cw.postMessage, d.writable, d.enumerable, d.configurable].join()");
  assert.strictEqual(d, 'true,false,false,true');
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin window: CrossOriginProperties in has/ownKeys/descriptors, everything else is a SecurityError', async () => {
  const e = await createEnv({ html: PAGE });
  e.run(THROWS + "var cw = f.contentWindow");
  const names = 'window,self,location,close,closed,focus,blur,frames,length,top,opener,parent,postMessage,then';
  assert.strictEqual(e.run("Reflect.ownKeys(cw).map(String).join()"),
    names + ',Symbol(Symbol.toStringTag),Symbol(Symbol.hasInstance),Symbol(Symbol.isConcatSpreadable)');
  assert.strictEqual(e.run("Object.getOwnPropertyNames(cw).join()"), names);
  assert.strictEqual(e.run("Object.keys(cw).length + ':' + JSON.stringify(Object.getOwnPropertyNames(cw).filter((k) => k in cw).length)"), '0:14');
  // accessors and methods (all non-enumerable, configurable)
  assert.strictEqual(e.run(`['window', 'self', 'frames', 'length', 'top', 'opener', 'parent', 'closed', 'location'].map((k) => {
    const d = Object.getOwnPropertyDescriptor(cw, k);
    return k + ':' + typeof d.get + typeof d.set + d.enumerable + d.configurable + ('value' in d);
  }).join()`), [
    'window:functionundefinedfalsetruefalse', 'self:functionundefinedfalsetruefalse', 'frames:functionundefinedfalsetruefalse',
    'length:functionundefinedfalsetruefalse', 'top:functionundefinedfalsetruefalse', 'opener:functionundefinedfalsetruefalse',
    'parent:functionundefinedfalsetruefalse', 'closed:functionundefinedfalsetruefalse', 'location:functionfunctionfalsetruefalse'].join());
  assert.strictEqual(e.run("['close', 'focus', 'blur', 'postMessage'].map((k) => { const d = Object.getOwnPropertyDescriptor(cw, k); return k + ':' + typeof d.value + d.writable + d.enumerable + d.configurable; }).join()"),
    'close:functionfalsefalsetrue,focus:functionfalsefalsetrue,blur:functionfalsefalsetrue,postMessage:functionfalsefalsetrue');
  assert.strictEqual(e.run("['get window', 'get location', 'set location'].join() === [Object.getOwnPropertyDescriptor(cw, 'window').get.name, Object.getOwnPropertyDescriptor(cw, 'location').get.name, Object.getOwnPropertyDescriptor(cw, 'location').set.name].join()"), true);
  // the fallback: undefined for then and the well-known symbols, present in has/ownKeys
  assert.strictEqual(e.run("[cw.then, cw[Symbol.toStringTag], cw[Symbol.hasInstance], cw[Symbol.isConcatSpreadable], 'then' in cw, Symbol.toStringTag in cw].join()"), ',,,,true,true');
  assert.strictEqual(e.run("JSON.stringify(Object.getOwnPropertyDescriptor(cw, 'then')) + JSON.stringify(Object.getOwnPropertyDescriptor(cw, Symbol.toStringTag))"), '{"writable":false,"enumerable":false,"configurable":true}'.repeat(2));
  // anything else
  assert.strictEqual(e.run("['foo', 'document', 'addEventListener', 'hasOwnProperty', '1', 'toJSON'].map((k) => thrown(() => cw[k])).join()"), 'SecurityError,SecurityError,SecurityError,SecurityError,SecurityError,SecurityError');
  assert.strictEqual(e.run("thrown(() => cw[Symbol.iterator]) + thrown(() => Object.getOwnPropertyDescriptor(cw, 'foo')) + thrown(() => 'foo' in cw) + thrown(() => Object.hasOwn(cw, 'foo'))"), 'SecurityErrorSecurityErrorSecurityErrorSecurityError');
  assert.strictEqual(e.run("thrown(() => String(cw)) + thrown(() => cw + '') + thrown(() => JSON.stringify(cw))"), 'SecurityErrorSecurityErrorSecurityError');
  assert.match(e.run("try { cw.foo } catch (x) { x.message }"), /^Failed to read a named property 'foo' from 'Window': Blocked a frame with origin "https:\/\/example\.com" from accessing a cross-origin frame\.$/);
  assert.strictEqual(e.run("[thrown(() => { cw.foo = 1; }), thrown(() => { cw.postMessage = 1; }), thrown(() => { cw.closed = 1; }), thrown(() => delete cw.foo), thrown(() => delete cw.postMessage), thrown(() => Object.defineProperty(cw, 'x', { value: 1 })), thrown(() => Object.defineProperty(cw, 'postMessage', { value: 1 }))].join()"),
    'SecurityError,SecurityError,SecurityError,SecurityError,SecurityError,SecurityError,SecurityError');
  // exotic object essentials: null prototype (immutable), extensible but can't be prevented
  assert.strictEqual(e.run("[Object.getPrototypeOf(cw), Object.isExtensible(cw), Reflect.setPrototypeOf(cw, null), Reflect.setPrototypeOf(cw, {}), Reflect.preventExtensions(cw), cw instanceof Object, cw instanceof Window, typeof cw, Object.prototype.toString.call(cw)].join()"),
    ',true,true,false,false,false,false,object,[object Object]');
  assert.match(e.run("thrown(() => Object.preventExtensions(cw))"), /^TypeError:/);
  assert.match(e.run("thrown(() => Object.setPrototypeOf(cw, {}))"), /^TypeError:/);
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin window: accessors act on their this (null/undefined: this window)', async () => {
  const e = await createEnv({ html: PAGE });
  e.run(THROWS + "var cw = f.contentWindow; var desc = (k) => Object.getOwnPropertyDescriptor(cw, k);");
  assert.strictEqual(e.run("[cw.self === cw, cw.window === cw, cw.frames === cw, cw.parent === window, cw.top === window, cw.opener, cw.closed, cw.length].join()"), 'true,true,true,true,true,,false,0');
  // read through the getter with another receiver: window itself, undefined/null (also this window), a stranger
  assert.strictEqual(e.run("[desc('window').get.call(window) === window, desc('window').get.call(undefined) === window, desc('self').get.call(null) === window, desc('closed').get.call(undefined), desc('length').get.call(window)].join()"), 'true,true,true,false,2');
  assert.strictEqual(e.run("thrown(() => desc('closed').get.call({})) + '|' + thrown(() => desc('length').get.call(f)) + '|' + thrown(() => desc('window').get.call(3))"),
    'TypeError:Illegal invocation|TypeError:Illegal invocation|TypeError:Illegal invocation');
  assert.strictEqual(e.run("thrown(() => Reflect.get(cw, 'closed', {})) + '|' + (Reflect.get(cw, 'window', cw) === cw)"), 'TypeError:Illegal invocation|true');
  // the page itself is the parent of a top-level page's frame; its own frames count is the live one
  assert.strictEqual(e.run("desc('parent').get.call(undefined) === parent && desc('top').get.call(undefined) === top"), true);
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin window: child frames are its indexed and named properties', async () => {
  const e = await createEnv({ html: PAGE });
  const fid = e.id('#f');
  e.mock.opts.frameLists = { [fid]: [[201, 'inner'], [202, '']] };
  e.run(THROWS + "var cw = f.contentWindow");
  assert.strictEqual(e.run("cw.length"), 2);
  assert.strictEqual(e.run("Object.keys(cw).join() + '|' + Object.getOwnPropertyNames(cw).slice(0, 4).join()"), '0,1|0,1,window,self');
  assert.strictEqual(e.run("[cw[0] === cw.inner, cw[0] === cw.frames[0], cw[0] !== cw[1], cw[0].parent === cw, cw[0].top === window, cw[1].self === cw[1]].join()"), 'true,true,true,true,true,true');
  assert.strictEqual(e.run("[0 in cw, 1 in cw, 'inner' in cw, thrown(() => 2 in cw), thrown(() => cw[2]), thrown(() => cw['nosuch'])].join()"), 'true,true,true,SecurityError,SecurityError,SecurityError');
  assert.strictEqual(e.run("var di = Object.getOwnPropertyDescriptor(cw, 0), dn = Object.getOwnPropertyDescriptor(cw, 'inner'); [di.enumerable, di.writable, di.configurable, dn.enumerable, dn.writable, dn.configurable, di.value === cw[0]].join()"), 'true,false,true,false,false,true,true');
  assert.strictEqual(e.run("thrown(() => { cw[0] = 1; }) + thrown(() => { cw.inner = 1; })"), 'SecurityErrorSecurityError');
  // the child's own children are unknown (no list)
  assert.strictEqual(e.run("cw[0].length"), 0);
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin location: href is write-only, replace is a method, the rest is a SecurityError', async () => {
  const e = await createEnv({ html: PAGE });
  const fid = e.id('#f');
  e.run(THROWS + "var cw = f.contentWindow; var loc = cw.location;");
  assert.strictEqual(e.run("[typeof loc, loc === cw.location, loc !== location, Object.getPrototypeOf(loc), loc instanceof Location, Object.prototype.toString.call(loc)].join()"), 'object,true,true,,false,[object Object]');
  assert.strictEqual(e.run("Reflect.ownKeys(loc).map(String).join()"), 'href,replace,then,Symbol(Symbol.toStringTag),Symbol(Symbol.hasInstance),Symbol(Symbol.isConcatSpreadable)');
  assert.strictEqual(e.run("var dh = Object.getOwnPropertyDescriptor(loc, 'href'), dr = Object.getOwnPropertyDescriptor(loc, 'replace'); [typeof dh.get, typeof dh.set, dh.enumerable, dh.configurable, typeof dr.value, dr.writable, dr.enumerable, dr.configurable].join()"),
    'undefined,function,false,true,function,false,false,true');
  assert.strictEqual(e.run("[loc.replace === loc.replace, loc.replace.name + '/' + loc.replace.length, dh.set.name, loc.then].join()"), 'true,replace/1,set href,');
  // reading anything: SecurityError, including href (it has a setter only)
  assert.strictEqual(e.run("['href', 'hash', 'hostname', 'origin', 'assign', 'reload', 'toString', 'ancestorOrigins'].map((k) => thrown(() => loc[k])).join()"), Array(8).fill('SecurityError').join());
  assert.match(e.run("try { loc.href } catch (x) { x.message }"), /^Failed to read a named property 'href' from 'Location': Blocked a frame with origin/);
  assert.strictEqual(e.run("thrown(() => String(loc)) + thrown(() => 'hash' in loc) + thrown(() => { loc.hash = '#x'; }) + thrown(() => delete loc.href)"), 'SecurityErrorSecurityErrorSecurityErrorSecurityError');
  // navigating: `location = url`, `location.href = url` and replace() go to the host (N.frameNavigate)
  e.run("cw.location = 'https://elsewhere.example/a'; loc.href = '/rel'; loc.replace('https://elsewhere.example/b'); cw.location.href = 'javascript:void 0';");
  assert.deepStrictEqual(e.mock.frameNavigations, [
    { path: [fid], url: 'https://elsewhere.example/a', replace: false },
    { path: [fid], url: 'https://example.com/rel', replace: false },
    { path: [fid], url: 'https://elsewhere.example/b', replace: true }], 'javascript: URLs never run in another origin, relative URLs resolve against the caller');
  // brand checks and arguments
  assert.strictEqual(e.run("var rep = loc.replace; thrown(() => rep('https://a.example/')) + '|' + thrown(() => rep.call(location, 'about:blank#x')) + '|' + thrown(() => rep.call(cw, 'x')) + '|' + thrown(() => loc.replace())"),
    "TypeError:Illegal invocation|ok|TypeError:Illegal invocation|TypeError:Failed to execute 'replace' on 'Location': 1 argument required, but only 0 present.");
  assert.strictEqual(e.run("thrown(() => { loc.href = 'http://'; })"), 'SyntaxError');
  assert.strictEqual(e.run("thrown(() => { Object.getOwnPropertyDescriptor(loc, 'href').set.call({}, 'x'); })"), 'TypeError:Illegal invocation');
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin location: without N.frameNavigate the setters do nothing', async () => {
  const e = await createEnv({ html: PAGE, disable: ['frameNavigate'] });
  e.run(THROWS + "var cw = f.contentWindow;");
  assert.strictEqual(e.run("thrown(() => { cw.location = 'https://x.example/'; cw.location.href = 'https://x.example/'; cw.location.replace('https://x.example/'); })"), 'ok');
  assert.deepStrictEqual(e.mock.frameNavigations, []);
  assert.deepStrictEqual(e.errors(), []);
});

test('cross-origin window in a frame: parent/top locations navigate the frame at their path', async () => {
  const e = await createEnv({ framePath: [40, 41], url: 'https://ads.example/frame' });
  e.run(THROWS);
  // window.top.location = url is how frames break out of their embedder
  e.run("top.location = 'https://shop.example/landing'; parent.location.replace('https://shop.example/x'); location.href = '#local';");
  assert.deepStrictEqual(e.mock.frameNavigations, [
    { path: [], url: 'https://shop.example/landing', replace: false },
    { path: [40], url: 'https://shop.example/x', replace: true }]);
  assert.strictEqual(e.run("[parent === top, parent.parent === top, top.top === top, top.location === top.location, parent.location !== top.location].join()"), 'false,true,true,true,true');
  assert.strictEqual(e.run("[parent.parent === top, thrown(() => top.location.href), thrown(() => parent.document), thrown(() => top.document)].join()"), 'true,SecurityError,SecurityError,SecurityError');
  // the own window keeps its own behaviour when reached through the cross-origin functions
  assert.strictEqual(e.run("Object.getOwnPropertyDescriptor(top, 'location').set.call(undefined, '#viaself'); location.hash"), '#viaself');
  assert.strictEqual(e.run("[Object.getOwnPropertyDescriptor(top, 'parent').get.call(undefined) === parent, Object.getOwnPropertyDescriptor(top, 'top').get.call(null) === top].join()"), 'true,true');
  assert.deepStrictEqual(e.errors(), []);
});

test('a message from a frame: source is its window (stand-in), replies work detached too', async () => {
  const e = await createEnv({ html: PAGE });
  const fid = e.id('#f');
  e.run(THROWS + "var got = []; addEventListener('message', (ev) => { got.push(ev.data + ':' + (ev.source === f.contentWindow)); if (ev.data !== 'ping') return; ev.source.postMessage('pong', ev.origin); const rep = ev.source.postMessage; rep('ping-2'); });");
  e.hook('onMessage', e.mock.arr([fid]), 'https://other.example', 'ping');
  await e.flush();
  assert.strictEqual(e.run("got.join()"), 'ping:true,ping-2:false', 'the detached reply comes back to this window, not to the frame');
  assert.deepStrictEqual(e.mock.framePosts.map((p) => [p.path, p.message, p.targetOrigin]), [[[fid], 'pong', 'https://other.example']]);
  assert.deepStrictEqual(e.errors(), []);
});

test('console.log of cross-origin windows and locations does not touch their properties', async () => {
  const e = await createEnv({ html: PAGE });
  e.run("var cw = f.contentWindow; console.log(cw); console.log('w', cw, cw.location); console.log({ w: cw });");
  const lines = e.logs.filter((l) => l[0] === 'log').map((l) => l[1]);
  assert.deepStrictEqual(lines, ['Window', 'w Window Location', '{w: Window}']);
  assert.deepStrictEqual(e.errors(), []);
});

test('stand-in of a same-origin frame without a window yet stays lenient', async () => {
  const e = await createEnv({ html: PAGE });
  e.run(THROWS + "var gw = g.contentWindow; var got = []; gw.addEventListener('message', (ev) => got.push(ev.data));");
  assert.strictEqual(e.run("[gw.document, gw.nosuch, 'document' in gw, 'postMessage' in gw, Object.prototype.toString.call(gw), typeof gw.location, gw.location.href, String(gw.location), gw.self === gw, gw.parent === window, gw.top === window].join()"),
    ',,true,true,[object Window],object,,,true,true,true');
  assert.strictEqual(e.run("gw.expando = 5; [gw.expando, Object.keys(gw).includes('expando'), delete gw.expando, gw.expando, thrown(() => { gw.foo = 1; })].join()"), '5,true,true,,ok');
  assert.strictEqual(e.run("thrown(() => gw.removeEventListener('message', () => { })) + thrown(() => gw.dispatchEvent(new Event('x')))"), 'okok');
  // same function objects as for cross-origin windows, so the detached call works here too
  assert.strictEqual(e.run("var gpost = gw.postMessage; gpost('me', '*'); gw.postMessage('there', '*'); 1"), 1);
  await e.flush();
  assert.deepStrictEqual(e.mock.framePosts.map((p) => [p.path, p.message]), [[[e.id('#g')], 'there']]);
  assert.strictEqual(e.run("Object.getOwnPropertyDescriptor(gw, 'nosuch') === undefined && !('nosuch' in gw)"), true);
  assert.deepStrictEqual(e.errors(), []);
});
