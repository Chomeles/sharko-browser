'use strict';
// The parts of the environment that pages and bot-management scripts probe to see whether the
// User-Agent (Chrome on Windows) is telling the truth. Expected values were measured in
// Chromium (see repro-chrome-consistency.html); features the engine does not have stay absent.
const assert = require('assert');
const { createEnv, frameGroup } = require('../harness');

// Run an async page expression and return its value.
async function settle(e, code) {
  const p = e.run(`(async () => { ${code} })()`);
  await e.flush(5000);
  return p;
}

test('window.chrome: loadTimes(), csi() and app like a Chrome page without extension access', async () => {
  const e = await createEnv();
  assert.strictEqual(e.run('typeof chrome + Object.keys(chrome) + Object.keys(chrome.app)'),
    'objectloadTimes,csi,appisInstalled,getDetails,getIsInstalled,installState,runningState,InstallState,RunningState');
  assert.strictEqual(e.run("JSON.stringify(Object.getOwnPropertyDescriptor(window, 'chrome'), (k, v) => (k === 'value' ? typeof v : v))"),
    '{"value":"object","writable":true,"enumerable":true,"configurable":false}');
  assert.strictEqual(e.run('delete window.chrome'), false);
  assert.strictEqual(e.run('Object.getPrototypeOf(chrome) === Object.prototype && chrome.runtime === undefined'), true);
  // native-looking functions: loadTimes and csi are anonymous constructors, the app members methods
  assert.deepStrictEqual(Array.from(e.run('[chrome.loadTimes, chrome.csi].map(String)')), ['function () { [native code] }', 'function () { [native code] }']);
  assert.deepStrictEqual(Array.from(e.run('[chrome.loadTimes, chrome.csi].map((f) => Object.getOwnPropertyNames(f).join("/") + f.length + JSON.stringify(f.name))')), ['length/name/prototype0""', 'length/name/prototype0""']);
  const app = e.run(`['getDetails', 'getIsInstalled', 'installState', 'runningState'].map((k) => String(chrome.app[k]) + Object.getOwnPropertyNames(chrome.app[k]).join('/') + chrome.app[k].length).join('|')`);
  assert.strictEqual(app, 'function getDetails() { [native code] }length/name0|function getIsInstalled() { [native code] }length/name0|function installState() { [native code] }length/name0|function runningState() { [native code] }length/name0');
  assert.strictEqual(e.run("try { new chrome.app.getDetails(); 'ok' } catch (err) { err instanceof TypeError }"), true);
  assert.strictEqual(e.run('JSON.stringify([chrome.app.isInstalled, chrome.app.getDetails(), chrome.app.getIsInstalled(), chrome.app.runningState(), chrome.app.InstallState, chrome.app.RunningState])'),
    '[false,null,false,"cannot_run",{"DISABLED":"disabled","INSTALLED":"installed","NOT_INSTALLED":"not_installed"},{"CANNOT_RUN":"cannot_run","READY_TO_RUN":"ready_to_run","RUNNING":"running"}]');
  assert.strictEqual(e.run("var st = 'unset'; chrome.app.installState((s) => { st = s; }); st"), 'unset');
  await e.flush();
  assert.strictEqual(e.run('st'), 'not_installed');
  // shape and times (seconds since the epoch, agreeing with performance.timing)
  assert.strictEqual(e.run('Object.keys(chrome.loadTimes()).join()'),
    'requestTime,startLoadTime,commitLoadTime,finishDocumentLoadTime,finishLoadTime,firstPaintTime,firstPaintAfterLoadTime,navigationType,wasFetchedViaSpdy,wasNpnNegotiated,npnNegotiatedProtocol,wasAlternateProtocolAvailable,connectionInfo');
  assert.strictEqual(e.run('Object.keys(chrome.csi()).join()'), 'startE,onloadT,pageT,tran');
  assert.strictEqual(e.run('chrome.loadTimes().requestTime === performance.timing.navigationStart / 1000'), true);
  assert.strictEqual(e.run('chrome.loadTimes().finishLoadTime === performance.timing.loadEventEnd / 1000 && chrome.loadTimes().finishDocumentLoadTime === performance.timing.domContentLoadedEventEnd / 1000 && chrome.loadTimes().commitLoadTime === performance.timing.responseStart / 1000'), true);
  assert.strictEqual(e.run('chrome.csi().startE === performance.timing.navigationStart && chrome.csi().onloadT === performance.timing.loadEventEnd && chrome.csi().tran === 15'), true);
  assert.strictEqual(e.run("chrome.loadTimes.call(null).navigationType"), 'Other');
});

