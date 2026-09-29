(() => {
  if (window.__instr) return; window.__instr = 1;
  const tag = (location.hostname || 'blank').slice(0, 28) + (window === top ? '' : '(iframe)');
  const seen = new Set();
  const log = (k) => { if (seen.has(k)) return; seen.add(k); try { console.log('@@ ' + tag + ' ' + k); } catch (e) {} };
  const nativeToString = Function.prototype.toString; const RA = Reflect.apply, RC = Reflect.construct, GOPD = Object.getOwnPropertyDescriptor, DP = Object.defineProperty, RK = Reflect.ownKeys;
  const fake = new WeakMap();
  const ts = function toString() { const f = fake.get(this); return f !== undefined ? f : RA(nativeToString, this, []); };
  fake.set(ts, 'function toString() { [native code] }');
  try { Object.defineProperty(Function.prototype, 'toString', { value: ts, writable: true, configurable: true }); } catch (e) {}
  const skipIface = new Set(['Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'Promise', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Proxy', 'Reflect', 'JSON', 'Math', 'console', 'Window', 'EventTarget', 'Node', 'Element']);
  function wrapProto(name, proto) {
    for (const key of Reflect.ownKeys(proto)) {
      if (typeof key !== 'string' && typeof key !== 'symbol') continue;
      let d; try { d = Object.getOwnPropertyDescriptor(proto, key); } catch (e) { continue; }
      if (!d || !d.configurable) continue;
      const label = name + '.' + String(key);
      try {
        if (d.get || d.set) {
          const nd = {};
          nd.configurable = true; nd.enumerable = d.enumerable;
          if (d.get) { const g = d.get; const w = { get [key]() { log(label + ' [get]'); return RA(g, this, []); } }; const gg = Object.getOwnPropertyDescriptor(w, key).get; fake.set(gg, RA(nativeToString, g, [])); nd.get = gg; }
          if (d.set) { const s = d.set; const w = { set [key](v) { log(label + ' [set]'); return RA(s, this, [v]); } }; const ss = Object.getOwnPropertyDescriptor(w, key).set; fake.set(ss, RA(nativeToString, s, [])); nd.set = ss; }
          Object.defineProperty(proto, key, nd);
        } else if (typeof d.value === 'function' && key !== 'constructor') {
          const f = d.value;
          const w = { [key]: function () { log(label + '()'); return new.target ? RC(f, arguments, new.target) : RA(f, this, arguments); } };
          const ww = w[key]; fake.set(ww, RA(nativeToString, f, []));
          try { Object.defineProperty(ww, 'length', { value: f.length }); } catch (e) {}
          Object.defineProperty(proto, key, { value: ww, writable: d.writable, enumerable: d.enumerable, configurable: true });
        }
      } catch (e) {}
    }
  }
  for (const n of Object.getOwnPropertyNames(window)) {
    if (skipIface.has(n)) continue;
    let v; try { v = window[n]; } catch (e) { continue; }
    if (typeof v === 'function' && v.prototype && /^[A-Z]/.test(n) && /^(HTML|SVG|CSS|DOM|Web|Audio|Offscreen|Canvas|Media|Navigator|Screen|Performance|Permission|Notification|Speech|RTC|Battery|Network|Storage|Intl|Font|Text|Range|Selection|Crypto|SubtleCrypto|Keyboard|Mouse|Pointer|Touch|Visual|Gamepad|Sensor|Bluetooth|USB|Clipboard|Credential|Idle|Push|Service|Shared|Worker|Blob|File|Image|Document|Cache|IDB|Ind|Message|Broadcast|Resize|Mutation|Intersection|History|Location|Plugin|MimeType|Animation|Battery|Cookie|Trusted|XR|Ink|Presentation|Wake|Lock|Payment|Media|Screen|Style|Event|Error)/.test(n)) {
      wrapProto(n, v.prototype);
    }
  }
  // window / document own data properties
  const winNames = ['chrome', 'outerWidth', 'outerHeight', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'screenX', 'screenY', 'screenLeft', 'screenTop', 'pageXOffset', 'pageYOffset', 'scrollX', 'scrollY', 'name', 'opener', 'parent', 'top', 'frameElement', 'origin', 'crypto', 'performance', 'navigator', 'screen', 'history', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'speechSynthesis', 'visualViewport', 'onerror', 'ontouchstart', 'orientation', 'external', 'clientInformation', 'styleMedia', 'isSecureContext', 'crossOriginIsolated', 'Notification', 'webkitRequestFileSystem', 'webkitResolveLocalFileSystemURL', 'PERSISTENT', 'TEMPORARY', 'AudioContext', 'webkitAudioContext', 'OfflineAudioContext', 'webkitOfflineAudioContext', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'OffscreenCanvas', 'Worker', 'SharedWorker', 'WebAssembly', 'SharedArrayBuffer', 'queueMicrotask', 'requestIdleCallback', 'structuredClone', 'trustedTypes', 'Intl', 'eval', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'fetch', 'XMLHttpRequest', 'postMessage', 'addEventListener', 'getComputedStyle', 'matchMedia', 'atob', 'btoa', 'Image', 'Option', 'Audio', 'FontFace', 'Blob', 'URL', 'MessageChannel', 'BroadcastChannel', 'Function', 'Date', 'Math', 'JSON', 'Reflect', 'Proxy', 'Symbol', 'Error', 'ReadableStream', 'TextEncoder', 'TextDecoder', 'CompressionStream', 'DecompressionStream', 'createImageBitmap', 'MediaSource', 'ManagedMediaSource', 'MediaRecorder', 'AudioWorkletNode', 'PaymentRequest', 'ApplePaySession', 'Bluetooth', 'BatteryManager', 'DeviceMotionEvent', 'DeviceOrientationEvent', 'TouchEvent', 'PointerEvent', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'GPU', 'WebTransport', 'RTCRtpSender', 'RTCRtpReceiver', 'ScriptProcessorNode', 'Iterator', 'Array', 'Object', 'Number', 'String', 'RegExp', 'Promise'];
  const shim = (obj, oname) => { for (const n of winNames) {
    let d; try { d = Object.getOwnPropertyDescriptor(obj, n); } catch (e) { continue; }
    if (!d || !d.configurable) { continue; }
    const label = oname + '.' + n;
    try {
      if (d.get) { const g = d.get; Object.defineProperty(obj, n, { configurable: true, enumerable: d.enumerable, get: function () { log(label + ' [get]'); return RA(g, this, []); }, set: d.set }); }
      else if ('value' in d && d.writable) { let val = d.value; Object.defineProperty(obj, n, { configurable: true, enumerable: d.enumerable, get() { log(label + ' [get]'); return val; }, set(v) { log(label + ' [set]'); val = v; } }); }
    } catch (e) {} } };
  shim(window, 'window');
  // Error.stack / captureStackTrace / prepareStackTrace usage
  try { const cst = Error.captureStackTrace; if (cst) { Error.captureStackTrace = function captureStackTrace() { log('Error.captureStackTrace()'); return RA(cst, this, arguments); }; } } catch (e) {}
  try { let pst; Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, get() { log('Error.prepareStackTrace [get]'); return pst; }, set(v) { log('Error.prepareStackTrace [set]'); pst = v; } }); } catch (e) {}
  try { let lim = Error.stackTraceLimit; Object.defineProperty(Error, 'stackTraceLimit', { configurable: true, get() { log('Error.stackTraceLimit [get]'); return lim; }, set(v) { log('Error.stackTraceLimit [set]'); lim = v; } }); } catch (e) {}
  // constructors: log construct
  for (const n of ['AudioContext', 'OfflineAudioContext', 'webkitOfflineAudioContext', 'RTCPeerConnection', 'OffscreenCanvas', 'Worker', 'SharedWorker', 'FontFace', 'Image', 'MessageChannel', 'BroadcastChannel', 'MediaRecorder', 'Notification', 'SpeechSynthesisUtterance', 'PerformanceObserver', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Blob', 'File', 'FileReader', 'DOMParser', 'XMLSerializer', 'Path2D', 'ImageData', 'DOMMatrix', 'DOMRect', 'Intl', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream', 'DecompressionStream', 'WeakRef', 'FinalizationRegistry', 'SharedArrayBuffer', 'Atomics', 'WebAssembly']) {
    try { const C = window[n]; if (typeof C === 'function' && !C.__w) { const P = new Proxy(C, { construct(t, a, nt) { log('new ' + n + '()'); return Reflect.construct(t, a, nt === P ? t : nt); }, apply(t, th, a) { log(n + '()'); return Reflect.apply(t, th, a); } }); fake.set(P, RA(nativeToString, C, [])); Object.defineProperty(window, n, { value: P, writable: true, configurable: true, enumerable: false }); } } catch (e) {}
  }
  // Intl / Date / Math etc statics
  const wrapStatic = (obj, oname) => { for (const key of Object.getOwnPropertyNames(obj)) { let d; try { d = Object.getOwnPropertyDescriptor(obj, key); } catch (e) { continue; } if (d && d.configurable && typeof d.value === 'function' && !/^(prototype|constructor|name|length)$/.test(key)) { const f = d.value; const w = { [key]: function () { log(oname + '.' + key + '()'); return new.target ? RC(f, arguments, new.target) : RA(f, this, arguments); } }; fake.set(w[key], RA(nativeToString, f, [])); try { Object.defineProperty(obj, key, { value: w[key], writable: d.writable, configurable: true, enumerable: d.enumerable }); } catch (e) {} } } };
  try { wrapStatic(Date.prototype, 'Date.prototype'); wrapStatic(Math, 'Math'); } catch (e) {}
  try { wrapProto('Intl.DateTimeFormat', Intl.DateTimeFormat.prototype); wrapProto('Intl.NumberFormat', Intl.NumberFormat.prototype); wrapProto('Intl.Collator', Intl.Collator.prototype); wrapProto('Intl.PluralRules', Intl.PluralRules.prototype); wrapProto('Intl.RelativeTimeFormat', Intl.RelativeTimeFormat.prototype); wrapProto('Intl.ListFormat', Intl.ListFormat.prototype); wrapProto('Intl.Locale', Intl.Locale.prototype); wrapStatic(Intl, 'Intl'); } catch (e) {}
  try { wrapProto('WebAssembly', WebAssembly); } catch (e) {}
  try { wrapProto('CSS', CSS); } catch (e) {}
  try { wrapProto('document', Document.prototype); wrapProto('HTMLDocument', HTMLDocument.prototype); } catch (e) {}
  try { wrapProto('Element', Element.prototype); wrapProto('Node', Node.prototype); wrapProto('EventTarget', EventTarget.prototype); wrapProto('Window', Window.prototype); } catch (e) {}
})();
