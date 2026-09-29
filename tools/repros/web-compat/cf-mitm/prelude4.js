(function(){
  if (window.__t3) return; window.__t3 = 1;
  var tag = '__HOST__' + (window === window.top ? '' : '(iframe)');
  var N = 0, MAX = 6000;
  var RA = Reflect.apply, GOPD = Object.getOwnPropertyDescriptor, DP = Object.defineProperty, RK = Reflect.ownKeys;
  var nts = Function.prototype.toString, fake = new WeakMap();
  DP(Function.prototype, 'toString', { value: function toString() { var f = fake.get(this); return f !== undefined ? f : RA(nts, this, []); }, configurable: true, writable: true });
  function sum(v) {
    try {
      if (v === null) return 'null'; if (v === undefined) return 'undef';
      var t = typeof v;
      if (t === 'string') return JSON.stringify(v.length > 700 ? v.slice(0, 700) + '..' : v);
      if (t === 'number' || t === 'boolean') return String(v);
      if (t === 'function') return 'fn';
      var c = v.constructor && v.constructor.name; 
      if (v.nodeType === 1) return '<' + v.localName + (v.id ? '#' + v.id : '') + '>';
      return c || 'obj';
    } catch (e) { return '?'; }
  }
  function args(a) { var o = []; for (var i = 0; i < a.length && i < 4; i++) o.push(sum(a[i])); return o.join(','); }
  function out(s) { if (N++ < MAX) console.log('T[' + tag + '] ' + s); }
  var skip = /^(Object|Function|Array|String|Number|Boolean|Symbol|Promise|Error|Map|Set|WeakMap|WeakSet|RegExp|Proxy|Reflect|JSON|Math|console|EventTarget|Date|Intl|Crypto|SubtleCrypto|Performance|PerformanceEntry|PerformanceResourceTiming|MessageEvent|Storage|CSSStyleDeclaration|DOMTokenList|Window)$/;
  function wrapProto(name, proto) {
    RK(proto).forEach(function (key) {
      if (typeof key !== 'string') return;
      var d; try { d = GOPD(proto, key); } catch (e) { return; }
      if (!d || !d.configurable) return;
      var label = name + '.' + key;
      try {
        if (d.get) {
          var g = d.get; var w = {}; w[key] = function () { var r = RA(g, this, []); if (r === null || r === undefined) out(label + ' [get] => ' + sum(r)); return r; };
          fake.set(w[key], RA(nts, g, []));
          DP(proto, key, { get: w[key], set: d.set, enumerable: d.enumerable, configurable: true });
        } else if (typeof d.value === 'function' && key !== 'constructor') {
          var f = d.value; var w2 = {}; w2[key] = function () { var r; try { r = RA(f, this, arguments); } catch (e) { out(label + '(' + args(arguments) + ') THROWS ' + e.name + ': ' + e.message); throw e; } out(sum(this) + '.' + label + '(' + args(arguments) + ') => ' + sum(r)); return r; };
          fake.set(w2[key], RA(nts, f, []));
          DP(proto, key, { value: w2[key], writable: d.writable, enumerable: d.enumerable, configurable: true });
        }
      } catch (e) {}
    });
  }
  Object.getOwnPropertyNames(window).forEach(function (n) {
    if (skip.test(n)) return;
    var v; try { v = window[n]; } catch (e) { return; }
    if (typeof v === 'function' && v.prototype && /^(HTML|SVG|Document|DocumentFragment|Element|Node|Text|Range|Selection|ShadowRoot|Canvas|Offscreen|WebGL|Audio|OfflineAudio|BaseAudio|RTC|Navigator|Screen|Speech|Font|TextMetrics|ImageData|ImageBitmap|MutationObserver|Blob|Worker|CSSStyleSheet|CSSRule|CharacterData|Comment|DOMParser|XMLHttpRequest|MediaQuery|Permission|Notification|Trusted)/.test(n)) wrapProto(n, v.prototype);
  });
  ['Element','Node','Document'].forEach(function (n) { try { wrapProto(n, window[n].prototype); } catch (e) {} });
  out('trace installed');
  window.addEventListener('error', function (e) { out('WINERR ' + e.message); }, true);
})();