test('Notification: permission is default (denied in an insecure context), requestPermission resolves denied', async () => {
  const e = await createEnv();
  assert.strictEqual(e.run('Notification.permission'), 'default');
  assert.strictEqual(await settle(e, `
    const r = Notification.requestPermission();
    let cb = null;
    const r2 = await Notification.requestPermission((p) => { cb = p; });
    let bad;
    try { await Notification.requestPermission(5); bad = 'resolved'; } catch (err) { bad = err.name + ': ' + err.message; }
    return [r instanceof Promise, await r, r2, cb, Notification.permission, bad].join('|');`),
  "true|denied|denied|denied|default|TypeError: Failed to execute 'requestPermission' on 'Notification': parameter 1 is not of type 'Function'.");
  assert.strictEqual(e.run("[Notification.length, Notification.requestPermission.length, Object.getOwnPropertyNames(Notification).join(), Notification.maxActions].join('|')"),
    '1|0|length,name,prototype,permission,maxActions,requestPermission|2');
  assert.strictEqual(e.run("JSON.stringify(Object.getOwnPropertyDescriptor(Notification, 'permission'), (k, v) => (typeof v === 'function' ? v.name : v))"), '{"get":"get permission","enumerable":true,"configurable":true}');
  assert.strictEqual(e.run('Object.getOwnPropertyNames(Notification.prototype).join()'),
    'onclick,onshow,onerror,onclose,title,dir,lang,body,tag,icon,badge,vibrate,timestamp,renotify,silent,requireInteraction,data,actions,close,image,constructor');
  // it never shows anything: the error event is what a page without permission gets
  assert.strictEqual(await settle(e, "return await new Promise((res) => { const n = new Notification('hi'); n.onerror = () => res('error:' + n.title); })"), 'error:hi');
  const http = await createEnv({ url: 'http://insecure.example/' });
  assert.strictEqual(http.run('Notification.permission'), 'denied');
  assert.strictEqual(await settle(http, "return (await Notification.requestPermission()) + '|' + Notification.permission + '|' + (await navigator.permissions.query({ name: 'notifications' })).state"), 'denied|denied|denied');
});

test('navigator: Blink property order, native getters, no Firefox-only members', async () => {
  const e = await createEnv();
  // the members Chrome has (in its order), minus the ones this engine does not implement
  assert.strictEqual(e.run('Object.getOwnPropertyNames(Navigator.prototype).join()'),
    'vendorSub,productSub,vendor,maxTouchPoints,scheduling,userActivation,geolocation,doNotTrack,connection,plugins,mimeTypes,pdfViewerEnabled,' +
    'webkitTemporaryStorage,webkitPersistentStorage,hardwareConcurrency,cookieEnabled,appCodeName,appName,appVersion,platform,product,userAgent,' +
    'language,languages,onLine,webdriver,getGamepads,javaEnabled,sendBeacon,vibrate,constructor,clipboard,mediaDevices,storage,deviceMemory,' +
    'userAgentData,locks,permissions,getBattery,getUserMedia,webkitGetUserMedia,registerProtocolHandler,unregisterProtocolHandler');
  assert.strictEqual(e.run("'oscpu' in navigator"), false);
  assert.strictEqual(e.run("Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'vendor').get)"), 'function get vendor() { [native code] }');
  assert.strictEqual(e.run("Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userActivation').get) + Function.prototype.toString.call(navigator.sendBeacon)"),
    'function get userActivation() { [native code] }function sendBeacon() { [native code] }');
  assert.strictEqual(e.run("['vendor', 'userAgent', 'languages', 'sendBeacon', 'userActivation', 'mediaDevices'].map((k) => { const d = Object.getOwnPropertyDescriptor(Navigator.prototype, k); return [!!d.get, !!d.value, d.enumerable, d.configurable].join(''); }).join()"),
    'truefalsetruetrue,truefalsetruetrue,truefalsetruetrue,falsetruetruetrue,truefalsetruetrue,truefalsetruetrue');
  assert.strictEqual(e.run('[navigator.languages === navigator.languages, Object.isFrozen(navigator.languages), Object.keys(navigator).length].join()'), 'true,true,0');
  // other interfaces list `constructor` last, as Blink does (Navigator has its own order above)
  assert.strictEqual(e.run("['EventTarget', 'Node', 'Element', 'Event', 'History', 'Storage', 'URL', 'Headers', 'Blob', 'Notification', 'NetworkInformation', 'UserActivation', 'PermissionStatus'].filter((n) => { const k = Object.getOwnPropertyNames(window[n].prototype); return k[k.length - 1] !== 'constructor'; }).join()"), '');
  // static members are enumerable, like in WebIDL (Object.keys(URL) lists them)
  assert.strictEqual(e.run("Object.keys(Notification).join() + '|' + Object.keys(URL).join()"), 'permission,maxActions,requestPermission|canParse,parse,createObjectURL,revokeObjectURL');
  assert.strictEqual(e.run("Object.getOwnPropertyNames(NetworkInformation.prototype).join()"), 'onchange,effectiveType,rtt,downlink,saveData,constructor');
  assert.strictEqual(e.run("[navigator.connection.effectiveType, navigator.connection.saveData, typeof navigator.connection.rtt, typeof navigator.connection.downlink, navigator.connection === navigator.connection].join()"), '4g,false,number,number,true');
  assert.strictEqual(e.run("Object.getOwnPropertyNames(UserActivation.prototype).join() + [navigator.userActivation.hasBeenActive, navigator.userActivation.isActive]"), 'hasBeenActive,isActive,constructorfalse,false');
});

test('navigator.userActivation follows trusted clicks', async () => {
  const e = await createEnv({ html: '<button id="b">x</button>' });
  assert.strictEqual(e.run('[navigator.userActivation.hasBeenActive, navigator.userActivation.isActive].join()'), 'false,false');
  e.click('#b');
  assert.strictEqual(e.run('[navigator.userActivation.hasBeenActive, navigator.userActivation.isActive].join()'), 'true,true');
  // transient activation expires after a few seconds (the layer reads the wall clock)
  e.run('var realNow = Date.now; Date.now = () => realNow.call(Date) + 6000');
  assert.strictEqual(e.run('[navigator.userActivation.hasBeenActive, navigator.userActivation.isActive].join()'), 'true,false');
});

test('navigator.mediaDevices: no devices, capture requests fail like on a machine without camera', async () => {
  const e = await createEnv();
  assert.strictEqual(e.run("[Object.prototype.toString.call(navigator.mediaDevices), navigator.mediaDevices === navigator.mediaDevices, navigator.mediaDevices instanceof EventTarget, navigator.mediaDevices instanceof MediaDevices, navigator.mediaDevices.ondevicechange].join()"),
    '[object MediaDevices],true,true,true,');
  assert.strictEqual(e.run("[...Object.getOwnPropertyNames(MediaDevices.prototype)].join()"), 'ondevicechange,enumerateDevices,getSupportedConstraints,getUserMedia,getDisplayMedia,constructor');
  assert.strictEqual(e.run("['enumerateDevices', 'getUserMedia', 'getSupportedConstraints', 'getDisplayMedia'].map((k) => navigator.mediaDevices[k].length).join()"), '0,0,0,0');
  assert.strictEqual(await settle(e, `
    const md = navigator.mediaDevices;
    const err = async (p) => { try { await p; return 'resolved'; } catch (x) { return x.name + ': ' + x.message + (x instanceof DOMException ? '|' + x.code : ''); } };
    return JSON.stringify([
      await md.enumerateDevices(),
      await err(md.getUserMedia({ video: true })),
      await err(md.getUserMedia({ audio: true, video: { facingMode: 'user' } })),
      await err(md.getUserMedia({})),
      await err(md.getUserMedia({ audio: false, video: false })),
      await err(md.getUserMedia()),
      await err(md.getDisplayMedia({ video: true })),
      Object.keys(md.getSupportedConstraints()).length,
      md.getSupportedConstraints().facingMode,
    ]);`),
  JSON.stringify([[], 'NotFoundError: Requested device not found|8', 'NotFoundError: Requested device not found|8',
    "TypeError: Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested",
    "TypeError: Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested",
    "TypeError: Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested",
    'NotAllowedError: getDisplayMedia requires transient activation from a user gesture.|0', 36, true]));
  // the old callback form
  assert.strictEqual(await settle(e, `
    const r = await new Promise((res) => navigator.getUserMedia({ video: true }, () => res('ok'), (x) => res(x.name + ':' + x.message + ':' + (x instanceof DOMException))));
    let few; try { navigator.webkitGetUserMedia({ video: true }); } catch (x) { few = x.message; }
    return [r, few, navigator.getUserMedia.length].join('|');`),
  "NotFoundError:Requested device not found:true|Failed to execute 'webkitGetUserMedia' on 'Navigator': 3 arguments required, but only 1 present.|3");
});

test('navigator.permissions.query: Chrome\'s states and argument errors', async () => {
  const e = await createEnv();
  const states = await settle(e, `
    const out = {};
    for (const n of ['accelerometer', 'background-sync', 'camera', 'clipboard-read', 'clipboard-write', 'geolocation', 'microphone', 'midi', 'notifications', 'persistent-storage', 'screen-wake-lock', 'periodic-background-sync', 'storage-access', 'pointer-lock']) {
      out[n] = (await navigator.permissions.query({ name: n })).state;
    }
    return JSON.stringify(out);`);
  assert.strictEqual(states, '{"accelerometer":"granted","background-sync":"granted","camera":"prompt","clipboard-read":"prompt","clipboard-write":"granted","geolocation":"prompt","microphone":"prompt","midi":"prompt","notifications":"prompt","persistent-storage":"prompt","screen-wake-lock":"granted","periodic-background-sync":"denied","storage-access":"granted","pointer-lock":"granted"}');
  const errs = await settle(e, `
    const err = async (f) => { try { const s = await f(); return 'state:' + s.state; } catch (x) { return x.name + ': ' + x.message; } };
    const q = (d) => () => navigator.permissions.query(d);
    return JSON.stringify([
      await err(() => navigator.permissions.query()),
      await err(q('geolocation')), await err(q(null)), await err(q({})),
      await err(q({ name: 'bluetooth' })), await err(q({ name: 'nfc' })), await err(q({ name: 'system-wake-lock' })),
      await err(q({ name: 'push' })), await err(q({ name: 'push', userVisibleOnly: true })),
      await err(q({ name: 'top-level-storage-access' })),
      await err(q({ name: 'geolocation', extra: 1 })),
    ]);`);
  const P = "Failed to execute 'query' on 'Permissions': ";
  assert.deepStrictEqual(JSON.parse(errs), [
    'TypeError: ' + P + '1 argument required, but only 0 present.',
    'TypeError: ' + P + "parameter 1 is not of type 'object'.",
    'TypeError: ' + P + "parameter 1 is not of type 'object'.",
    'TypeError: ' + P + "Failed to read the 'name' property from 'PermissionDescriptor': Required member is undefined.",
    'TypeError: ' + P + "Failed to read the 'name' property from 'PermissionDescriptor': The provided value 'bluetooth' is not a valid enum value of type PermissionName.",
    'TypeError: ' + P + 'Web NFC is not enabled.',
    'TypeError: ' + P + 'System Wake Lock is not enabled.',
    "NotSupportedError: " + P + "Push Permission without userVisibleOnly:true isn't supported yet.",
    'state:prompt',
    'TypeError: ' + P + 'The requested origin is invalid.',
    'state:prompt',
  ]);
  assert.strictEqual(await settle(e, "const a = await navigator.permissions.query({ name: 'geolocation' }); const b = await navigator.permissions.query({ name: 'geolocation' }); return [a === b, a.name, a instanceof PermissionStatus, a.onchange, Object.getOwnPropertyNames(PermissionStatus.prototype).join()].join('|')"),
    'false|geolocation|true||name,state,onchange,constructor');
});

test('insecure contexts: [SecureContext] navigator members are absent, every permission is denied', async () => {
  const e = await createEnv({ url: 'http://insecure.example/page' });
  assert.strictEqual(e.run('isSecureContext'), false);
  assert.strictEqual(e.run("['clipboard', 'mediaDevices', 'storage', 'deviceMemory', 'userAgentData', 'locks', 'getBattery', 'getUserMedia', 'webkitGetUserMedia'].filter((k) => k in navigator).join() + typeof MediaDevices"), 'undefined');
  assert.strictEqual(e.run("['permissions', 'connection', 'geolocation', 'sendBeacon', 'plugins', 'userActivation', 'getGamepads'].filter((k) => !(k in navigator)).join()"), '');
  assert.strictEqual(e.run("Object.getOwnPropertyNames(Navigator.prototype).join()"),
    'vendorSub,productSub,vendor,maxTouchPoints,scheduling,userActivation,geolocation,doNotTrack,connection,plugins,mimeTypes,pdfViewerEnabled,webkitTemporaryStorage,webkitPersistentStorage,hardwareConcurrency,cookieEnabled,appCodeName,appName,appVersion,platform,product,userAgent,language,languages,onLine,webdriver,getGamepads,javaEnabled,sendBeacon,vibrate,constructor,permissions,registerProtocolHandler,unregisterProtocolHandler');
  assert.strictEqual(await settle(e, "return (await navigator.permissions.query({ name: 'geolocation' })).state + '|' + (await navigator.permissions.query({ name: 'clipboard-write' })).state"), 'denied|denied');
  assert.strictEqual(e.run('typeof chrome.loadTimes + typeof chrome.app'), 'functionobject');
  // localhost and file: are secure
  for (const url of ['http://localhost:8080/', 'file:///tmp/x.html', 'http://127.0.0.1/']) {
    const s = await createEnv({ url });
    assert.strictEqual(s.run("isSecureContext + ':' + ('mediaDevices' in navigator) + ':' + Notification.permission"), 'true:true:default', url);
  }
});

test('navigator.userAgentData: GREASE brand list and versions as Chromium generates them', async () => {
  const e = await createEnv();
  assert.strictEqual(e.run('JSON.stringify(navigator.userAgentData.brands)'),
    '[{"brand":"Chromium","version":"140"},{"brand":"Not=A?Brand","version":"24"},{"brand":"Google Chrome","version":"140"}]');
  assert.strictEqual(e.run('JSON.stringify(navigator.userAgentData.toJSON())'),
    '{"brands":[{"brand":"Chromium","version":"140"},{"brand":"Not=A?Brand","version":"24"},{"brand":"Google Chrome","version":"140"}],"mobile":false,"platform":"Windows"}');
  const hi = JSON.parse(await settle(e, "return JSON.stringify(await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'uaFullVersion', 'platformVersion', 'architecture', 'bitness', 'wow64', 'model']))"));
  assert.strictEqual(hi.uaFullVersion, '140.0.7339.207');
  assert.deepStrictEqual(hi.fullVersionList, [{ brand: 'Chromium', version: '140.0.7339.207' }, { brand: 'Not=A?Brand', version: '24.0.0.0' }, { brand: 'Google Chrome', version: '140.0.7339.207' }]);
  assert.deepStrictEqual([hi.architecture, hi.bitness, hi.wow64, hi.model, hi.platform, hi.mobile], ['x86', '64', false, '', 'Windows', false]);
  assert.strictEqual(await settle(e, "try { await navigator.userAgentData.getHighEntropyValues(); return 'resolved'; } catch (x) { return x.name + ': ' + x.message; }"),
    "TypeError: Failed to execute 'getHighEntropyValues' on 'NavigatorUAData': 1 argument required, but only 0 present.");
  // other majors: Chrome 130 was Chromium, Google Chrome, Not?A_Brand 99; Chrome 141 without the brand has Not?A_Brand 8
  const ua = (v) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
  const e130 = await createEnv({ userAgent: ua(130) });
  assert.strictEqual(e130.run('navigator.userAgentData.brands.map((b) => b.brand + " " + b.version).join()'), 'Chromium 130,Google Chrome 130,Not?A_Brand 99');
  const e141 = await createEnv({ userAgent: ua(141) });
  assert.strictEqual(e141.run('navigator.userAgentData.brands.map((b) => b.brand + " " + b.version).join()'), 'Google Chrome 141,Not?A_Brand 8,Chromium 141');
  assert.strictEqual(await settle(e141, "return (await navigator.userAgentData.getHighEntropyValues(['uaFullVersion'])).uaFullVersion"), '141.0.0.0');
});

test('matchMedia: features the style engine has no answer for are decided like Chrome on a screen', async () => {
  const e = await createEnv();
  const table = {
    '(color-gamut: srgb)': 1, '(color-gamut: p3)': 0, '(color-gamut: rec2020)': 0, '(color-gamut)': 1, '(color-gamut: bogus)': 0,
    '(display-mode: browser)': 1, '(display-mode: standalone)': 0, '(display-mode: fullscreen)': 0, '(display-mode: minimal-ui)': 0, '(display-mode)': 1,
    '(dynamic-range: standard)': 1, '(dynamic-range: high)': 0,
    '(forced-colors: none)': 1, '(forced-colors: active)': 0, '(forced-colors)': 0,
    '(prefers-contrast: no-preference)': 1, '(prefers-contrast: more)': 0, '(prefers-contrast)': 0,
    '(prefers-reduced-motion: no-preference)': 1, '(prefers-reduced-motion: reduce)': 0, '(prefers-reduced-motion)': 0,
    '(prefers-reduced-transparency: no-preference)': 1, '(prefers-reduced-transparency: reduce)': 0,
    '(scripting: enabled)': 1, '(scripting: none)': 0, '(scripting: initial-only)': 0, '(scripting)': 1,
    '(update: fast)': 1, '(update: slow)': 0, '(update)': 1,
    '(overflow-block: scroll)': 1, '(overflow-block: paged)': 0, '(overflow-inline: scroll)': 1, '(overflow-inline: none)': 0,
    '(color)': 1, '(min-color: 8)': 1, '(min-color: 9)': 0, '(color: 8)': 1, '(max-color: 7)': 0, '(color >= 8)': 1, '(9 <= color)': 0, '(4 < color < 9)': 1,
    '(color-index)': 0, '(min-color-index: 0)': 1, '(color-index: 0)': 1, '(monochrome)': 0, '(min-monochrome: 0)': 1, '(monochrome: 0)': 1,
    '(grid)': 0, '(grid: 0)': 1, '(grid: 1)': 0,
    // combinations keep their structure
    'screen and (color-gamut: srgb)': 1, 'not (color-gamut: p3)': 1, '(color-gamut: srgb) and (min-width: 100px)': 1,
    '(color-gamut: srgb) and (min-width: 99999px)': 0, '(color-gamut: p3), (min-width: 100px)': 1, 'not screen and (color-gamut: p3)': 1,
    '(min-width: 100px) and (color-gamut: srgb) and (display-mode: browser)': 1, '(color-gamut: srgb) and (foo)': 0,
    '(  COLOR-GAMUT : SRGB  )': 1, '(prefers-color-scheme: dark)': 0, '(prefers-color-scheme: light)': 1,
  };
  const got = e.run(`(() => { const o = {}; for (const q of ${JSON.stringify(Object.keys(table))}) o[q] = +matchMedia(q).matches; return o; })()`);
  const bad = Object.keys(table).filter((q) => got[q] !== table[q]).map((q) => `${q}: ${got[q]} != ${table[q]}`);
  assert.deepStrictEqual(bad, []);
  // a change of the viewport still re-evaluates and reports
  assert.strictEqual(e.run("var m = matchMedia('(color-gamut: srgb) and (min-width: 1000px)'); m.matches"), true);
  e.run("var seen = []; m.addEventListener('change', (ev) => seen.push(ev.matches + ':' + ev.media))");
  e.mock.vp.w = 500;
  e.hook('onViewportChanged');
  await e.flush();
  assert.strictEqual(e.run('seen.join()'), 'false:(color-gamut: srgb) and (min-width: 1000px)');
});

test('matchMedia: a feature the engine knows (or learns) is not overridden', async () => {
  // this engine does not know prefers-reduced-motion yet: the layer answers no-preference
  const old = await createEnv({ noReducedMotion: true });
  assert.strictEqual(old.run("[matchMedia('(prefers-reduced-motion: no-preference)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches].join()"), 'true,false');
  // one that does (the mock's answer is no-preference): whatever the engine says goes
  const now = await createEnv({});
  assert.strictEqual(now.run("[matchMedia('(prefers-reduced-motion: no-preference)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches].join()"), 'true,false');
  // the query reaches the engine as it is (not replaced by a constant)
  const asked = [];
  const spy = await createEnv({
    beforeLayer: (mock) => {
      const nat = require('vm').runInContext('__native', mock.ctx);
      const f = nat.matchMedia;
      nat.matchMedia = (q) => { asked.push(q); return f(q); };
    },
  });
  spy.run("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.ok(asked.includes('(prefers-reduced-motion: reduce)'), asked.join(' / '));
});

test('MediaQueryList.media is the canonical form of the query', async () => {
  const e = await createEnv();
  assert.strictEqual(e.run("['(min-width:600px)', '  (MIN-WIDTH : 600PX)  ', 'screen,print', 'screen   and  (color-gamut:srgb)', '(  color-gamut : srgb  )'].map((q) => matchMedia(q).media).join('|')"),
    '(min-width: 600px)|(min-width: 600px)|screen, print|screen and (color-gamut: srgb)|(color-gamut: srgb)');
});

// ------------------------------------------------------------------------------------------------
// about:blank / srcdoc frames
// ------------------------------------------------------------------------------------------------
async function pageWithFrames() {
  const group = frameGroup();
  const url = 'https://a.example/dir/page.html?x=1#h';
  const page = await createEnv({
    url, frame: { path: [], group },
    html: '<!DOCTYPE html><html><head><base href="https://a.example/base/"></head><body><iframe id="f"></iframe><iframe id="e" src="about:blank"></iframe><iframe id="s" srcdoc="<p>x</p>"></iframe><iframe id="n" name="n"></iframe></body></html>',
  });
  const doc = '<!DOCTYPE html><html><head></head><body></body></html>';
  // The host gives blank and srcdoc frames the parent's URL; a frame navigated by a link has its own.
  const blank = await createEnv({ url, html: doc, frame: { path: [page.id('#f')], group } });
  const explicit = await createEnv({ url, html: doc, frame: { path: [page.id('#e')], group } });
  const srcdoc = await createEnv({ url, html: '<!DOCTYPE html><html><head></head><body><p>x</p></body></html>', frame: { path: [page.id('#s')], group } });
  const navigated = await createEnv({ url: 'https://a.example/resp.html', html: doc, frame: { path: [page.id('#n')], group } });
  return { page, blank, explicit, srcdoc, navigated };
}
const facts = (env) => JSON.parse(env.run(`(() => {
  const a = document.createElement('a'); a.href = 'x.png';
  return JSON.stringify({ href: location.href, str: String(location), origin: location.origin, protocol: location.protocol, host: location.host, pathname: location.pathname,
    search: location.search, hash: location.hash, URL: document.URL, documentURI: document.documentURI, baseURI: document.baseURI, readyState: document.readyState,
    compatMode: document.compatMode, winOrigin: window.origin, secure: isSecureContext, resolved: a.href });
})()`));

test('about:blank frame: location and document URL are about:blank, readyState complete at once, base URL inherited', async () => {
  const { page, blank, explicit } = await pageWithFrames();
  for (const f of [blank, explicit]) {
    assert.deepStrictEqual(facts(f), {
      href: 'about:blank', str: 'about:blank', origin: 'null', protocol: 'about:', host: '', pathname: 'blank', search: '', hash: '',
      URL: 'about:blank', documentURI: 'about:blank', baseURI: 'https://a.example/base/', readyState: 'complete', compatMode: 'BackCompat',
      winOrigin: 'https://a.example', secure: true, resolved: 'https://a.example/base/x.png',
    });
  }
  // the page is untouched
  assert.deepStrictEqual([facts(page).href, facts(page).URL, facts(page).origin, facts(page).baseURI], ['https://a.example/dir/page.html?x=1#h', 'https://a.example/dir/page.html?x=1#h', 'https://a.example', 'https://a.example/base/']);
  // the layer itself still works with the inherited origin (storage key, blob URLs, postMessage origin)
  assert.strictEqual(blank.run("URL.createObjectURL(new Blob(['x'])).startsWith('blob:https://a.example/')"), true);
  assert.strictEqual(blank.run("new BroadcastChannel('c').name"), 'c');
  // an <iframe> with a real src or a srcdoc keeps working the way it did: only the initial document is special
  assert.strictEqual(blank.run("document.readyState"), 'complete');
});

test('about:blank frame: document.open() and write() give it the URL of the document that wrote', async () => {
  const { blank } = await pageWithFrames();
  blank.run("document.open(); document.write('<p>hi</p>'); document.close();");
  const f = facts(blank);
  assert.strictEqual(f.href, 'https://a.example/dir/page.html?x=1#h');
  assert.strictEqual(f.URL, 'https://a.example/dir/page.html?x=1#h');
  assert.strictEqual(f.origin, 'https://a.example');
  assert.strictEqual(f.baseURI, 'https://a.example/dir/page.html?x=1#h');
});

test('about:blank frame: a fragment navigation shows up on about:blank', async () => {
  const { blank } = await pageWithFrames();
  blank.run("location.hash = 'x'");
  assert.deepStrictEqual([blank.run('location.href'), blank.run('document.URL'), blank.run('location.hash')], ['about:blank#x', 'about:blank#x', '#x']);
});

test('srcdoc frame: about:srcdoc, base URL of the parent', async () => {
  const { srcdoc } = await pageWithFrames();
  const f = facts(srcdoc);
  assert.deepStrictEqual([f.href, f.URL, f.documentURI, f.origin, f.pathname, f.baseURI, f.winOrigin, f.resolved],
    ['about:srcdoc', 'about:srcdoc', 'about:srcdoc', 'null', 'srcdoc', 'https://a.example/base/', 'https://a.example', 'https://a.example/base/x.png']);
});

test('a frame navigated without a src attribute keeps its own URL', async () => {
  const { navigated } = await pageWithFrames();
  const f = facts(navigated);
  assert.deepStrictEqual([f.href, f.URL, f.origin, f.baseURI, f.compatMode, f.resolved], ['https://a.example/resp.html', 'https://a.example/resp.html', 'https://a.example', 'https://a.example/resp.html', 'CSS1Compat', 'https://a.example/x.png']);
});

test('a frame that got a src after it was created is not turned into a blank document', async () => {
  const group = frameGroup();
  const page = await createEnv({ url: 'https://a.example/', frame: { path: [], group }, html: '<iframe id="f"></iframe>' });
  const blank = await createEnv({ url: 'https://a.example/', frame: { path: [page.id('#f')], group } });
  assert.strictEqual(blank.run('location.href'), 'about:blank');
  page.run("document.getElementById('f').src = 'https://a.example/other.html'");
  // still the initial document until the new one arrives
  assert.strictEqual(blank.run('[location.href, document.URL].join()'), 'about:blank,about:blank');
});

test('interfaces without a constructor have length 0', async () => {
  const e = await createEnv();
  assert.deepStrictEqual(Array.from(e.run('[TextTrackList, TextTrack, MediaError, TimeRanges].map((C) => C.length)')), [0, 0, 0, 0]);
});
