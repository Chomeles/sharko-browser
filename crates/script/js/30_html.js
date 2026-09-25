// 30_html.js — HTML element classes (IDL attributes reflecting content attributes), SVG and
// MathML element classes, forms (constraint validation, form submission, entry lists),
// click activation behaviour, focus, innerText, template contents, images, canvas/media stubs.
(function (L) {
  'use strict';
  const N = L.N;
  const DOMException = L.DOMException;
  const idOf = L.idOf, typeOf = L.typeOf, lnOf = L.lnOf, nsOf = L.nsOf, isNode = L.isNode, wrap = L.wrap;
  const state = L.state;
  const INTERNAL = L.INTERNAL;
  const HTML = 0, SVG = 1;
  const Element = L.Element;
  const setAttr = L.setAttr, removeAttr = L.removeAttr;

  // ---------------------------------------------------------------------------------------
  // Reflection helpers
  // ---------------------------------------------------------------------------------------
  function def(proto, name, get, set) {
    Object.defineProperty(proto, name, { get, set, enumerable: true, configurable: true });
  }
  function attrOrEmpty(el, a) { const v = N.getAttr(idOf(el), a); return v === null ? '' : v; }
  function parseInteger(s) {
    const m = /^[\t\n\f\r ]*([+-]?[0-9]+)/.exec(s);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= -2147483648 && n <= 2147483647 ? n : null;
  }
  function parseNonNeg(s) { const n = parseInteger(s); return n === null || n < 0 ? null : n; }
  function parseFloatAttr(s) {
    const m = /^[\t\n\f\r ]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(s);
    return m ? parseFloat(m[1]) : null;
  }
  const R = {
    str(proto, prop, attr) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () { return attrOrEmpty(this, a); }, function (v) { setAttr(this, idOf(this), a, `${v}`); });
    },
    strNull(proto, prop, attr) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () { return N.getAttr(idOf(this), a); }, function (v) { L.setAttrOrRemove(this, a, v === null || v === undefined ? null : `${v}`); });
    },
    bool(proto, prop, attr) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () { return N.hasAttr(idOf(this), a); }, function (v) {
        if (v) setAttr(this, idOf(this), a, ''); else removeAttr(this, idOf(this), a);
      });
    },
    long(proto, prop, attr, dflt = 0, nonNeg = false) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () {
        const v = N.getAttr(idOf(this), a);
        if (v === null) return dflt;
        const n = nonNeg ? parseNonNeg(v) : parseInteger(v);
        return n === null ? dflt : n;
      }, function (v) {
        const n = L.toLong(v);
        if (nonNeg && n < 0) throw new DOMException(`Failed to set the '${prop}' property: The value provided (${n}) is negative.`, 'IndexSizeError');
        setAttr(this, idOf(this), a, String(n));
      });
    },
    ulong(proto, prop, attr, dflt = 0, min = 0, max = 2147483647) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () {
        const v = N.getAttr(idOf(this), a);
        if (v === null) return dflt;
        const n = parseNonNeg(v);
        if (n === null || n < min) return dflt;
        return Math.min(n, max);
      }, function (v) {
        let n = L.toULong(v);
        if (n > 2147483647) n = dflt;
        if (min > 0 && n === 0) throw new DOMException(`Failed to set the '${prop}' property: The value provided is 0, which is an invalid size.`, 'IndexSizeError');
        setAttr(this, idOf(this), a, String(n));
      });
    },
    double(proto, prop, attr, dflt = 0) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () {
        const v = N.getAttr(idOf(this), a);
        if (v === null) return dflt;
        const n = parseFloatAttr(v);
        return n === null ? dflt : n;
      }, function (v) {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new TypeError(`Failed to set the '${prop}' property: The provided double value is non-finite.`);
        setAttr(this, idOf(this), a, String(n));
      });
    },
    url(proto, prop, attr) {
      const a = attr || prop.toLowerCase();
      def(proto, prop, function () {
        const v = N.getAttr(idOf(this), a);
        if (v === null) return '';
        const r = L.resolveURL(v);
        return r === null ? v : r;
      }, function (v) { setAttr(this, idOf(this), a, L.toUSV(v)); });
    },
    enumerated(proto, prop, attr, values, missing, invalid) {
      const a = attr || prop.toLowerCase();
      const set = new Set(values);
      def(proto, prop, function () {
        const v = N.getAttr(idOf(this), a);
        if (v === null) return missing;
        const l = L.asciiLower(v);
        return set.has(l) ? l : (invalid === undefined ? missing : invalid);
      }, function (v) { setAttr(this, idOf(this), a, `${v}`); });
    },
    crossOrigin(proto) {
      def(proto, 'crossOrigin', function () {
        const v = N.getAttr(idOf(this), 'crossorigin');
        if (v === null) return null;
        return L.asciiLower(v) === 'use-credentials' ? 'use-credentials' : 'anonymous';
      }, function (v) { L.setAttrOrRemove(this, 'crossorigin', v === null || v === undefined ? null : `${v}`); });
    },
    referrerPolicy(proto) {
      R.enumerated(proto, 'referrerPolicy', 'referrerpolicy', ['', 'no-referrer', 'no-referrer-when-downgrade',
        'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin', 'unsafe-url'], '', '');
    },
    tokens(proto, prop, attr, supported) {
      const a = attr || prop.toLowerCase();
      const sup = supported ? new Set(supported) : null;
      def(proto, prop, function () { return L.tokenList(this, a, sup); }, function (v) { L.tokenList(this, a, sup).value = `${v}`; });
    },
  };
  L.reflect = R;

  // ---------------------------------------------------------------------------------------
  // HTMLElement (custom element constructor semantics)
  // ---------------------------------------------------------------------------------------
  // The "HTML element constructor" steps, shared by HTMLElement (autonomous custom
  // elements) and the element interfaces customized built-ins extend.
  function htmlElementConstruct(newTarget, iface) {
    const d = newTarget === undefined ? undefined : L.ceByCtor.get(newTarget);
    if (d === undefined) throw new TypeError('Illegal constructor');
    // autonomous: only HTMLElement; customized built-in: the extended element's interface
    if (d.ext === null ? iface !== HTMLElement : htmlClasses.get(d.localName) !== iface) throw new TypeError('Illegal constructor');
    const stack = d.stack;
    if (stack.length === 0) {
      const id = N.createElement(d.localName, '');
      if (d.ext !== null) N.setAttr(id, 'is', d.name);
      const w = L.wrapElementAs(id, newTarget.prototype, d.localName, HTML);
      L.ceState.set(w, d);
      if (typeof N.setDefined === 'function') N.setDefined(id);
      return w;
    }
    const w = stack[stack.length - 1];
    if (w === L.ALREADY_CONSTRUCTED) throw new TypeError('Failed to construct \'HTMLElement\': This instance is already constructed');
    stack[stack.length - 1] = L.ALREADY_CONSTRUCTED;
    return w;
  }
  class HTMLElement extends Element {
    constructor() { return htmlElementConstruct(new.target, HTMLElement); }
  }
  L.HTMLElement = HTMLElement;

  // ---------------------------------------------------------------------------------------
  // Focus
  // ---------------------------------------------------------------------------------------
  const docId = L.documentId;
  function isFocusRoot(id) {
    if (id === 0 || id === docId) return true;
    const w = wrap(id);
    const ln = lnOf(w);
    return (ln === 'body' || ln === 'html') && nsOf(w) === HTML;
  }
  L.fireFocusChange = function (prevId, newId) {
    const prevW = isFocusRoot(prevId) ? null : wrap(prevId);
    const newW = newId === 0 ? null : wrap(newId);
    if (prevW !== null) {
      L.fire(prevW, 'blur', { bubbles: false, composed: true, relatedTarget: newW, view: L.window }, L.FocusEvent);
      L.fire(prevW, 'focusout', { bubbles: true, composed: true, relatedTarget: newW, view: L.window }, L.FocusEvent);
    }
    if (newW !== null) {
      L.fire(newW, 'focus', { bubbles: false, composed: true, relatedTarget: prevW, view: L.window }, L.FocusEvent);
      L.fire(newW, 'focusin', { bubbles: true, composed: true, relatedTarget: prevW, view: L.window }, L.FocusEvent);
    }
  };
  // N.focus/N.blur may dispatch blur/focusout/focus/focusin themselves (through
  // hooks.onEvent, counted in L.nativeFocusEvents); only fire them here if they did not.
  L.nativeFocusEvents = 0;
  function focusElement(el, options) {
    const id = idOf(el);
    if (!N.isConnected(id)) return;
    const prev = N.activeElement();
    if (prev === id) return;
    const seen = L.nativeFocusEvents;
    N.focus(id);
    if (N.activeElement() === id && !(options && options.preventScroll)) scrollFocusedIntoView(el, id);
    if (L.nativeFocusEvents !== seen || N.activeElement() !== id) return;
    L.fireFocusChange(prev, id);
  }
  // Like Chrome: a newly focused element that is not fully visible is centered.
  function scrollFocusedIntoView(el, id) {
    try {
      const r = el.getBoundingClientRect();
      const w = L.window.innerWidth, h = L.window.innerHeight;
      if (r.width === 0 && r.height === 0) return;
      if (r.top >= 0 && r.left >= 0 && r.bottom <= h && r.right <= w) return;
      N.scrollIntoView(id, 'center', 'nearest', 'auto');
    } catch (_) { /* best effort */ }
  }
  function blurElement(el) {
    const id = idOf(el);
    if (N.activeElement() !== id) return;
    const seen = L.nativeFocusEvents;
    N.blur(id);
    if (L.nativeFocusEvents !== seen) return;
    L.fireFocusChange(id, 0);
  }
  L.focusElement = focusElement;

  // ---------------------------------------------------------------------------------------
  // innerText
  // ---------------------------------------------------------------------------------------
  const INNERTEXT_SKIP = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'meta', 'link', 'base', 'datalist', 'iframe', 'object', 'embed']);
  const BLOCKISH = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'flow-root', 'table-caption', 'table-row-group', 'table-header-group', 'table-footer-group']);
  function innerTextCollect(id, items, pre) {
    for (let c = N.firstChild(id); c !== 0; c = N.nextSibling(c)) {
      const t = N.nodeType(c);
      if (t === 3) {
        let s = N.getText(c);
        if (!pre) s = s.replace(/[\t\n\f\r ]+/g, ' ');
        if (s !== '') items.push(s);
        continue;
      }
      if (t !== 1) continue;
      const ln = N.localName(c);
      if (INNERTEXT_SKIP.has(ln)) continue;
      const disp = N.computedStyle(c, 'display', '');
      if (disp === 'none') continue;
      if (ln === 'br') { items.push('\n'); continue; }
      const ws = N.computedStyle(c, 'white-space', '');
      const cpre = ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces' || (ws === '' && (ln === 'pre' || ln === 'textarea' || ln === 'listing' || ln === 'xmp'));
      const block = BLOCKISH.has(disp) || (disp === '' && /^(div|p|h[1-6]|ul|ol|li|section|article|header|footer|nav|main|aside|form|table|tr|blockquote|pre|address|dl|dt|dd|figure|figcaption|fieldset|hr|details|summary)$/.test(ln));
      const cell = disp === 'table-cell' || (disp === '' && (ln === 'td' || ln === 'th'));
      const row = disp === 'table-row' || (disp === '' && ln === 'tr');
      if (ln === 'p') items.push(2);
      else if (block || row) items.push(1);
      const start = items.length;
      innerTextCollect(c, items, cpre);
      if (cell && N.nextSibling(c) !== 0) {
        let n = N.nextSibling(c);
        while (n !== 0 && N.nodeType(n) !== 1) n = N.nextSibling(n);
        if (n !== 0) items.push('\t');
      }
      if (ln === 'p') items.push(2);
      else if (block || row) items.push(1);
      void start;
    }
  }
  function innerTextGet(el) {
    const id = idOf(el);
    L.flushSheets();
    if (!N.isConnected(id) || N.computedStyle(id, 'display', '') === 'none') return N.textContent(id);
    const items = [];
    innerTextCollect(id, items, false);
    // Resolve: strip spaces around line breaks, collapse required line breaks
    let out = '';
    let pendingBreak = 0;
    let atLineStart = true;
    for (const it of items) {
      if (typeof it === 'number') { if (out !== '') pendingBreak = Math.max(pendingBreak, it); continue; }
      let s = it;
      if (pendingBreak) {
        out = out.replace(/ +$/, '');
        out += '\n'.repeat(pendingBreak);
        pendingBreak = 0;
        atLineStart = true;
      }
      if (atLineStart) s = s.replace(/^ +/, '');
      if (s === '') continue;
      if (out.endsWith(' ') && s.startsWith(' ')) s = s.slice(1);
      out += s;
      atLineStart = s.endsWith('\n');
    }
    return out.replace(/ +(\n)/g, '$1').replace(/ +$/, '');
  }
  function innerTextSet(el, v) {
    const id = idOf(el);
    const s = v === null || v === undefined ? '' : `${v}`;
    const frag = N.createFragment();
    const parts = s.split(/\r\n|\r|\n/);
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) N.appendChild(frag, N.createElement('br', ''));
      if (parts[i] !== '') N.appendChild(frag, N.createText(parts[i]));
    }
    L.replaceAllCore(id, el, () => { N.setTextContent(id, ''); if (N.firstChild(frag) !== 0) N.appendChild(id, frag); });
  }
  L.innerTextGet = innerTextGet;

  // ---------------------------------------------------------------------------------------
  // HTMLElement members
  // ---------------------------------------------------------------------------------------
  const clickInProgress = new WeakSet();
  const FOCUSABLE_BY_DEFAULT = new Set(['button', 'select', 'textarea', 'iframe', 'object', 'embed']);
  function defaultTabIndex(el) {
    const id = idOf(el);
    const ln = lnOf(el);
    if (FOCUSABLE_BY_DEFAULT.has(ln)) return 0;
    if (ln === 'input') return (N.getAttr(id, 'type') || '').toLowerCase() === 'hidden' ? -1 : 0;
    if ((ln === 'a' || ln === 'area') && N.hasAttr(id, 'href')) return 0;
    if (ln === 'summary') return 0;
    if ((ln === 'audio' || ln === 'video') && N.hasAttr(id, 'controls')) return 0;
    const ce = N.getAttr(id, 'contenteditable');
    if (ce !== null && ce.toLowerCase() !== 'false') return 0;
    return -1;
  }
  const internalsMap = new WeakMap();
  L.mixin(HTMLElement.prototype, {
    get title() { return attrOrEmpty(this, 'title'); },
    set title(v) { setAttr(this, idOf(this), 'title', `${v}`); },
    get lang() { return attrOrEmpty(this, 'lang'); },
    set lang(v) { setAttr(this, idOf(this), 'lang', `${v}`); },
    get translate() {
      for (let id = idOf(this); id !== 0 && N.nodeType(id) === 1; id = N.parent(id)) {
        const v = N.getAttr(id, 'translate');
        if (v !== null) { const l = v.toLowerCase(); if (l === 'yes' || l === '') return true; if (l === 'no') return false; }
      }
      return true;
    },
    set translate(v) { setAttr(this, idOf(this), 'translate', v ? 'yes' : 'no'); },
    get dir() {
      const v = L.asciiLower(attrOrEmpty(this, 'dir'));
      return v === 'ltr' || v === 'rtl' || v === 'auto' ? v : '';
    },
    set dir(v) { setAttr(this, idOf(this), 'dir', `${v}`); },
    get hidden() {
      const v = N.getAttr(idOf(this), 'hidden');
      if (v === null) return false;
      return L.asciiLower(v) === 'until-found' ? 'until-found' : true;
    },
    set hidden(v) {
      if (typeof v === 'string' && L.asciiLower(v) === 'until-found') setAttr(this, idOf(this), 'hidden', 'until-found');
      else if (v) setAttr(this, idOf(this), 'hidden', '');
      else removeAttr(this, idOf(this), 'hidden');
    },
    get inert() { return N.hasAttr(idOf(this), 'inert'); },
    set inert(v) { if (v) setAttr(this, idOf(this), 'inert', ''); else removeAttr(this, idOf(this), 'inert'); },
    get accessKey() { return attrOrEmpty(this, 'accesskey'); },
    set accessKey(v) { setAttr(this, idOf(this), 'accesskey', `${v}`); },
    get accessKeyLabel() { return ''; },
    get draggable() {
      const v = N.getAttr(idOf(this), 'draggable');
      if (v !== null) { const l = v.toLowerCase(); if (l === 'true') return true; if (l === 'false') return false; }
      const ln = lnOf(this);
      return ln === 'img' || (ln === 'a' && N.hasAttr(idOf(this), 'href'));
    },
    set draggable(v) { setAttr(this, idOf(this), 'draggable', v ? 'true' : 'false'); },
    get spellcheck() {
      for (let id = idOf(this); id !== 0 && N.nodeType(id) === 1; id = N.parent(id)) {
        const v = N.getAttr(id, 'spellcheck');
        if (v !== null) { const l = v.toLowerCase(); if (l === 'true' || l === '') return true; if (l === 'false') return false; }
      }
      return true;
    },
    set spellcheck(v) { setAttr(this, idOf(this), 'spellcheck', v ? 'true' : 'false'); },
    get autocapitalize() { return attrOrEmpty(this, 'autocapitalize'); },
    set autocapitalize(v) { setAttr(this, idOf(this), 'autocapitalize', `${v}`); },
    get autofocus() { return N.hasAttr(idOf(this), 'autofocus'); },
    set autofocus(v) { if (v) setAttr(this, idOf(this), 'autofocus', ''); else removeAttr(this, idOf(this), 'autofocus'); },
    get nonce() { return attrOrEmpty(this, 'nonce'); },
    set nonce(v) { setAttr(this, idOf(this), 'nonce', `${v}`); },
    get innerText() { return innerTextGet(this); },
    set innerText(v) { innerTextSet(this, v); },
    get outerText() { return innerTextGet(this); },
    set outerText(v) {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0) throw new DOMException("Failed to set the 'outerText' property on 'HTMLElement': The element has no parent.", 'NoModificationAllowedError');
      const s = v === null || v === undefined ? '' : `${v}`;
      const frag = N.createFragment();
      const parts = s.split(/\r\n|\r|\n/);
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) N.appendChild(frag, N.createElement('br', ''));
        if (parts[i] !== '') N.appendChild(frag, N.createText(parts[i]));
      }
      if (N.firstChild(frag) === 0) N.appendChild(frag, N.createText(''));
      L.replaceChildImpl(wrap(p), wrap(frag), this);
    },
    click() {
      if (isDisabledFormControl(this)) return;
      if (clickInProgress.has(this)) return;
      clickInProgress.add(this);
      try {
        const ev = new L.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, view: L.window, pointerId: -1, pointerType: '', detail: 1 });
        L.EV.setTrusted(ev, false);
        L.dispatchCore(this, ev, null);
      } finally {
        clickInProgress.delete(this);
      }
    },
    focus(options) { focusElement(this, options); },
    blur() { blurElement(this); },
    get tabIndex() {
      const v = N.getAttr(idOf(this), 'tabindex');
      if (v !== null) { const n = parseInteger(v); if (n !== null) return n; }
      return defaultTabIndex(this);
    },
    set tabIndex(v) { setAttr(this, idOf(this), 'tabindex', String(L.toLong(v))); },
    get dataset() { return L.dataset(this); },
    get style() { return L.inlineStyle(this); },
    set style(v) { L.inlineStyle(this).cssText = v; },
    get attributeStyleMap() { return undefined; },
    get offsetParent() { L.flushSheets(); return wrap(N.offsetMetrics(idOf(this))[4]); },
    get offsetTop() { L.flushSheets(); return N.offsetMetrics(idOf(this))[1]; },
    get offsetLeft() { L.flushSheets(); return N.offsetMetrics(idOf(this))[0]; },
    get offsetWidth() { L.flushSheets(); return N.offsetMetrics(idOf(this))[2]; },
    get offsetHeight() { L.flushSheets(); return N.offsetMetrics(idOf(this))[3]; },
    get contentEditable() {
      const v = N.getAttr(idOf(this), 'contenteditable');
      if (v === null) return 'inherit';
      const l = v.toLowerCase();
      if (l === '' || l === 'true') return 'true';
      if (l === 'false') return 'false';
      if (l === 'plaintext-only') return 'plaintext-only';
      return 'inherit';
    },
    set contentEditable(v) {
      const l = L.asciiLower(`${v}`);
      if (l === 'inherit') removeAttr(this, idOf(this), 'contenteditable');
      else if (l === 'true' || l === 'false' || l === 'plaintext-only') setAttr(this, idOf(this), 'contenteditable', l);
      else throw new DOMException(`Failed to set the 'contentEditable' property on 'HTMLElement': The value provided ('${v}') is not one of 'true', 'false', 'plaintext-only', or 'inherit'.`, 'SyntaxError');
    },
    get isContentEditable() {
      if (L.document.designMode === 'on') return true;
      for (let id = idOf(this); id !== 0 && N.nodeType(id) === 1; id = N.parent(id)) {
        const v = N.getAttr(id, 'contenteditable');
        if (v !== null) { const l = v.toLowerCase(); if (l === '' || l === 'true' || l === 'plaintext-only') return true; if (l === 'false') return false; }
      }
      return false;
    },
    get enterKeyHint() { return attrOrEmpty(this, 'enterkeyhint').toLowerCase(); },
    set enterKeyHint(v) { setAttr(this, idOf(this), 'enterkeyhint', `${v}`); },
    get inputMode() { return attrOrEmpty(this, 'inputmode').toLowerCase(); },
    set inputMode(v) { setAttr(this, idOf(this), 'inputmode', `${v}`); },
    get popover() {
      const v = N.getAttr(idOf(this), 'popover');
      if (v === null) return null;
      const l = v.toLowerCase();
      return l === 'manual' ? 'manual' : l === 'hint' ? 'hint' : 'auto';
    },
    set popover(v) { L.setAttrOrRemove(this, 'popover', v === null || v === undefined ? null : `${v}`); },
    showPopover() { popoverToggle(this, true); },
    hidePopover() { popoverToggle(this, false); },
    togglePopover(force) { const open = popoverOpen.has(this); popoverToggle(this, force === undefined ? !open : !!force); return popoverOpen.has(this); },
    attachInternals() {
      const d = L.ceState.get(this);
      if (d === undefined || d === L.CE_FAILED) throw new DOMException("Failed to execute 'attachInternals' on 'HTMLElement': Unable to attach ElementInternals to non-custom elements.", 'NotSupportedError');
      if (internalsMap.has(this)) throw new DOMException("Failed to execute 'attachInternals' on 'HTMLElement': ElementInternals for the specified element was already attached.", 'NotSupportedError');
      const i = new ElementInternals(INTERNAL, this);
      internalsMap.set(this, i);
      return i;
    },
    get writingSuggestions() { return attrOrEmpty(this, 'writingsuggestions') || 'true'; },
    set writingSuggestions(v) { setAttr(this, idOf(this), 'writingsuggestions', `${v}`); },
    get virtualKeyboardPolicy() { return attrOrEmpty(this, 'virtualkeyboardpolicy'); },
    set virtualKeyboardPolicy(v) { setAttr(this, idOf(this), 'virtualkeyboardpolicy', `${v}`); },
  });
  L.defineEventHandlers(HTMLElement.prototype, L.GLOBAL_HANDLERS);
  const popoverOpen = new WeakSet();
  function popoverToggle(el, open) {
    if (N.getAttr(idOf(el), 'popover') === null) throw new DOMException("Failed to execute 'showPopover' on 'HTMLElement': Not supported on elements that do not have a valid value for the 'popover' attribute.", 'NotSupportedError');
    if (popoverOpen.has(el) === open) return;
    const oldState = open ? 'closed' : 'open', newState = open ? 'open' : 'closed';
    if (open && !L.fire(el, 'beforetoggle', { cancelable: true, oldState, newState }, L.ToggleEvent)) return;
    if (!open) L.fire(el, 'beforetoggle', { cancelable: false, oldState, newState }, L.ToggleEvent);
    if (open) popoverOpen.add(el); else popoverOpen.delete(el);
    L.postTask(() => L.fire(el, 'toggle', { oldState, newState }, L.ToggleEvent));
  }

  // ElementInternals / CustomStateSet / ValidityState
  class CustomStateSet {
    #set = new Set();
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get size() { return this.#set.size; }
    add(v) { this.#set.add(`${v}`); return this; }
    delete(v) { return this.#set.delete(`${v}`); }
    has(v) { return this.#set.has(`${v}`); }
    clear() { this.#set.clear(); }
    forEach(cb, thisArg) { for (const v of this.#set) Reflect.apply(cb, thisArg, [v, v, this]); }
    entries() { return this.#set.entries(); }
    keys() { return this.#set.keys(); }
    values() { return this.#set.values(); }
    [Symbol.iterator]() { return this.#set.values(); }
  }
  class ElementInternals {
    #el; #flags = null; #message = ''; #states = new CustomStateSet(INTERNAL); #value = null;
    constructor(token, el) { if (token !== INTERNAL) throw L.illegal(); this.#el = el; }
    setFormValue(value, stateArg) { this.#value = value; }
    get form() { return formOwnerOf(this.#el); }
    setValidity(flags, message, anchor) {
      const f = flags || {};
      const any = Object.keys(f).some((k) => f[k]);
      this.#flags = any ? Object.assign({}, f) : null;
      this.#message = any ? (message === undefined ? '' : `${message}`) : '';
    }
    get willValidate() { return true; }
    get validity() { return new ValidityState(INTERNAL, () => this.#flags || {}); }
    get validationMessage() { return this.#message; }
    checkValidity() {
      if (this.#flags === null) return true;
      L.fire(this.#el, 'invalid', { cancelable: true });
      return false;
    }
    reportValidity() { return this.checkValidity(); }
    get labels() { return labelsFor(this.#el); }
    get states() { return this.#states; }
    get shadowRoot() { const sr = L.shadowOfHost.get(this.#el); return sr === undefined ? null : sr; }
    static { L.internalsValue = (i) => i.#value; }
  }
  for (const p of ['role', 'ariaAtomic', 'ariaAutoComplete', 'ariaBusy', 'ariaChecked', 'ariaColCount', 'ariaColIndex',
    'ariaColSpan', 'ariaCurrent', 'ariaDescription', 'ariaDisabled', 'ariaExpanded', 'ariaHasPopup', 'ariaHidden',
    'ariaInvalid', 'ariaKeyShortcuts', 'ariaLabel', 'ariaLevel', 'ariaLive', 'ariaModal', 'ariaMultiLine',
    'ariaMultiSelectable', 'ariaOrientation', 'ariaPlaceholder', 'ariaPosInSet', 'ariaPressed', 'ariaReadOnly',
    'ariaRelevant', 'ariaRequired', 'ariaRoleDescription', 'ariaRowCount', 'ariaRowIndex', 'ariaRowSpan',
    'ariaSelected', 'ariaSetSize', 'ariaSort', 'ariaValueMax', 'ariaValueMin', 'ariaValueNow', 'ariaValueText']) {
    const store = new WeakMap();
    def(ElementInternals.prototype, p, function () { const v = store.get(this); return v === undefined ? null : v; },
      function (v) { store.set(this, v === null || v === undefined ? null : `${v}`); });
  }

  const VALIDITY_KEYS = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow',
    'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
  class ValidityState {
    #get;
    constructor(token, get) { if (token !== INTERNAL) throw L.illegal(); this.#get = get; }
    static { L.validityFlags = (v) => v.#get(); }
    get valid() { const f = this.#get(); return !VALIDITY_KEYS.some((k) => f[k]); }
  }
  for (const k of VALIDITY_KEYS) def(ValidityState.prototype, k, function () { return !!L.validityFlags(this)[k]; });

  // ---------------------------------------------------------------------------------------
  // SVG / MathML
  // ---------------------------------------------------------------------------------------
  class SVGElement extends Element { constructor() { throw L.illegal(); } }
  class SVGAnimatedString {
    #el; #attr;
    constructor(token, el, attr) { if (token !== INTERNAL) throw L.illegal(); this.#el = el; this.#attr = attr; }
    get baseVal() { return attrOrEmpty(this.#el, this.#attr); }
    set baseVal(v) { setAttr(this.#el, idOf(this.#el), this.#attr, `${v}`); }
    get animVal() { return attrOrEmpty(this.#el, this.#attr); }
  }
  const animStrCache = new WeakMap();
  function animatedString(el, attr) {
    let m = animStrCache.get(el);
    if (m === undefined) { m = new Map(); animStrCache.set(el, m); }
    let s = m.get(attr);
    if (s === undefined) { s = new SVGAnimatedString(INTERNAL, el, attr); m.set(attr, s); }
    return s;
  }
  class SVGLength {
    #get; #set;
    constructor(token, get, set) { if (token !== INTERNAL) throw L.illegal(); this.#get = get; this.#set = set; }
    get value() { const v = this.#get(); const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
    set value(v) { this.#set(String(+v)); }
    get valueInSpecifiedUnits() { return this.value; }
    get valueAsString() { return this.#get() || '0'; }
    set valueAsString(v) { this.#set(`${v}`); }
    get unitType() { const s = this.#get(); if (/%$/.test(s)) return 2; if (/px$/.test(s)) return 5; return 1; }
    newValueSpecifiedUnits(t, v) { this.#set(String(+v)); }
    convertToSpecifiedUnits() { }
  }
  L.defineConstants([SVGLength, SVGLength.prototype], { SVG_LENGTHTYPE_UNKNOWN: 0, SVG_LENGTHTYPE_NUMBER: 1, SVG_LENGTHTYPE_PERCENTAGE: 2, SVG_LENGTHTYPE_EMS: 3, SVG_LENGTHTYPE_EXS: 4, SVG_LENGTHTYPE_PX: 5, SVG_LENGTHTYPE_CM: 6, SVG_LENGTHTYPE_MM: 7, SVG_LENGTHTYPE_IN: 8, SVG_LENGTHTYPE_PT: 9, SVG_LENGTHTYPE_PC: 10 });
  class SVGAnimatedLength {
    #len;
    constructor(token, len) { if (token !== INTERNAL) throw L.illegal(); this.#len = len; }
    get baseVal() { return this.#len; }
    get animVal() { return this.#len; }
  }
  function svgLengthProp(proto, prop, attr) {
    const cache = new WeakMap();
    def(proto, prop, function () {
      let v = cache.get(this);
      if (v === undefined) {
        const el = this;
        v = new SVGAnimatedLength(INTERNAL, new SVGLength(INTERNAL, () => attrOrEmpty(el, attr), (s) => setAttr(el, idOf(el), attr, s)));
        cache.set(this, v);
      }
      return v;
    });
  }
  class SVGAnimatedRect {
    #el;
    constructor(token, el) { if (token !== INTERNAL) throw L.illegal(); this.#el = el; }
    get baseVal() {
      const v = (N.getAttr(idOf(this.#el), 'viewBox') || '').trim().split(/[\s,]+/).map(Number);
      if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return new L.DOMRect(0, 0, 0, 0);
      return new L.DOMRect(v[0], v[1], v[2], v[3]);
    }
    get animVal() { return this.baseVal; }
  }
  class SVGAnimatedTransformList {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get baseVal() { return { numberOfItems: 0, length: 0, getItem() { throw new DOMException('', 'IndexSizeError'); }, consolidate() { return null; }, clear() { }, initialize(t) { return t; }, appendItem(t) { return t; }, createSVGTransformFromMatrix(m) { return { type: 1, matrix: m, angle: 0 }; } }; }
    get animVal() { return this.baseVal; }
  }
  const svgCommon = {
    get className() { return animatedString(this, 'class'); },
    get dataset() { return L.dataset(this); },
    get style() { return L.inlineStyle(this); },
    set style(v) { L.inlineStyle(this).cssText = v; },
    get tabIndex() {
      const v = N.getAttr(idOf(this), 'tabindex');
      if (v !== null) { const n = parseInteger(v); if (n !== null) return n; }
      return lnOf(this) === 'a' && (N.hasAttr(idOf(this), 'href') || N.hasAttr(idOf(this), 'xlink:href')) ? 0 : -1;
    },
    set tabIndex(v) { setAttr(this, idOf(this), 'tabindex', String(L.toLong(v))); },
    get autofocus() { return N.hasAttr(idOf(this), 'autofocus'); },
    set autofocus(v) { if (v) setAttr(this, idOf(this), 'autofocus', ''); else removeAttr(this, idOf(this), 'autofocus'); },
    get nonce() { return attrOrEmpty(this, 'nonce'); },
    set nonce(v) { setAttr(this, idOf(this), 'nonce', `${v}`); },
    focus(options) { focusElement(this, options); },
    blur() { blurElement(this); },
  };
  L.mixin(SVGElement.prototype, svgCommon);
  L.mixin(SVGElement.prototype, {
    get ownerSVGElement() {
      for (let p = N.parent(idOf(this)); p !== 0 && N.nodeType(p) === 1; p = N.parent(p)) {
        if (N.localName(p) === 'svg' && N.namespaceURI(p) === L.NS.SVG) return wrap(p);
      }
      return null;
    },
    get viewportElement() { return this.ownerSVGElement; },
  });
  L.defineEventHandlers(SVGElement.prototype, L.GLOBAL_HANDLERS);
  class SVGGraphicsElement extends SVGElement { }
  const transformLists = new WeakMap();
  L.mixin(SVGGraphicsElement.prototype, {
    getBBox() {
      L.flushSheets();
      const r = N.getBoundingClientRect(idOf(this));
      const svg = this.ownerSVGElement;
      if (svg !== null && svg !== this) {
        const sr = N.getBoundingClientRect(idOf(svg));
        return new L.DOMRect(r[0] - sr[0], r[1] - sr[1], r[2], r[3]);
      }
      return new L.DOMRect(0, 0, r[2], r[3]);
    },
    getCTM() { return new L.DOMMatrix(); },
    getScreenCTM() {
      L.flushSheets();
      const svg = lnOf(this) === 'svg' ? this : this.ownerSVGElement;
      const r = N.getBoundingClientRect(idOf(svg || this));
      return new L.DOMMatrix([1, 0, 0, 1, r[0], r[1]]);
    },
    get transform() {
      let t = transformLists.get(this);
      if (t === undefined) { t = new SVGAnimatedTransformList(INTERNAL); transformLists.set(this, t); }
      return t;
    },
    get nearestViewportElement() { return this.ownerSVGElement; },
    get farthestViewportElement() {
      let last = null;
      for (let p = N.parent(idOf(this)); p !== 0 && N.nodeType(p) === 1; p = N.parent(p)) {
        if (N.localName(p) === 'svg' && N.namespaceURI(p) === L.NS.SVG) last = p;
      }
      return wrap(last || 0);
    },
    get requiredExtensions() { return L.tokenList(this, 'requiredextensions'); },
    get systemLanguage() { return L.tokenList(this, 'systemlanguage'); },
  });
  class SVGGeometryElement extends SVGGraphicsElement { }
  function num(el, a) { const v = parseFloat(N.getAttr(idOf(el), a) || '0'); return Number.isFinite(v) ? v : 0; }
  function pathLength(d) {
    // Approximate total length of an SVG path (lines exact, curves flattened)
    const toks = `${d}`.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, len = 0;
    const n = () => parseFloat(toks[i++]);
    const flat = (pts) => { let px = x, py = y; for (const [qx, qy] of pts) { len += Math.hypot(qx - px, qy - py); px = qx; py = qy; } };
    const bez = (x1, y1, x2, y2, x3, y3) => {
      const pts = [];
      for (let t = 1; t <= 16; t++) {
        const s = t / 16, u = 1 - s;
        pts.push([u * u * u * x + 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s * x3, u * u * u * y + 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s * y3]);
      }
      flat(pts);
    };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? x : 0, oy = rel ? y : 0;
      switch (cmd.toUpperCase()) {
        case 'M': x = ox + n(); y = oy + n(); sx = x; sy = y; cmd = rel ? 'l' : 'L'; break;
        case 'L': { const nx = ox + n(), ny = oy + n(); len += Math.hypot(nx - x, ny - y); x = nx; y = ny; break; }
        case 'H': { const nx = ox + n(); len += Math.abs(nx - x); x = nx; break; }
        case 'V': { const ny = oy + n(); len += Math.abs(ny - y); y = ny; break; }
        case 'C': { const a = [ox + n(), oy + n(), ox + n(), oy + n(), ox + n(), oy + n()]; bez(...a); x = a[4]; y = a[5]; break; }
        case 'S': case 'Q': { const a = [ox + n(), oy + n(), ox + n(), oy + n()]; bez(a[0], a[1], a[0], a[1], a[2], a[3]); x = a[2]; y = a[3]; break; }
        case 'T': { const nx = ox + n(), ny = oy + n(); len += Math.hypot(nx - x, ny - y); x = nx; y = ny; break; }
        case 'A': { n(); n(); n(); n(); n(); const nx = ox + n(), ny = oy + n(); len += Math.hypot(nx - x, ny - y) * 1.1; x = nx; y = ny; break; }
        case 'Z': len += Math.hypot(sx - x, sy - y); x = sx; y = sy; if (i < toks.length && !/[a-zA-Z]/.test(toks[i])) i++; break;
        default: i++;
      }
    }
    return len;
  }
  L.mixin(SVGGeometryElement.prototype, {
    getTotalLength() {
      switch (lnOf(this)) {
        case 'path': return pathLength(N.getAttr(idOf(this), 'd') || '');
        case 'line': return Math.hypot(num(this, 'x2') - num(this, 'x1'), num(this, 'y2') - num(this, 'y1'));
        case 'rect': return 2 * (num(this, 'width') + num(this, 'height'));
        case 'circle': return 2 * Math.PI * num(this, 'r');
        case 'ellipse': { const a = num(this, 'rx'), b = num(this, 'ry'); return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); }
        case 'polyline': case 'polygon': {
          const p = (N.getAttr(idOf(this), 'points') || '').trim().split(/[\s,]+/).map(Number);
          let l = 0;
          for (let i = 2; i + 1 < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
          if (lnOf(this) === 'polygon' && p.length >= 4) l += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
          return l;
        }
        default: return 0;
      }
    },
    getPointAtLength(d) { return new L.DOMPoint(0, 0); },
    isPointInFill() { return false; },
    isPointInStroke() { return false; },
    get pathLength() { return { baseVal: num(this, 'pathLength'), animVal: num(this, 'pathLength') }; },
  });
  class SVGSVGElement extends SVGGraphicsElement { }
  const viewBoxCache = new WeakMap();
  L.mixin(SVGSVGElement.prototype, {
    createSVGPoint() { return new L.DOMPoint(); },
    createSVGMatrix() { return new L.DOMMatrix(); },
    createSVGRect() { return new L.DOMRect(); },
    createSVGNumber() { return { value: 0 }; },
    createSVGAngle() { return { value: 0, unitType: 1, valueInSpecifiedUnits: 0, valueAsString: '0' }; },
    createSVGLength() { let v = '0'; return new SVGLength(INTERNAL, () => v, (s) => { v = s; }); },
    createSVGTransform() { return { type: 1, matrix: new L.DOMMatrix(), angle: 0, setMatrix() { }, setTranslate() { }, setScale() { }, setRotate() { }, setSkewX() { }, setSkewY() { } }; },
    createSVGTransformFromMatrix(m) { return { type: 1, matrix: m, angle: 0 }; },
    get viewBox() {
      let v = viewBoxCache.get(this);
      if (v === undefined) { v = new SVGAnimatedRect(INTERNAL, this); viewBoxCache.set(this, v); }
      return v;
    },
    get currentScale() { return 1; }, set currentScale(v) { },
    get currentTranslate() { return new L.DOMPoint(); },
    pauseAnimations() { }, unpauseAnimations() { }, animationsPaused() { return false; },
    getCurrentTime() { return 0; }, setCurrentTime() { },
    suspendRedraw() { return 1; }, unsuspendRedraw() { }, unsuspendRedrawAll() { }, forceRedraw() { },
    getIntersectionList() { return L.staticNodeList([]); }, getEnclosureList() { return L.staticNodeList([]); },
    checkIntersection() { return false; }, checkEnclosure() { return false; }, deselectAll() { },
    getElementById(id) { return wrap(N.querySelector(idOf(this), '#' + L.cssEscape(`${id}`))); },
  });
  for (const p of ['x', 'y', 'width', 'height']) svgLengthProp(SVGSVGElement.prototype, p, p);
  const svgClasses = new Map();
  function svgClass(name, Base, tags, lengths) {
    const C = { [name]: class extends Base { } }[name];
    for (const t of tags) svgClasses.set(t, C);
    if (lengths) for (const p of lengths) svgLengthProp(C.prototype, p, p);
    L.expose(name, C);
    return C;
  }
  svgClasses.set('svg', SVGSVGElement);
  const SVGGElement = svgClass('SVGGElement', SVGGraphicsElement, ['g']);
  svgClass('SVGDefsElement', SVGGraphicsElement, ['defs']);
  svgClass('SVGPathElement', SVGGeometryElement, ['path']);
  svgClass('SVGRectElement', SVGGeometryElement, ['rect'], ['x', 'y', 'width', 'height', 'rx', 'ry']);
  svgClass('SVGCircleElement', SVGGeometryElement, ['circle'], ['cx', 'cy', 'r']);
  svgClass('SVGEllipseElement', SVGGeometryElement, ['ellipse'], ['cx', 'cy', 'rx', 'ry']);
  svgClass('SVGLineElement', SVGGeometryElement, ['line'], ['x1', 'y1', 'x2', 'y2']);
  svgClass('SVGPolylineElement', SVGGeometryElement, ['polyline']);
  svgClass('SVGPolygonElement', SVGGeometryElement, ['polygon']);
  const SVGTextContentElement = svgClass('SVGTextContentElement', SVGGraphicsElement, []);
  L.mixin(SVGTextContentElement.prototype, {
    getNumberOfChars() { return (this.textContent || '').length; },
    getComputedTextLength() { L.flushSheets(); return N.getBoundingClientRect(idOf(this))[2]; },
    getSubStringLength(a, n) { const t = (this.textContent || '').length || 1; return this.getComputedTextLength() * Math.min(n, t) / t; },
    getStartPositionOfChar() { return new L.DOMPoint(); },
    getEndPositionOfChar() { return new L.DOMPoint(); },
    getExtentOfChar() { return new L.DOMRect(); },
    getRotationOfChar() { return 0; },
    getCharNumAtPosition() { return -1; },
    selectSubString() { },
  });
  const SVGTextPositioningElement = svgClass('SVGTextPositioningElement', SVGTextContentElement, []);
  svgClass('SVGTextElement', SVGTextPositioningElement, ['text']);
  svgClass('SVGTSpanElement', SVGTextPositioningElement, ['tspan']);
  svgClass('SVGTextPathElement', SVGTextContentElement, ['textPath']);
  const SVGUseElement = svgClass('SVGUseElement', SVGGraphicsElement, ['use'], ['x', 'y', 'width', 'height']);
  def(SVGUseElement.prototype, 'href', function () { return animatedString(this, N.hasAttr(idOf(this), 'href') ? 'href' : 'xlink:href'); });
  svgClass('SVGSymbolElement', SVGElement, ['symbol']);
  svgClass('SVGImageElement', SVGGraphicsElement, ['image'], ['x', 'y', 'width', 'height']);
  svgClass('SVGForeignObjectElement', SVGGraphicsElement, ['foreignObject'], ['x', 'y', 'width', 'height']);
  svgClass('SVGSwitchElement', SVGGraphicsElement, ['switch']);
  const SVGAElement = svgClass('SVGAElement', SVGGraphicsElement, ['a']);
  def(SVGAElement.prototype, 'href', function () { return animatedString(this, N.hasAttr(idOf(this), 'href') ? 'href' : 'xlink:href'); });
  def(SVGAElement.prototype, 'target', function () { return animatedString(this, 'target'); });
  svgClass('SVGClipPathElement', SVGElement, ['clipPath']);
  svgClass('SVGMaskElement', SVGElement, ['mask'], ['x', 'y', 'width', 'height']);
  svgClass('SVGPatternElement', SVGElement, ['pattern'], ['x', 'y', 'width', 'height']);
  const SVGGradientElement = svgClass('SVGGradientElement', SVGElement, []);
  svgClass('SVGLinearGradientElement', SVGGradientElement, ['linearGradient'], ['x1', 'y1', 'x2', 'y2']);
  svgClass('SVGRadialGradientElement', SVGGradientElement, ['radialGradient'], ['cx', 'cy', 'r', 'fx', 'fy', 'fr']);
  svgClass('SVGStopElement', SVGElement, ['stop']);
  svgClass('SVGTitleElement', SVGElement, ['title']);
  svgClass('SVGDescElement', SVGElement, ['desc']);
  svgClass('SVGMetadataElement', SVGElement, ['metadata']);
  svgClass('SVGMarkerElement', SVGElement, ['marker']);
  const SVGStyleElement = svgClass('SVGStyleElement', SVGElement, ['style']);
  def(SVGStyleElement.prototype, 'sheet', function () { return N.isConnected(idOf(this)) ? L.sheetFor(this, false) : null; });
  svgClass('SVGScriptElement', SVGElement, ['script']);
  svgClass('SVGViewElement', SVGElement, ['view']);
  svgClass('SVGFilterElement', SVGElement, ['filter'], ['x', 'y', 'width', 'height']);
  const SVGAnimationElement = svgClass('SVGAnimationElement', SVGElement, []);
  L.mixin(SVGAnimationElement.prototype, { beginElement() { }, endElement() { }, beginElementAt() { }, endElementAt() { }, getStartTime() { return 0; }, getCurrentTime() { return 0; }, getSimpleDuration() { return 0; }, get targetElement() { return this.parentElement; } });
  svgClass('SVGAnimateElement', SVGAnimationElement, ['animate']);
  svgClass('SVGAnimateMotionElement', SVGAnimationElement, ['animateMotion']);
  svgClass('SVGAnimateTransformElement', SVGAnimationElement, ['animateTransform']);
  svgClass('SVGSetElement', SVGAnimationElement, ['set']);
  svgClass('SVGMPathElement', SVGElement, ['mpath']);
  for (const f of ['feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting',
    'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR',
    'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight',
    'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence']) {
    svgClass('SVG' + f[0].toUpperCase() + f.slice(1) + 'Element', SVGElement, [f]);
  }
  void SVGGElement;

  class MathMLElement extends Element { constructor() { throw L.illegal(); } }
  L.mixin(MathMLElement.prototype, svgCommon);
  delete MathMLElement.prototype.className;
  L.defineEventHandlers(MathMLElement.prototype, L.GLOBAL_HANDLERS);

  // ---------------------------------------------------------------------------------------
  // HTML element classes
  // ---------------------------------------------------------------------------------------
  const htmlClasses = new Map();
  const exposedHTML = { HTMLElement };
  function htmlClass(name, tags, Base) {
    const B = Base || HTMLElement;
    const C = { [name]: class extends B { constructor() { return htmlElementConstruct(new.target, C); } } }[name];
    for (const t of tags) htmlClasses.set(t, C);
    exposedHTML[name] = C;
    return C;
  }
  for (const t of ['abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'cite', 'code', 'dd', 'dfn', 'dt', 'em',
    'figcaption', 'figure', 'footer', 'header', 'hgroup', 'i', 'kbd', 'main', 'mark', 'nav', 'noscript', 'rp', 'rt',
    'ruby', 's', 'samp', 'search', 'section', 'small', 'strong', 'sub', 'summary', 'sup', 'u', 'var', 'wbr',
    'acronym', 'basefont', 'big', 'center', 'nobr', 'noembed', 'noframes', 'plaintext', 'rb', 'rtc', 'strike', 'tt']) {
    htmlClasses.set(t, HTMLElement);
  }
  const HTMLUnknownElement = htmlClass('HTMLUnknownElement', ['applet', 'bgsound', 'blink', 'isindex', 'keygen', 'multicol', 'nextid', 'spacer']);
  L.HTMLUnknownElement = HTMLUnknownElement;

  L.elementProtoFor = function (ln, ns) {
    if (ns === HTML) {
      const C = htmlClasses.get(ln);
      if (C !== undefined) return C.prototype;
      return L.isValidCEName(ln) ? HTMLElement.prototype : HTMLUnknownElement.prototype;
    }
    if (ns === SVG) {
      const C = svgClasses.get(ln);
      return (C || SVGElement).prototype;
    }
    if (ns === 2) return MathMLElement.prototype;
    return Element.prototype;
  };

  // --- simple classes with reflected attributes ---
  const HTMLHtmlElement = htmlClass('HTMLHtmlElement', ['html']);
  R.str(HTMLHtmlElement.prototype, 'version');
  htmlClass('HTMLHeadElement', ['head']);
  const HTMLTitleElement = htmlClass('HTMLTitleElement', ['title']);
  def(HTMLTitleElement.prototype, 'text', function () { return L.textContentGet(this); }, function (v) { L.textContentSet(this, v); });
  const HTMLBaseElement = htmlClass('HTMLBaseElement', ['base']);
  def(HTMLBaseElement.prototype, 'href', function () {
    const v = N.getAttr(idOf(this), 'href');
    const p = N.urlParse(v === null ? '' : v, L.documentURL());
    return p === null ? (v || '') : p[0];
  }, function (v) { setAttr(this, idOf(this), 'href', `${v}`); });
  R.str(HTMLBaseElement.prototype, 'target');
  const HTMLMetaElement = htmlClass('HTMLMetaElement', ['meta']);
  R.str(HTMLMetaElement.prototype, 'name');
  R.str(HTMLMetaElement.prototype, 'httpEquiv', 'http-equiv');
  R.str(HTMLMetaElement.prototype, 'content');
  R.str(HTMLMetaElement.prototype, 'media');
  R.str(HTMLMetaElement.prototype, 'scheme');
  const HTMLBodyElement = htmlClass('HTMLBodyElement', ['body']);
  for (const [p, a] of [['text', 'text'], ['link', 'link'], ['vLink', 'vlink'], ['aLink', 'alink'], ['bgColor', 'bgcolor'], ['background', 'background']]) R.str(HTMLBodyElement.prototype, p, a);
  const bodyTarget = (el) => (L.isBodyOfDocument(el) ? L.window : el);
  L.defineEventHandlers(HTMLBodyElement.prototype, L.BODY_FORWARDED, bodyTarget);
  const HTMLFrameSetElement = htmlClass('HTMLFrameSetElement', ['frameset']);
  R.str(HTMLFrameSetElement.prototype, 'cols');
  R.str(HTMLFrameSetElement.prototype, 'rows');
  L.defineEventHandlers(HTMLFrameSetElement.prototype, L.BODY_FORWARDED, bodyTarget);
  const HTMLHeadingElement = htmlClass('HTMLHeadingElement', ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  R.str(HTMLHeadingElement.prototype, 'align');
  const HTMLParagraphElement = htmlClass('HTMLParagraphElement', ['p']);
  R.str(HTMLParagraphElement.prototype, 'align');
  const HTMLHRElement = htmlClass('HTMLHRElement', ['hr']);
  R.str(HTMLHRElement.prototype, 'align'); R.str(HTMLHRElement.prototype, 'color'); R.bool(HTMLHRElement.prototype, 'noShade', 'noshade');
  R.str(HTMLHRElement.prototype, 'size'); R.str(HTMLHRElement.prototype, 'width');
  const HTMLPreElement = htmlClass('HTMLPreElement', ['pre', 'listing', 'xmp']);
  R.long(HTMLPreElement.prototype, 'width');
  const HTMLQuoteElement = htmlClass('HTMLQuoteElement', ['blockquote', 'q']);
  R.url(HTMLQuoteElement.prototype, 'cite');
  const HTMLOListElement = htmlClass('HTMLOListElement', ['ol']);
  R.bool(HTMLOListElement.prototype, 'reversed'); R.long(HTMLOListElement.prototype, 'start', 'start', 1);
  R.str(HTMLOListElement.prototype, 'type'); R.bool(HTMLOListElement.prototype, 'compact');
  const HTMLUListElement = htmlClass('HTMLUListElement', ['ul']);
  R.bool(HTMLUListElement.prototype, 'compact'); R.str(HTMLUListElement.prototype, 'type');
  const HTMLMenuElement = htmlClass('HTMLMenuElement', ['menu']);
  R.bool(HTMLMenuElement.prototype, 'compact');
  const HTMLDirectoryElement = htmlClass('HTMLDirectoryElement', ['dir']);
  R.bool(HTMLDirectoryElement.prototype, 'compact');
  const HTMLLIElement = htmlClass('HTMLLIElement', ['li']);
  R.long(HTMLLIElement.prototype, 'value'); R.str(HTMLLIElement.prototype, 'type');
  const HTMLDListElement = htmlClass('HTMLDListElement', ['dl']);
  R.bool(HTMLDListElement.prototype, 'compact');
  const HTMLDivElement = htmlClass('HTMLDivElement', ['div']);
  R.str(HTMLDivElement.prototype, 'align');
  const HTMLDataElement = htmlClass('HTMLDataElement', ['data']);
  R.str(HTMLDataElement.prototype, 'value');
  const HTMLTimeElement = htmlClass('HTMLTimeElement', ['time']);
  R.str(HTMLTimeElement.prototype, 'dateTime', 'datetime');
  htmlClass('HTMLSpanElement', ['span']);
  const HTMLBRElement = htmlClass('HTMLBRElement', ['br']);
  R.str(HTMLBRElement.prototype, 'clear');
  const HTMLModElement = htmlClass('HTMLModElement', ['ins', 'del']);
  R.url(HTMLModElement.prototype, 'cite'); R.str(HTMLModElement.prototype, 'dateTime', 'datetime');
  htmlClass('HTMLPictureElement', ['picture']);
  const HTMLSourceElement = htmlClass('HTMLSourceElement', ['source']);
  R.url(HTMLSourceElement.prototype, 'src'); R.str(HTMLSourceElement.prototype, 'type'); R.str(HTMLSourceElement.prototype, 'srcset');
  R.str(HTMLSourceElement.prototype, 'sizes'); R.str(HTMLSourceElement.prototype, 'media');
  R.ulong(HTMLSourceElement.prototype, 'width'); R.ulong(HTMLSourceElement.prototype, 'height');
  const HTMLTrackElement = htmlClass('HTMLTrackElement', ['track']);
  R.enumerated(HTMLTrackElement.prototype, 'kind', 'kind', ['subtitles', 'captions', 'descriptions', 'chapters', 'metadata'], 'subtitles', 'metadata');
  R.url(HTMLTrackElement.prototype, 'src'); R.str(HTMLTrackElement.prototype, 'srclang'); R.str(HTMLTrackElement.prototype, 'label');
  R.bool(HTMLTrackElement.prototype, 'default');
  def(HTMLTrackElement.prototype, 'readyState', function () { return 0; });
  def(HTMLTrackElement.prototype, 'track', function () { return null; });
  L.defineConstants([HTMLTrackElement, HTMLTrackElement.prototype], { NONE: 0, LOADING: 1, LOADED: 2, ERROR: 3 });
  const HTMLFontElement = htmlClass('HTMLFontElement', ['font']);
  R.str(HTMLFontElement.prototype, 'color'); R.str(HTMLFontElement.prototype, 'face'); R.str(HTMLFontElement.prototype, 'size');
  const HTMLParamElement = htmlClass('HTMLParamElement', ['param']);
  R.str(HTMLParamElement.prototype, 'name'); R.str(HTMLParamElement.prototype, 'value'); R.str(HTMLParamElement.prototype, 'type'); R.str(HTMLParamElement.prototype, 'valueType', 'valuetype');
  const HTMLMarqueeElement = htmlClass('HTMLMarqueeElement', ['marquee']);
  for (const p of ['behavior', 'bgColor', 'direction', 'height', 'width']) R.str(HTMLMarqueeElement.prototype, p, p.toLowerCase());
  for (const p of ['hspace', 'vspace', 'scrollAmount', 'scrollDelay']) R.ulong(HTMLMarqueeElement.prototype, p, p.toLowerCase());
  R.long(HTMLMarqueeElement.prototype, 'loop', 'loop', -1); R.bool(HTMLMarqueeElement.prototype, 'trueSpeed', 'truespeed');
  L.mixin(HTMLMarqueeElement.prototype, { start() { }, stop() { } });
  const HTMLSlotElement = htmlClass('HTMLSlotElement', ['slot']);
  R.str(HTMLSlotElement.prototype, 'name');
  L.mixin(HTMLSlotElement.prototype, {
    assignedNodes(options) { return L.wrapAll(N.childIds(idOf(this))); },
    assignedElements(options) { return L.wrapAll(N.childElementIds(idOf(this))); },
    assign() { },
  });
  const HTMLMapElement = htmlClass('HTMLMapElement', ['map']);
  R.str(HTMLMapElement.prototype, 'name');
  def(HTMLMapElement.prototype, 'areas', function () { return L.queryCollection(idOf(this), 'area', true); });

  // --- hyperlinks (a, area) ---
  const HyperlinkUtils = {
    get href() {
      const v = N.getAttr(idOf(this), 'href');
      if (v === null) return '';
      const r = L.resolveURL(v);
      return r === null ? v : r;
    },
    set href(v) { setAttr(this, idOf(this), 'href', L.toUSV(v)); },
    toString() { return this.href; },
    get origin() { const p = hrefParts(this); return p === null ? '' : p[10]; },
    get protocol() { const p = hrefParts(this); return p === null ? ':' : p[1]; },
    set protocol(v) { setURLPart(this, 'protocol', v); },
    get username() { const p = hrefParts(this); return p === null ? '' : p[2]; },
    set username(v) { setURLPart(this, 'username', v); },
    get password() { const p = hrefParts(this); return p === null ? '' : p[3]; },
    set password(v) { setURLPart(this, 'password', v); },
    get host() { const p = hrefParts(this); return p === null ? '' : p[4]; },
    set host(v) { setURLPart(this, 'host', v); },
    get hostname() { const p = hrefParts(this); return p === null ? '' : p[5]; },
    set hostname(v) { setURLPart(this, 'hostname', v); },
    get port() { const p = hrefParts(this); return p === null ? '' : p[6]; },
    set port(v) { setURLPart(this, 'port', v); },
    get pathname() { const p = hrefParts(this); return p === null ? '' : p[7]; },
    set pathname(v) { setURLPart(this, 'pathname', v); },
    get search() { const p = hrefParts(this); return p === null ? '' : p[8]; },
    set search(v) { setURLPart(this, 'search', v); },
    get hash() { const p = hrefParts(this); return p === null ? '' : p[9]; },
    set hash(v) { setURLPart(this, 'hash', v); },
  };
  function hrefParts(el) {
    const v = N.getAttr(idOf(el), 'href');
    if (v === null) return null;
    return N.urlParse(v, L.baseURL());
  }
  function setURLPart(el, part, value) {
    const p = hrefParts(el);
    if (p === null) return;
    const u = new L.URL(p[0]);
    u[part] = value;
    setAttr(el, idOf(el), 'href', u.href);
  }
  const HTMLAnchorElement = htmlClass('HTMLAnchorElement', ['a']);
  const HTMLAreaElement = htmlClass('HTMLAreaElement', ['area']);
  const REL_SUPPORTED_A = ['noreferrer', 'noopener', 'opener'];
  for (const C of [HTMLAnchorElement, HTMLAreaElement]) {
    L.mixin(C.prototype, HyperlinkUtils);
    const P = C.prototype;
    R.str(P, 'target'); R.str(P, 'download'); R.str(P, 'ping'); R.str(P, 'rel');
    R.tokens(P, 'relList', 'rel', REL_SUPPORTED_A);
    R.referrerPolicy(P);
  }
  for (const p of ['hreflang', 'type', 'charset', 'coords', 'name', 'rev', 'shape']) R.str(HTMLAnchorElement.prototype, p);
  def(HTMLAnchorElement.prototype, 'text', function () { return L.textContentGet(this); }, function (v) { L.textContentSet(this, v); });
  R.str(HTMLAreaElement.prototype, 'alt'); R.str(HTMLAreaElement.prototype, 'coords'); R.str(HTMLAreaElement.prototype, 'shape');
  R.bool(HTMLAreaElement.prototype, 'noHref', 'nohref');

  // --- iframe / embed / object / frame ---
  const HTMLIFrameElement = htmlClass('HTMLIFrameElement', ['iframe']);
  {
    const P = HTMLIFrameElement.prototype;
    R.url(P, 'src'); R.str(P, 'srcdoc'); R.str(P, 'name'); R.str(P, 'allow'); R.bool(P, 'allowFullscreen', 'allowfullscreen');
    R.bool(P, 'allowPaymentRequest', 'allowpaymentrequest'); R.str(P, 'width'); R.str(P, 'height'); R.referrerPolicy(P);
    R.enumerated(P, 'loading', 'loading', ['lazy', 'eager'], 'eager', 'eager');
    R.tokens(P, 'sandbox', 'sandbox', ['allow-downloads', 'allow-forms', 'allow-modals', 'allow-orientation-lock', 'allow-pointer-lock', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-presentation', 'allow-same-origin', 'allow-scripts', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols', 'allow-storage-access-by-user-activation']);
    for (const p of ['align', 'scrolling', 'frameBorder', 'marginHeight', 'marginWidth']) R.str(P, p, p.toLowerCase());
    R.url(P, 'longDesc', 'longdesc');
    R.bool(P, 'credentialless');
    def(P, 'contentDocument', function () { return null; });
    def(P, 'contentWindow', function () { return L.iframeWindow(this, idOf(this)); });
    L.mixin(P, { getSVGDocument() { return null; } });
    def(P, 'featurePolicy', function () { return undefined; });
  }
  const HTMLFrameElement = htmlClass('HTMLFrameElement', ['frame']);
  {
    const P = HTMLFrameElement.prototype;
    R.str(P, 'name'); R.str(P, 'scrolling'); R.url(P, 'src'); R.str(P, 'frameBorder', 'frameborder'); R.url(P, 'longDesc', 'longdesc');
    R.bool(P, 'noResize', 'noresize'); R.str(P, 'marginHeight', 'marginheight'); R.str(P, 'marginWidth', 'marginwidth');
    def(P, 'contentDocument', function () { return null; });
    def(P, 'contentWindow', function () { return null; });
  }
  const HTMLEmbedElement = htmlClass('HTMLEmbedElement', ['embed']);
  {
    const P = HTMLEmbedElement.prototype;
    R.url(P, 'src'); R.str(P, 'type'); R.str(P, 'width'); R.str(P, 'height'); R.str(P, 'align'); R.str(P, 'name');
    L.mixin(P, { getSVGDocument() { return null; } });
  }
  const HTMLObjectElement = htmlClass('HTMLObjectElement', ['object']);
  {
    const P = HTMLObjectElement.prototype;
    R.url(P, 'data'); R.str(P, 'type'); R.str(P, 'name'); R.str(P, 'useMap', 'usemap'); R.str(P, 'width'); R.str(P, 'height');
    for (const p of ['align', 'archive', 'code', 'codeType', 'standby', 'border']) R.str(P, p, p.toLowerCase());
    R.url(P, 'codeBase', 'codebase'); R.bool(P, 'declare'); R.ulong(P, 'hspace'); R.ulong(P, 'vspace');
    def(P, 'contentDocument', function () { return null; });
    def(P, 'contentWindow', function () { return null; });
    def(P, 'form', function () { return formOwnerOf(this); });
    L.mixin(P, { getSVGDocument() { return null; } });
  }

  // --- script ---
  const HTMLScriptElement = htmlClass('HTMLScriptElement', ['script']);
  {
    const P = HTMLScriptElement.prototype;
    R.url(P, 'src'); R.str(P, 'type'); R.bool(P, 'noModule', 'nomodule'); R.bool(P, 'defer');
    R.crossOrigin(P); R.str(P, 'charset'); R.str(P, 'event'); R.str(P, 'htmlFor', 'for'); R.str(P, 'integrity');
    R.referrerPolicy(P); R.str(P, 'fetchPriority', 'fetchpriority'); R.tokens(P, 'blocking', 'blocking', ['render']);
    R.str(P, 'attributionSrc', 'attributionsrc');
    def(P, 'async', function () {
      const id = idOf(this);
      return N.hasAttr(id, 'async') || L.forceAsync.has(id);
    }, function (v) {
      const id = idOf(this);
      L.forceAsync.delete(id);
      if (v) setAttr(this, id, 'async', ''); else removeAttr(this, id, 'async');
    });
    def(P, 'text', function () {
      let s = '';
      for (let c = N.firstChild(idOf(this)); c !== 0; c = N.nextSibling(c)) if (N.nodeType(c) === 3) s += N.getText(c);
      return s;
    }, function (v) { L.textContentSet(this, v); });
    HTMLScriptElement.supports = function supports(type) {
      const t = `${type}`;
      return t === 'classic' || t === 'module' || t === 'importmap' || t === 'speculationrules';
    };
  }
  L.addAttrHook('src', (w, id, name, old, value) => {
    if (lnOf(w) === 'script' && value !== null && L.pendingScripts.has(id) && L.scriptChildrenChanged !== null && N.isConnected(id)) {
      L.scriptChildrenChanged(id);
    }
    if (lnOf(w) === 'img' && nsOf(w) === HTML) imageSrcChanged(w, value);
  });

  // --- link / style ---
  const HTMLLinkElement = htmlClass('HTMLLinkElement', ['link']);
  {
    const P = HTMLLinkElement.prototype;
    R.url(P, 'href'); R.crossOrigin(P); R.str(P, 'rel'); R.str(P, 'as'); R.str(P, 'media'); R.str(P, 'integrity');
    R.str(P, 'hreflang'); R.str(P, 'type'); R.referrerPolicy(P); R.str(P, 'imageSrcset', 'imagesrcset');
    R.str(P, 'imageSizes', 'imagesizes'); R.str(P, 'charset'); R.str(P, 'rev'); R.str(P, 'target');
    R.str(P, 'fetchPriority', 'fetchpriority'); R.bool(P, 'disabled');
    R.tokens(P, 'relList', 'rel', ['alternate', 'dns-prefetch', 'icon', 'manifest', 'modulepreload', 'next',
      'pingback', 'preconnect', 'prefetch', 'preload', 'prerender', 'search', 'serviceworker', 'stylesheet', 'expect', 'compression-dictionary']);
    R.tokens(P, 'sizes', 'sizes'); R.tokens(P, 'blocking', 'blocking', ['render']);
    def(P, 'sheet', function () {
      const id = idOf(this);
      if (!N.isConnected(id)) return null;
      const rel = (N.getAttr(id, 'rel') || '').toLowerCase();
      if (!/(^|\s)stylesheet(\s|$)/.test(rel)) return null;
      return L.sheetFor(this, true);
    });
  }
  const HTMLStyleElement = htmlClass('HTMLStyleElement', ['style']);
  {
    const P = HTMLStyleElement.prototype;
    R.str(P, 'media'); R.str(P, 'type'); R.tokens(P, 'blocking', 'blocking', ['render']);
    def(P, 'sheet', function () { return N.isConnected(idOf(this)) ? L.sheetFor(this, false) : null; });
    def(P, 'disabled', function () { const s = L.sheetFor(this, false); return s.disabled; }, function (v) { L.sheetFor(this, false).disabled = v; });
  }

  // --- images ---
  const imgState = new WeakMap(); // img -> 'loading' | 'loaded' | 'error'
  const imgWaiters = new WeakMap(); // img -> [fn]
  function imageSrcChanged(w, value) {
    imgState.set(w, value === null || value === '' ? 'empty' : 'loading');
  }
  L.imageEvent = function (el, type) {
    imgState.set(el, type === 'load' ? 'loaded' : 'error');
    const ws = imgWaiters.get(el);
    if (ws !== undefined) { imgWaiters.delete(el); for (const fn of ws) fn(type); }
  };
  function imgComplete(el) {
    const id = idOf(el);
    const src = N.getAttr(id, 'src');
    const srcset = N.getAttr(id, 'srcset');
    if ((src === null || src === '') && (srcset === null || srcset === '')) return true;
    const st = imgState.get(el);
    if (st === 'loaded' || st === 'error' || st === 'empty') return true;
    if (typeof N.imageSize === 'function') {
      const s = N.imageSize(id);
      if (s && s[0] > 0) return true;
    }
    return false;
  }
  function naturalSize(el) {
    const id = idOf(el);
    if (typeof N.imageSize === 'function') {
      const s = N.imageSize(id);
      if (s) return s;
    }
    if (imgState.get(el) === 'loaded') {
      L.flushSheets();
      const r = N.getBoundingClientRect(id);
      return [Math.round(r[2]), Math.round(r[3])];
    }
    return [0, 0];
  }
  const HTMLImageElement = htmlClass('HTMLImageElement', ['img']);
  {
    const P = HTMLImageElement.prototype;
    R.str(P, 'alt'); R.url(P, 'src'); R.str(P, 'srcset'); R.str(P, 'sizes'); R.crossOrigin(P); R.str(P, 'useMap', 'usemap');
    R.bool(P, 'isMap', 'ismap'); R.referrerPolicy(P); R.str(P, 'name'); R.url(P, 'lowsrc'); R.str(P, 'align');
    R.ulong(P, 'hspace'); R.ulong(P, 'vspace'); R.url(P, 'longDesc', 'longdesc'); R.str(P, 'border');
    R.enumerated(P, 'decoding', 'decoding', ['sync', 'async', 'auto'], 'auto', 'auto');
    R.enumerated(P, 'loading', 'loading', ['lazy', 'eager'], 'eager', 'eager');
    R.str(P, 'fetchPriority', 'fetchpriority');
    R.str(P, 'attributionSrc', 'attributionsrc');
    def(P, 'width', function () {
      const v = N.getAttr(idOf(this), 'width');
      if (v !== null) { const n = parseNonNeg(v); if (n !== null) return n; }
      if (N.isConnected(idOf(this))) { L.flushSheets(); const r = N.getBoundingClientRect(idOf(this)); if (r[2] > 0) return Math.round(r[2]); }
      return naturalSize(this)[0];
    }, function (v) { setAttr(this, idOf(this), 'width', String(L.toULong(v))); });
    def(P, 'height', function () {
      const v = N.getAttr(idOf(this), 'height');
      if (v !== null) { const n = parseNonNeg(v); if (n !== null) return n; }
      if (N.isConnected(idOf(this))) { L.flushSheets(); const r = N.getBoundingClientRect(idOf(this)); if (r[3] > 0) return Math.round(r[3]); }
      return naturalSize(this)[1];
    }, function (v) { setAttr(this, idOf(this), 'height', String(L.toULong(v))); });
    def(P, 'naturalWidth', function () { return naturalSize(this)[0]; });
    def(P, 'naturalHeight', function () { return naturalSize(this)[1]; });
    def(P, 'complete', function () { return imgComplete(this); });
    def(P, 'currentSrc', function () {
      if (typeof N.imageCurrentSrc === 'function') { const u = N.imageCurrentSrc(idOf(this)); return u === null ? '' : u; }
      return imgState.get(this) === 'empty' ? '' : this.src;
    });
    def(P, 'x', function () { L.flushSheets(); return N.getBoundingClientRect(idOf(this))[0]; });
    def(P, 'y', function () { L.flushSheets(); return N.getBoundingClientRect(idOf(this))[1]; });
    L.mixin(P, {
      decode() {
        const el = this;
        return L.newPromise((resolve, reject) => {
          const done = (t) => (t === 'load' ? resolve(undefined) : reject(new DOMException('The source image cannot be decoded.', 'EncodingError')));
          const st = imgState.get(el);
          if (st === 'error' || st === 'empty') { done('error'); return; }
          if (imgComplete(el)) { done('load'); return; }
          let ws = imgWaiters.get(el);
          if (ws === undefined) { ws = []; imgWaiters.set(el, ws); }
          ws.push(done);
        });
      },
    });
  }
  const Image = function Image(width, height) {
    if (!new.target) throw new TypeError("Failed to construct 'Image': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const img = L.document.createElement('img');
    if (width !== undefined) img.width = width;
    if (height !== undefined) img.height = height;
    return img;
  };
  Image.prototype = HTMLImageElement.prototype;

  // --- canvas ---
  // The 2D context keeps the drawing state; natives rasterize (see crates/script/src/canvas.rs).
  // Paths are kept in device space (points are transformed when they are added, as the
  // spec's current path is); Path2D objects keep user space and are transformed when used.
  const HTMLCanvasElement = htmlClass('HTMLCanvasElement', ['canvas']);
  const ctxCache = new WeakMap();
  const canvasDim = (id, name, def) => {
    const v = N.getAttr(id, name);
    if (v === null) return def;
    const n = parseNonNeg(v);
    return n === null ? def : n;
  };
  {
    const P = HTMLCanvasElement.prototype;
    def(P, 'width', function () { return canvasDim(idOf(this), 'width', 300); },
      function (v) { setAttr(this, idOf(this), 'width', String(L.toULong(v))); const c = ctxCache.get(this); if (c) L.ctxResize(c); });
    def(P, 'height', function () { return canvasDim(idOf(this), 'height', 150); },
      function (v) { setAttr(this, idOf(this), 'height', String(L.toULong(v))); const c = ctxCache.get(this); if (c) L.ctxResize(c); });
    L.mixin(P, {
      getContext(type, attrs) {
        const t = `${type}`;
        if (t !== '2d') return null;
        let c = ctxCache.get(this);
        if (c === undefined) { c = new CanvasRenderingContext2D(INTERNAL, this, attrs); ctxCache.set(this, c); }
        return c;
      },
      toDataURL(type, quality) {
        const id = idOf(this);
        const c = ctxCache.get(this);
        if (c) L.ctxSync(c);
        const w = canvasDim(id, 'width', 300), h = canvasDim(id, 'height', 150);
        if (w === 0 || h === 0) return 'data:,';
        return N.canvasToDataURL(id, w, h);
      },
      toBlob(callback, type, quality) {
        if (typeof callback !== 'function') throw new TypeError("Failed to execute 'toBlob' on 'HTMLCanvasElement': The callback provided as parameter 1 is not a function.");
        const url = this.toDataURL(type, quality);
        L.postTask(() => {
          let blob = null;
          if (url !== 'data:,') {
            const bin = atob(url.slice(url.indexOf(',') + 1));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            blob = new L.Blob([bytes], { type: 'image/png' });
          }
          L.safeCall(callback, undefined, [blob]);
        });
      },
      captureStream() { throw new DOMException("Failed to execute 'captureStream' on 'HTMLCanvasElement': not supported", 'NotSupportedError'); },
      transferControlToOffscreen() { throw new DOMException("Failed to execute 'transferControlToOffscreen' on 'HTMLCanvasElement': not supported", 'NotSupportedError'); },
    });
  }

  // Colors: [r, g, b, a] (0-255, alpha 0-1) from N.parseColor.
  function colorString(c) {
    if (c[3] >= 1) return '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    let a = String(Math.round(c[3] * 255) / 255);
    if (a.length > 8) a = c[3].toFixed(8).replace(/0+$/, '');
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
  }
  const GRADIENT = new WeakMap(); // CanvasGradient -> { kind, coords, stops }
  class CanvasGradient {
    constructor(token, kind, coords) {
      if (token !== INTERNAL) throw L.illegal();
      GRADIENT.set(this, { kind, coords, stops: [] });
    }
    addColorStop(offset, color) {
      const g = GRADIENT.get(this);
      const o = Number(offset);
      if (!(o >= 0 && o <= 1)) throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The provided value (${offset}) is outside the range (0.0, 1.0).`, 'IndexSizeError');
      const c = N.parseColor(`${color}`);
      if (c === null) throw new DOMException(`Failed to execute 'addColorStop' on 'CanvasGradient': The value provided ('${color}') could not be parsed as a color.`, 'SyntaxError');
      g.stops.push([o, c]);
      g.stops.sort((a, b) => a[0] - b[0]);
    }
  }
  const PATTERN = new WeakMap(); // CanvasPattern -> { source: [kind, src, w, h], repetition, matrix }
  class CanvasPattern {
    constructor(token, source, repetition) {
      if (token !== INTERNAL) throw L.illegal();
      PATTERN.set(this, { source, repetition, matrix: [1, 0, 0, 1, 0, 0] });
    }
    setTransform(m) {
      const p = PATTERN.get(this);
      if (m === undefined) { p.matrix = [1, 0, 0, 1, 0, 0]; return; }
      const d = L.DOMMatrix.fromMatrix(m);
      p.matrix = [d.a, d.b, d.c, d.d, d.e, d.f];
    }
  }
  function paintOf(style) {
    if (Array.isArray(style)) return [0, style[0], style[1], style[2], style[3]];
    const g = GRADIENT.get(style);
    if (g !== undefined) {
      const stops = [];
      for (const [o, c] of g.stops) stops.push(o, c[0], c[1], c[2], c[3]);
      if (g.kind === 'conic') return g.stops.length ? [0, g.stops[0][1][0], g.stops[0][1][1], g.stops[0][1][2], g.stops[0][1][3]] : [0, 0, 0, 0, 0];
      return [g.kind === 'linear' ? 1 : 2, ...g.coords, ...stops];
    }
    return [0, 0, 0, 0, 0];
  }
  function patternOf(style) {
    const p = PATTERN.get(style);
    if (p === undefined) return null;
    return [p.source[0], p.source[1], p.source[2], p.source[3], p.repetition, ...p.matrix];
  }
  // An image source as [kind, source, width, height] (kind 0: element id, 1: RGBA bytes),
  // or null while it has no pixels. Throws for unusable sources.
  function imageSource(image, what) {
    if (image instanceof HTMLImageElement) {
      if (!image.complete || image.naturalWidth === 0) return null;
      const s = N.imageSize(idOf(image));
      return s ? [0, idOf(image), s[0], s[1]] : null;
    }
    if (image instanceof HTMLCanvasElement) {
      const id = idOf(image);
      const w = canvasDim(id, 'width', 300), h = canvasDim(id, 'height', 150);
      if (w === 0 || h === 0) throw new DOMException(`Failed to execute '${what}' on 'CanvasRenderingContext2D': The image argument is a canvas element with a width or height of 0.`, 'InvalidStateError');
      const c = ctxCache.get(image);
      if (c) L.ctxSync(c);
      return [0, id, w, h];
    }
    if (image instanceof ImageData) return [1, image.data, image.width, image.height];
    if (image !== null && typeof image === 'object' && L.imageBitmapPixels && L.imageBitmapPixels(image)) return L.imageBitmapPixels(image);
    if (image !== null && typeof image === 'object' && (image.tagName === 'VIDEO' || image.tagName === 'svg')) return null;
    throw new TypeError(`Failed to execute '${what}' on 'CanvasRenderingContext2D': The provided value is not of type '(CSSImageValue or HTMLCanvasElement or HTMLImageElement or HTMLVideoElement or ImageBitmap or OffscreenCanvas or SVGImageElement or VideoFrame)'.`);
  }
  class TextMetrics {
    #m;
    constructor(token, m) { if (token !== INTERNAL) throw L.illegal(); this.#m = m; }
    static { L.tmGet = (o, k) => o.#m[k]; }
  }
  for (const k of ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
    'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent', 'hangingBaseline',
    'alphabeticBaseline', 'ideographicBaseline']) def(TextMetrics.prototype, k, function () { return L.tmGet(this, k); });
  class ImageData {
    #w; #h; #data; #cs;
    constructor(a, b, c, d) {
      if (a instanceof Uint8ClampedArray) {
        const w = b >>> 0;
        if (w === 0) throw new DOMException("Failed to construct 'ImageData': The source width is zero or not a number.", 'IndexSizeError');
        const h = c === undefined ? a.length / 4 / w : c >>> 0;
        if (a.length !== w * h * 4) throw new DOMException("Failed to construct 'ImageData': The input data length is not equal to (4 * width * height).", 'IndexSizeError');
        this.#data = a; this.#w = w; this.#h = h; this.#cs = (d && d.colorSpace) || 'srgb';
      } else {
        const w = a >>> 0, h = b >>> 0;
        if (w === 0 || h === 0) throw new DOMException("Failed to construct 'ImageData': The source width is zero or not a number.", 'IndexSizeError');
        this.#w = w; this.#h = h; this.#data = new Uint8ClampedArray(w * h * 4); this.#cs = (c && c.colorSpace) || 'srgb';
      }
    }
    get width() { return this.#w; }
    get height() { return this.#h; }
    get data() { return this.#data; }
    get colorSpace() { return this.#cs; }
  }

  // --- paths ---
  // Commands: 0 x y (move), 1 x y (line), 2 cx cy x y (quad), 3 c1x c1y c2x c2y x y (cubic), 4 (close).
  const T = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  class PathSink {
    constructor() { this.cmds = []; this.cur = null; this.start = null; }
    moveTo(m, x, y) { this.cmds.push(0, ...T(m, x, y)); this.cur = [x, y]; this.start = [x, y]; }
    ensure(m, x, y) { if (this.cur === null) this.moveTo(m, x, y); }
    lineTo(m, x, y) { if (this.cur === null) { this.moveTo(m, x, y); return; } this.cmds.push(1, ...T(m, x, y)); this.cur = [x, y]; }
    quadTo(m, cx, cy, x, y) { this.ensure(m, cx, cy); this.cmds.push(2, ...T(m, cx, cy), ...T(m, x, y)); this.cur = [x, y]; }
    cubicTo(m, c1x, c1y, c2x, c2y, x, y) { this.ensure(m, c1x, c1y); this.cmds.push(3, ...T(m, c1x, c1y), ...T(m, c2x, c2y), ...T(m, x, y)); this.cur = [x, y]; }
    close() { if (this.cur === null) return; this.cmds.push(4); this.cur = this.start; }
    rect(m, x, y, w, h) { this.moveTo(m, x, y); this.lineTo(m, x + w, y); this.lineTo(m, x + w, y + h); this.lineTo(m, x, y + h); this.close(); }
    // An elliptical arc as cubic Béziers (at most 90° each).
    ellipse(m, x, y, rx, ry, rot, a0, a1, ccw) {
      const TAU = Math.PI * 2;
      let sweep;
      if (!ccw && a1 - a0 >= TAU) sweep = TAU;
      else if (ccw && a0 - a1 >= TAU) sweep = -TAU;
      else if (!ccw) { sweep = (a1 - a0) % TAU; if (sweep < 0) sweep += TAU; }
      else { sweep = (a0 - a1) % TAU; if (sweep < 0) sweep += TAU; sweep = -sweep; }
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const pt = (a) => { const px = rx * Math.cos(a), py = ry * Math.sin(a); return [x + px * cr - py * sr, y + px * sr + py * cr]; };
      const d = (a) => { const px = -rx * Math.sin(a), py = ry * Math.cos(a); return [px * cr - py * sr, px * sr + py * cr]; };
      const p0 = pt(a0);
      if (this.cur === null) this.moveTo(m, p0[0], p0[1]); else this.lineTo(m, p0[0], p0[1]);
      const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
      const step = sweep / n;
      const k = (4 / 3) * Math.tan(step / 4);
      let a = a0;
      for (let i = 0; i < n; i++) {
        const b = a + step;
        const pa = pt(a), pb = pt(b), da = d(a), db = d(b);
        this.cubicTo(m, pa[0] + k * da[0], pa[1] + k * da[1], pb[0] - k * db[0], pb[1] - k * db[1], pb[0], pb[1]);
        a = b;
      }
    }
    arcTo(m, x1, y1, x2, y2, r) {
      if (r < 0) throw new DOMException(`Failed to execute 'arcTo' on 'CanvasRenderingContext2D': The radius provided (${r}) is negative.`, 'IndexSizeError');
      if (this.cur === null) this.moveTo(m, x1, y1);
      const [x0, y0] = this.cur;
      const v1x = x0 - x1, v1y = y0 - y1, v2x = x2 - x1, v2y = y2 - y1;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      const cross = v1x * v2y - v1y * v2x;
      if (r === 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-9) { this.lineTo(m, x1, y1); return; }
      const angle = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2))));
      const t = r / Math.tan(angle / 2);
      const ax = x1 + (v1x / l1) * t, ay = y1 + (v1y / l1) * t;
      const bx = x1 + (v2x / l2) * t, by = y1 + (v2y / l2) * t;
      // Center: along the bisector at distance r / sin(angle/2).
      const bisx = v1x / l1 + v2x / l2, bisy = v1y / l1 + v2y / l2;
      const bl = Math.hypot(bisx, bisy);
      const dist = r / Math.sin(angle / 2);
      const cx = x1 + (bisx / bl) * dist, cy = y1 + (bisy / bl) * dist;
      const s = Math.atan2(ay - cy, ax - cx), e = Math.atan2(by - cy, bx - cx);
      this.lineTo(m, ax, ay);
      this.ellipse(m, cx, cy, r, r, 0, s, e, cross > 0);
    }
    roundRect(m, x, y, w, h, radii) {
      let rs = radii === undefined ? [0] : (typeof radii === 'object' && radii !== null && typeof radii[Symbol.iterator] === 'function' ? [...radii] : [radii]);
      if (rs.length < 1 || rs.length > 4) throw new RangeError(`Failed to execute 'roundRect' on 'CanvasRenderingContext2D': ${rs.length} radii provided. Between one and four radii are necessary.`);
      rs = rs.map((r) => (typeof r === 'object' && r !== null ? [Number(r.x) || 0, Number(r.y) || 0] : [Number(r) || 0, Number(r) || 0]));
      for (const [a, b] of rs) if (a < 0 || b < 0) throw new RangeError("Failed to execute 'roundRect' on 'CanvasRenderingContext2D': Radius value is negative.");
      const [tl, tr, br, bl] = rs.length === 1 ? [rs[0], rs[0], rs[0], rs[0]] : rs.length === 2 ? [rs[0], rs[1], rs[0], rs[1]]
        : rs.length === 3 ? [rs[0], rs[1], rs[2], rs[1]] : rs;
      const f = Math.min(1, Math.abs(w) / (tl[0] + tr[0] || 1), Math.abs(w) / (bl[0] + br[0] || 1), Math.abs(h) / (tl[1] + bl[1] || 1), Math.abs(h) / (tr[1] + br[1] || 1));
      const R = (r) => [r[0] * f, r[1] * f];
      const [a, b, c, d] = [R(tl), R(tr), R(br), R(bl)];
      const H = Math.PI / 2;
      this.moveTo(m, x + a[0], y);
      this.lineTo(m, x + w - b[0], y);
      if (b[0] || b[1]) this.ellipse(m, x + w - b[0], y + b[1], b[0], b[1], 0, -H, 0, false);
      this.lineTo(m, x + w, y + h - c[1]);
      if (c[0] || c[1]) this.ellipse(m, x + w - c[0], y + h - c[1], c[0], c[1], 0, 0, H, false);
      this.lineTo(m, x + d[0], y + h);
      if (d[0] || d[1]) this.ellipse(m, x + d[0], y + h - d[1], d[0], d[1], 0, H, Math.PI, false);
      this.lineTo(m, x, y + a[1]);
      if (a[0] || a[1]) this.ellipse(m, x + a[0], y + a[1], a[0], a[1], 0, Math.PI, 3 * H, false);
      this.close();
      this.moveTo(m, x, y);
    }
  }
  const ID = [1, 0, 0, 1, 0, 0];
  const SINK = Symbol('path'), MAT = Symbol('matrix');
  const finite = (...v) => v.every((x) => Number.isFinite(x));
  // Path methods shared by the context (device space, current transform) and Path2D (user space).
  const pathMethods = {
    closePath() { this[SINK]().close(); },
    moveTo(x, y) { x = +x; y = +y; if (finite(x, y)) this[SINK]().moveTo(this[MAT](), x, y); },
    lineTo(x, y) { x = +x; y = +y; if (finite(x, y)) this[SINK]().lineTo(this[MAT](), x, y); },
    quadraticCurveTo(cx, cy, x, y) { const a = [+cx, +cy, +x, +y]; if (finite(...a)) this[SINK]().quadTo(this[MAT](), ...a); },
    bezierCurveTo(a, b, c, d, e, f) { const v = [+a, +b, +c, +d, +e, +f]; if (finite(...v)) this[SINK]().cubicTo(this[MAT](), ...v); },
    arcTo(x1, y1, x2, y2, r) { const v = [+x1, +y1, +x2, +y2, +r]; if (finite(...v)) this[SINK]().arcTo(this[MAT](), ...v); },
    rect(x, y, w, h) { const v = [+x, +y, +w, +h]; if (finite(...v)) this[SINK]().rect(this[MAT](), ...v); },
    roundRect(x, y, w, h, radii) { const v = [+x, +y, +w, +h]; if (finite(...v)) this[SINK]().roundRect(this[MAT](), ...v, radii); },
    arc(x, y, r, s, e, ccw) {
      const v = [+x, +y, +r, +s, +e];
      if (!finite(...v)) return;
      if (v[2] < 0) throw new DOMException(`Failed to execute 'arc' on '${this instanceof Path2D ? 'Path2D' : 'CanvasRenderingContext2D'}': The radius provided (${r}) is negative.`, 'IndexSizeError');
      this[SINK]().ellipse(this[MAT](), v[0], v[1], v[2], v[2], 0, v[3], v[4], !!ccw);
    },
    ellipse(x, y, rx, ry, rot, s, e, ccw) {
      const v = [+x, +y, +rx, +ry, +rot, +s, +e];
      if (!finite(...v)) return;
      if (v[2] < 0 || v[3] < 0) throw new DOMException(`Failed to execute 'ellipse' on '${this instanceof Path2D ? 'Path2D' : 'CanvasRenderingContext2D'}': The radius provided is negative.`, 'IndexSizeError');
      this[SINK]().ellipse(this[MAT](), ...v, !!ccw);
    },
  };
  const PATH2D = new WeakMap(); // Path2D -> PathSink (user space)
  function parseSvgPath(sink, d) {
    const toks = `${d}`.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
    let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lcmd = '';
    const num = () => Number(toks[i++]);
    const isNum = () => i < toks.length && !/[a-zA-Z]/.test(toks[i]);
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      else if (cmd === '') return;
      const rel = cmd === cmd.toLowerCase();
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      switch (cmd.toUpperCase()) {
        case 'M': { cx = ox + num(); cy = oy + num(); sink.moveTo(ID, cx, cy); sx = cx; sy = cy; cmd = rel ? 'l' : 'L'; break; }
        case 'L': { cx = ox + num(); cy = oy + num(); sink.lineTo(ID, cx, cy); break; }
        case 'H': { cx = ox + num(); sink.lineTo(ID, cx, cy); break; }
        case 'V': { cy = oy + num(); sink.lineTo(ID, cx, cy); break; }
        case 'C': { const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]; sink.cubicTo(ID, ...a); lcx = a[2]; lcy = a[3]; cx = a[4]; cy = a[5]; break; }
        case 'S': { const r1 = /[CS]/i.test(lcmd) ? [2 * cx - lcx, 2 * cy - lcy] : [cx, cy]; const a = [ox + num(), oy + num(), ox + num(), oy + num()]; sink.cubicTo(ID, r1[0], r1[1], ...a); lcx = a[0]; lcy = a[1]; cx = a[2]; cy = a[3]; break; }
        case 'Q': { const a = [ox + num(), oy + num(), ox + num(), oy + num()]; sink.quadTo(ID, ...a); lcx = a[0]; lcy = a[1]; cx = a[2]; cy = a[3]; break; }
        case 'T': { const r1 = /[QT]/i.test(lcmd) ? [2 * cx - lcx, 2 * cy - lcy] : [cx, cy]; const a = [ox + num(), oy + num()]; sink.quadTo(ID, r1[0], r1[1], ...a); lcx = r1[0]; lcy = r1[1]; cx = a[0]; cy = a[1]; break; }
        case 'A': {
          const rx = Math.abs(num()), ry = Math.abs(num()), rot = num() * Math.PI / 180, large = num() !== 0, sweep = num() !== 0;
          const x = ox + num(), y = oy + num();
          svgArc(sink, cx, cy, rx, ry, rot, large, sweep, x, y); cx = x; cy = y; break;
        }
        case 'Z': { sink.close(); cx = sx; cy = sy; break; }
        default: return;
      }
      lcmd = cmd;
      if (!isNum() && i < toks.length && !/[a-zA-Z]/.test(toks[i])) return;
    }
  }
  function svgArc(sink, x1, y1, rx, ry, phi, large, sweep, x2, y2) {
    if (rx === 0 || ry === 0) { sink.lineTo(ID, x2, y2); return; }
    const c = Math.cos(phi), s = Math.sin(phi);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
    const x1p = c * dx + s * dy, y1p = -s * dx + c * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    let k = Math.sqrt(Math.max(0, num / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
    if (large === sweep) k = -k;
    const cxp = (k * rx * y1p) / ry, cyp = (-k * ry * x1p) / rx;
    const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
    sink.ellipse(ID, cx, cy, rx, ry, phi, t1, t1 + dt, dt < 0);
  }
  class Path2D {
    constructor(path) {
      const sink = new PathSink();
      PATH2D.set(this, sink);
      if (path instanceof Path2D) { const o = PATH2D.get(path); sink.cmds = o.cmds.slice(); sink.cur = o.cur; sink.start = o.start; }
      else if (path !== undefined) parseSvgPath(sink, path);
    }
    [SINK]() { return PATH2D.get(this); }
    [MAT]() { return ID; }
    addPath(path, transform) {
      if (!(path instanceof Path2D)) throw new TypeError("Failed to execute 'addPath' on 'Path2D': parameter 1 is not of type 'Path2D'.");
      const m = transform === undefined ? ID : (() => { const d = L.DOMMatrix.fromMatrix(transform); return [d.a, d.b, d.c, d.d, d.e, d.f]; })();
      const sink = PATH2D.get(this);
      sink.cmds.push(...transformCmds(PATH2D.get(path).cmds, m));
    }
  }
  Object.assign(Path2D.prototype, pathMethods);
  function transformCmds(cmds, m) {
    if (m === ID) return cmds.slice();
    const out = [];
    for (let i = 0; i < cmds.length;) {
      const c = cmds[i];
      const n = c === 0 || c === 1 ? 1 : c === 2 ? 2 : c === 3 ? 3 : 0;
      out.push(c);
      for (let k = 0; k < n; k++) out.push(...T(m, cmds[i + 1 + 2 * k], cmds[i + 2 + 2 * k]));
      i += 1 + 2 * n;
    }
    return out;
  }
  // Point-in-path on a flattened path (curves sampled).
  function pointInPath(cmds, x, y, evenOdd) {
    let wind = 0, px = 0, py = 0, sx = 0, sy = 0;
    const edge = (x0, y0, x1, y1) => {
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        if (xi > x) wind += y1 > y0 ? 1 : -1;
      }
    };
    for (let i = 0; i < cmds.length;) {
      const c = cmds[i];
      if (c === 0) { if (px !== sx || py !== sy) edge(px, py, sx, sy); px = sx = cmds[i + 1]; py = sy = cmds[i + 2]; i += 3; }
      else if (c === 1) { edge(px, py, cmds[i + 1], cmds[i + 2]); px = cmds[i + 1]; py = cmds[i + 2]; i += 3; }
      else if (c === 2 || c === 3) {
        const pts = c === 2 ? [px, py, cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4]] : [px, py, cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4], cmds[i + 5], cmds[i + 6]];
        let lx = px, ly = py;
        for (let s = 1; s <= 16; s++) {
          const t = s / 16, u = 1 - t;
          let qx, qy;
          if (c === 2) { qx = u * u * pts[0] + 2 * u * t * pts[2] + t * t * pts[4]; qy = u * u * pts[1] + 2 * u * t * pts[3] + t * t * pts[5]; }
          else { qx = u * u * u * pts[0] + 3 * u * u * t * pts[2] + 3 * u * t * t * pts[4] + t * t * t * pts[6]; qy = u * u * u * pts[1] + 3 * u * u * t * pts[3] + 3 * u * t * t * pts[5] + t * t * t * pts[7]; }
          edge(lx, ly, qx, qy); lx = qx; ly = qy;
        }
        px = lx; py = ly; i += c === 2 ? 5 : 7;
      } else { edge(px, py, sx, sy); px = sx; py = sy; i += 1; }
    }
    if (px !== sx || py !== sy) edge(px, py, sx, sy);
    return evenOdd ? (wind & 1) !== 0 : wind !== 0;
  }

  // --- the 2D context ---
  const CTX_DEFAULTS = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low', shadowOffsetX: 0, shadowOffsetY: 0,
    shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    lineDashOffset: 0, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit',
    fontKerning: 'auto', letterSpacing: '0px', wordSpacing: '0px', textRendering: 'auto', fontStretch: 'normal',
    fontVariantCaps: 'normal', lang: 'inherit',
  };
  const COMPOSITE_OPS = ['source-over', 'source-in', 'source-out', 'source-atop', 'destination-over', 'destination-in',
    'destination-out', 'destination-atop', 'lighter', 'copy', 'xor', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
  const ENUMS = {
    lineCap: ['butt', 'round', 'square'], lineJoin: ['round', 'bevel', 'miter'],
    textAlign: ['start', 'end', 'left', 'right', 'center'], textBaseline: ['top', 'hanging', 'middle', 'alphabetic', 'ideographic', 'bottom'],
    direction: ['ltr', 'rtl', 'inherit'], imageSmoothingQuality: ['low', 'medium', 'high'],
  };
  // CSS `font` shorthand -> [family, sizePx, weight, italic] (null if invalid).
  function parseFont(v) {
    const m = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|[1-9]00|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)\s+)*)((?:\d+\.?\d*|\.\d+)(?:px|pt|pc|em|rem|%|in|cm|mm|q|vw|vh)|xx-small|x-small|small|medium|large|x-large|xx-large|larger|smaller)(?:\s*\/\s*[^\s]+)?\s+(.+?)\s*$/i.exec(`${v}`);
    if (m === null) return null;
    const pre = m[1].toLowerCase().split(/\s+/).filter(Boolean);
    let weight = 400, italic = false;
    for (const t of pre) {
      if (t === 'italic' || t === 'oblique') italic = true;
      else if (t === 'bold' || t === 'bolder') weight = 700;
      else if (t === 'lighter') weight = 300;
      else if (/^[1-9]00$/.test(t)) weight = Number(t);
    }
    const sz = m[2].toLowerCase();
    const KW = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, larger: 12, smaller: 8 };
    let size;
    if (sz in KW) size = KW[sz];
    else {
      const n = parseFloat(sz), u = sz.replace(/^[\d.]+/, '');
      size = u === 'px' ? n : u === 'pt' ? n * 4 / 3 : u === 'pc' ? n * 16 : u === 'em' || u === 'rem' ? n * 10 : u === '%' ? n / 10
        : u === 'in' ? n * 96 : u === 'cm' ? n * 96 / 2.54 : u === 'mm' ? n * 96 / 25.4 : u === 'q' ? n * 96 / 101.6 : n;
    }
    return [m[3], size, weight, italic];
  }
  class CanvasRenderingContext2D {
    #canvas; #id; #w = 0; #h = 0; #state; #stack = []; #attrs; #path = new PathSink();
    constructor(token, canvas, attrs) {
      if (token !== INTERNAL) throw L.illegal();
      this.#canvas = canvas;
      this.#id = idOf(canvas);
      this.#attrs = { alpha: !(attrs && attrs.alpha === false), colorSpace: 'srgb', desynchronized: false, willReadFrequently: !!(attrs && attrs.willReadFrequently) };
      this.#resetState();
      this.#resize();
    }
    #resetState() {
      this.#state = Object.assign({}, CTX_DEFAULTS, { fill: [0, 0, 0, 1], stroke: [0, 0, 0, 1], dash: [], m: [1, 0, 0, 1, 0, 0], clips: [], fontSpec: ['sans-serif', 10, 400, false] });
      this.#stack = [];
      this.#path = new PathSink();
    }
    #resize() {
      this.#w = canvasDim(this.#id, 'width', 300);
      this.#h = canvasDim(this.#id, 'height', 150);
      N.canvasReset(this.#id, this.#w, this.#h);
    }
    // The canvas' size changed (bitmap and state are reset).
    #sync() {
      if (canvasDim(this.#id, 'width', 300) !== this.#w || canvasDim(this.#id, 'height', 150) !== this.#h) {
        this.#resetState();
        this.#resize();
      }
    }
    static {
      L.ctxResize = (c) => { c.#resetState(); c.#resize(); };
      L.ctxSync = (c) => c.#sync();
      L.ctxState = (c) => c.#state;
    }
    [SINK]() { return this.#path; }
    [MAT]() { return this.#state.m; }
    get canvas() { return this.#canvas; }
    getContextAttributes() { return Object.assign({}, this.#attrs); }
    isContextLost() { return false; }
    save() { const s = this.#state; this.#stack.push(Object.assign({}, s, { m: s.m.slice(), dash: s.dash.slice(), clips: s.clips.slice() })); }
    restore() {
      const s = this.#stack.pop();
      if (!s) return;
      const clipChanged = s.clips.length !== this.#state.clips.length || s.clips.some((c, i) => c !== this.#state.clips[i]);
      this.#state = s;
      if (clipChanged) this.#applyClip();
    }
    reset() { this.#resetState(); this.#resize(); }
    #applyClip() { N.canvasClip(this.#id, this.#state.clips.flat()); }
    // --- transforms ---
    #mul(a, b, c, d, e, f) {
      const m = this.#state.m;
      this.#state.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
    }
    scale(x, y) { x = +x; y = +y; if (finite(x, y)) this.#mul(x, 0, 0, y, 0, 0); }
    rotate(a) { a = +a; if (finite(a)) { const c = Math.cos(a), s = Math.sin(a); this.#mul(c, s, -s, c, 0, 0); } }
    translate(x, y) { x = +x; y = +y; if (finite(x, y)) this.#mul(1, 0, 0, 1, x, y); }
    transform(a, b, c, d, e, f) { const v = [+a, +b, +c, +d, +e, +f]; if (finite(...v)) this.#mul(...v); }
    setTransform(a, b, c, d, e, f) {
      if (a === undefined || (a !== null && typeof a === 'object')) {
        const m = a === undefined ? new L.DOMMatrix() : L.DOMMatrix.fromMatrix(a);
        this.#state.m = [m.a, m.b, m.c, m.d, m.e, m.f];
        return;
      }
      const v = [+a, +b, +c, +d, +e, +f];
      if (finite(...v)) this.#state.m = v;
    }
    getTransform() { return new L.DOMMatrix(this.#state.m.slice()); }
    resetTransform() { this.#state.m = [1, 0, 0, 1, 0, 0]; }
    // --- styles ---
    get fillStyle() { const s = this.#state.fill; return Array.isArray(s) ? colorString(s) : s; }
    set fillStyle(v) { const s = this.#style(v); if (s !== null) this.#state.fill = s; }
    get strokeStyle() { const s = this.#state.stroke; return Array.isArray(s) ? colorString(s) : s; }
    set strokeStyle(v) { const s = this.#style(v); if (s !== null) this.#state.stroke = s; }
    #style(v) {
      if (v instanceof CanvasGradient || v instanceof CanvasPattern) return v;
      return N.parseColor(`${v}`);
    }
    createLinearGradient(x0, y0, x1, y1) {
      const v = [+x0, +y0, +x1, +y1];
      if (!finite(...v)) throw new TypeError("Failed to execute 'createLinearGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
      return new CanvasGradient(INTERNAL, 'linear', v);
    }
    createRadialGradient(x0, y0, r0, x1, y1, r1) {
      const v = [+x0, +y0, +r0, +x1, +y1, +r1];
      if (!finite(...v)) throw new TypeError("Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
      if (v[2] < 0 || v[5] < 0) throw new DOMException(`Failed to execute 'createRadialGradient' on 'CanvasRenderingContext2D': The ${v[2] < 0 ? 'r0' : 'r1'} provided is less than 0.`, 'IndexSizeError');
      return new CanvasGradient(INTERNAL, 'radial', v);
    }
    createConicGradient(a, x, y) { return new CanvasGradient(INTERNAL, 'conic', [+a, +x, +y]); }
    createPattern(image, repetition) {
      const r = repetition === null || repetition === undefined || `${repetition}` === '' ? 'repeat' : `${repetition}`;
      if (!['repeat', 'repeat-x', 'repeat-y', 'no-repeat'].includes(r)) throw new DOMException(`Failed to execute 'createPattern' on 'CanvasRenderingContext2D': The provided type ('${r}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`, 'SyntaxError');
      const src = imageSource(image, 'createPattern');
      if (src === null) return null;
      // Snapshot canvas sources (a pattern keeps the pixels it was created with).
      if (src[0] === 0 && image instanceof HTMLCanvasElement) {
        const d = N.canvasGetImageData(src[1], 0, 0, src[2], src[3]);
        return new CanvasPattern(INTERNAL, [1, new Uint8Array(d), src[2], src[3]], r);
      }
      return new CanvasPattern(INTERNAL, src, r);
    }
    setLineDash(segments) {
      const d = Array.from(segments, Number);
      if (d.some((x) => !Number.isFinite(x) || x < 0)) return;
      this.#state.dash = d.length % 2 ? d.concat(d) : d;
    }
    getLineDash() { return this.#state.dash.slice(); }
    // --- paths ---
    beginPath() { this.#path = new PathSink(); }
    #pathArg(path) {
      if (path instanceof Path2D) return transformCmds(PATH2D.get(path).cmds, this.#state.m);
      return this.#path.cmds;
    }
    #paintArgs(style) {
      const s = this.#state;
      return [paintOf(style), s.globalAlpha, s.globalCompositeOperation, s.m, patternOf(style)];
    }
    #fillCmds(cmds, evenOdd) {
      if (cmds.length === 0) return;
      const [paint, alpha, op, m, pattern] = this.#paintArgs(this.#state.fill);
      N.canvasFill(this.#id, new Float64Array(cmds), evenOdd, paint, alpha, op, m, pattern);
    }
    #strokeCmds(cmds) {
      if (cmds.length === 0) return;
      const s = this.#state;
      const [paint, alpha, op, m, pattern] = this.#paintArgs(s.stroke);
      N.canvasStroke(this.#id, new Float64Array(cmds), paint, s.lineWidth, s.lineCap, s.lineJoin, s.miterLimit,
        s.dash.length ? s.dash : null, s.lineDashOffset, m, alpha, op, pattern);
    }
    fill(a, b) {
      this.#sync();
      const path = a instanceof Path2D ? a : undefined;
      const rule = path ? b : a;
      this.#fillCmds(this.#pathArg(path), rule === 'evenodd');
    }
    stroke(path) { this.#sync(); this.#strokeCmds(this.#pathArg(path instanceof Path2D ? path : undefined)); }
    clip(a, b) {
      this.#sync();
      const path = a instanceof Path2D ? a : undefined;
      const rule = path ? b : a;
      this.#state.clips = this.#state.clips.concat([[new Float64Array(this.#pathArg(path)), rule === 'evenodd']]);
      this.#applyClip();
    }
    isPointInPath(a, b, c, d) {
      let cmds, x, y, rule;
      if (a instanceof Path2D) { cmds = this.#pathArg(a); x = +b; y = +c; rule = d; } else { cmds = this.#path.cmds; x = +a; y = +b; rule = c; }
      if (!finite(x, y)) return false;
      return pointInPath(cmds, x, y, rule === 'evenodd');
    }
    isPointInStroke() { return false; }
    drawFocusIfNeeded() { } scrollPathIntoView() { }
    fillRect(x, y, w, h) {
      const v = [+x, +y, +w, +h];
      if (!finite(...v) || v[2] === 0 || v[3] === 0) return;
      this.#sync();
      const p = new PathSink(); p.rect(this.#state.m, ...v);
      this.#fillCmds(p.cmds, false);
    }
    strokeRect(x, y, w, h) {
      const v = [+x, +y, +w, +h];
      if (!finite(...v)) return;
      this.#sync();
      const p = new PathSink(); p.rect(this.#state.m, ...v);
      this.#strokeCmds(p.cmds);
    }
    clearRect(x, y, w, h) {
      const v = [+x, +y, +w, +h];
      if (!finite(...v)) return;
      this.#sync();
      N.canvasClearRect(this.#id, ...v, this.#state.m);
    }
    // --- text ---
    get font() { return this.#state.font; }
    set font(v) { const f = parseFont(v); if (f !== null) { this.#state.font = `${v}`.trim(); this.#state.fontSpec = f; } }
    #text(text, x, y, maxWidth, fill) {
      const v = [+x, +y];
      if (!finite(...v)) return;
      const mw = maxWidth === undefined ? NaN : +maxWidth;
      if (maxWidth !== undefined && !(mw > 0)) return;
      this.#sync();
      const s = this.#state;
      const style = fill ? s.fill : s.stroke;
      const [paint, alpha, op, m, pattern] = this.#paintArgs(style);
      const t = `${text}`.replace(/[\t\n\f\r]/g, ' ');
      const align = s.direction === 'rtl' ? ({ start: 'right', end: 'left' })[s.textAlign] || s.textAlign : s.textAlign;
      N.canvasText(this.#id, t, s.fontSpec, v[0], v[1], align, s.textBaseline, mw, fill, paint,
        [String(s.lineWidth), s.lineCap, s.lineJoin, String(s.miterLimit)], m, alpha, op, pattern);
    }
    fillText(text, x, y, maxWidth) { this.#text(text, x, y, maxWidth, true); }
    strokeText(text, x, y, maxWidth) { this.#text(text, x, y, maxWidth, false); }
    measureText(text) {
      const s = this.#state;
      const r = N.canvasMeasureText(s.fontSpec, `${text}`.replace(/[\t\n\f\r]/g, ' '));
      const [w, il, ir, ia, id, fa, fd, ea, ed] = r;
      const ax = s.textAlign === 'center' ? w / 2 : (s.textAlign === 'right' || (s.textAlign === 'end' && s.direction !== 'rtl') || (s.textAlign === 'start' && s.direction === 'rtl')) ? w : 0;
      // Offset of the alphabetic baseline below the chosen one (em box, as in Chromium).
      const by = s.textBaseline === 'top' ? ea : s.textBaseline === 'hanging' ? ea * 0.8 : s.textBaseline === 'middle' ? (ea - ed) / 2
        : (s.textBaseline === 'bottom' || s.textBaseline === 'ideographic') ? -ed : 0;
      return new TextMetrics(INTERNAL, {
        width: w, actualBoundingBoxLeft: il + ax, actualBoundingBoxRight: ir - ax,
        fontBoundingBoxAscent: fa - by, fontBoundingBoxDescent: fd + by,
        actualBoundingBoxAscent: ia - by, actualBoundingBoxDescent: id + by,
        emHeightAscent: ea - by, emHeightDescent: ed + by, hangingBaseline: ea * 0.8 - by, alphabeticBaseline: -by, ideographicBaseline: -ed - by,
      });
    }
    // --- images ---
    drawImage(image, ...a) {
      if (a.length !== 2 && a.length !== 4 && a.length !== 8) throw new TypeError(`Failed to execute 'drawImage' on 'CanvasRenderingContext2D': Valid arities are: [3, 5, 9], but ${a.length + 1} arguments provided.`);
      const src = imageSource(image, 'drawImage');
      if (src === null) return;
      const [kind, source, sw0, sh0] = src;
      let sx = 0, sy = 0, sw = sw0, sh = sh0, dx, dy, dw, dh;
      if (a.length === 2) { [dx, dy] = a.map(Number); dw = sw0; dh = sh0; }
      else if (a.length === 4) { [dx, dy, dw, dh] = a.map(Number); }
      else { [sx, sy, sw, sh, dx, dy, dw, dh] = a.map(Number); }
      if (!finite(sx, sy, sw, sh, dx, dy, dw, dh)) return;
      this.#sync();
      if (kind === 0 && source === this.#id) {
        // Drawing a canvas onto itself: use a snapshot.
        const d = N.canvasGetImageData(this.#id, 0, 0, sw0, sh0);
        N.canvasDrawImage(this.#id, 1, new Uint8Array(d), sw0, sh0, sx, sy, sw, sh, dx, dy, dw, dh, this.#state.m, this.#state.globalAlpha, this.#state.globalCompositeOperation, this.#state.imageSmoothingEnabled);
        return;
      }
      N.canvasDrawImage(this.#id, kind, source, sw0, sh0, sx, sy, sw, sh, dx, dy, dw, dh, this.#state.m, this.#state.globalAlpha, this.#state.globalCompositeOperation, this.#state.imageSmoothingEnabled);
    }
    createImageData(a, b, c) {
      if (a instanceof ImageData) return new ImageData(a.width, a.height);
      const w = Math.abs(Math.trunc(+a)), h = Math.abs(Math.trunc(+b));
      if (w === 0 || h === 0) throw new DOMException(`Failed to execute 'createImageData' on 'CanvasRenderingContext2D': The source ${w === 0 ? 'width' : 'height'} is 0.`, 'IndexSizeError');
      return new ImageData(w, h);
    }
    getImageData(sx, sy, sw, sh) {
      let [x, y, w, h] = [sx, sy, sw, sh].map((v) => Math.trunc(+v));
      if (![x, y, w, h].every(Number.isFinite)) throw new TypeError("Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The provided double value is non-finite.");
      if (w === 0 || h === 0) throw new DOMException(`Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The source ${w === 0 ? 'width' : 'height'} is 0.`, 'IndexSizeError');
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      this.#sync();
      return new ImageData(new Uint8ClampedArray(N.canvasGetImageData(this.#id, x, y, w, h)), w, h);
    }
    putImageData(imagedata, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
      if (!(imagedata instanceof ImageData)) throw new TypeError("Failed to execute 'putImageData' on 'CanvasRenderingContext2D': parameter 1 is not of type 'ImageData'.");
      const w = imagedata.width, h = imagedata.height;
      let rx = 0, ry = 0, rw = w, rh = h;
      if (dirtyX !== undefined) {
        [rx, ry, rw, rh] = [dirtyX, dirtyY, dirtyW, dirtyH].map((v) => Math.trunc(+v) || 0);
        if (rw < 0) { rx += rw; rw = -rw; }
        if (rh < 0) { ry += rh; rh = -rh; }
      }
      this.#sync();
      N.canvasPutImageData(this.#id, imagedata.data, w, h, Math.trunc(+dx) || 0, Math.trunc(+dy) || 0, rx, ry, rw, rh);
    }
  }
  Object.assign(CanvasRenderingContext2D.prototype, pathMethods);
  for (const k in CTX_DEFAULTS) {
    if (k === 'font') continue;
    def(CanvasRenderingContext2D.prototype, k, function () { return L.ctxState(this)[k]; }, function (v) {
      const s = L.ctxState(this);
      if (k === 'globalAlpha') { const n = +v; if (Number.isFinite(n) && n >= 0 && n <= 1) s[k] = n; return; }
      if (k === 'lineWidth' || k === 'miterLimit') { const n = +v; if (Number.isFinite(n) && n > 0) s[k] = n; return; }
      if (k === 'lineDashOffset' || k === 'shadowOffsetX' || k === 'shadowOffsetY') { const n = +v; if (Number.isFinite(n)) s[k] = n; return; }
      if (k === 'shadowBlur') { const n = +v; if (Number.isFinite(n) && n >= 0) s[k] = n; return; }
      if (k === 'globalCompositeOperation') { if (COMPOSITE_OPS.includes(`${v}`)) s[k] = `${v}`; return; }
      if (k === 'imageSmoothingEnabled') { s[k] = !!v; return; }
      if (k === 'shadowColor') { const c = N.parseColor(`${v}`); if (c !== null) s[k] = colorString(c); return; }
      if (k in ENUMS) { if (ENUMS[k].includes(`${v}`)) s[k] = `${v}`; return; }
      s[k] = `${v}`;
    });
  }

  // --- media ---
  class TimeRanges {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
    get length() { return 0; }
    start(i) { throw new DOMException(`Failed to execute 'start' on 'TimeRanges': The index provided (${i}) is greater than or equal to the maximum bound (0).`, 'IndexSizeError'); }
    end(i) { throw new DOMException(`Failed to execute 'end' on 'TimeRanges': The index provided (${i}) is greater than or equal to the maximum bound (0).`, 'IndexSizeError'); }
  }
  class MediaError {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); }
  }
  L.defineConstants([MediaError, MediaError.prototype], { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  class TrackListBase extends L.EventTarget {
    constructor(token) { if (token !== INTERNAL) throw L.illegal(); super(); }
    get length() { return 0; }
    getTrackById() { return null; }
    *[Symbol.iterator]() { }
  }
  const TextTrackList = { TextTrackList: class extends TrackListBase { } }.TextTrackList;
  const AudioTrackList = { AudioTrackList: class extends TrackListBase { } }.AudioTrackList;
  const VideoTrackList = { VideoTrackList: class extends TrackListBase { } }.VideoTrackList;
  for (const C of [TextTrackList, AudioTrackList, VideoTrackList]) L.defineEventHandlers(C.prototype, ['onchange', 'onaddtrack', 'onremovetrack']);
  const mediaState = new WeakMap();
  function ms(el) {
    let s = mediaState.get(el);
    if (s === undefined) {
      s = { currentTime: 0, volume: 1, muted: null, playbackRate: 1, defaultPlaybackRate: 1, srcObject: null, preservesPitch: true,
        text: new TextTrackList(INTERNAL), audio: new AudioTrackList(INTERNAL), video: new VideoTrackList(INTERNAL) };
      mediaState.set(el, s);
    }
    return s;
  }
  const HTMLMediaElement = htmlClass('HTMLMediaElement', []);
  {
    const P = HTMLMediaElement.prototype;
    L.defineConstants([HTMLMediaElement, P], { NETWORK_EMPTY: 0, NETWORK_IDLE: 1, NETWORK_LOADING: 2, NETWORK_NO_SOURCE: 3, HAVE_NOTHING: 0, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3, HAVE_ENOUGH_DATA: 4 });
    R.url(P, 'src'); R.crossOrigin(P); R.bool(P, 'autoplay'); R.bool(P, 'loop'); R.bool(P, 'controls');
    R.bool(P, 'defaultMuted', 'muted');
    R.enumerated(P, 'preload', 'preload', ['none', 'metadata', 'auto'], 'metadata', 'auto');
    R.tokens(P, 'controlsList', 'controlslist', ['nodownload', 'nofullscreen', 'noplaybackrate', 'noremoteplayback']);
    R.bool(P, 'disableRemotePlayback', 'disableremoteplayback');
    L.mixin(P, {
      get error() { return null; },
      get srcObject() { return ms(this).srcObject; },
      set srcObject(v) { ms(this).srcObject = v; },
      get currentSrc() { return this.src; },
      get networkState() { return 0; },
      get buffered() { return new TimeRanges(INTERNAL); },
      get played() { return new TimeRanges(INTERNAL); },
      get seekable() { return new TimeRanges(INTERNAL); },
      load() { },
      canPlayType() { return ''; },
      get readyState() { return 0; },
      get seeking() { return false; },
      get currentTime() { return ms(this).currentTime; },
      set currentTime(v) { ms(this).currentTime = Number(v) || 0; },
      fastSeek(t) { ms(this).currentTime = Number(t) || 0; },
      get duration() { return NaN; },
      getStartDate() { return new Date(NaN); },
      get paused() { return true; },
      get ended() { return false; },
      get defaultPlaybackRate() { return ms(this).defaultPlaybackRate; },
      set defaultPlaybackRate(v) { ms(this).defaultPlaybackRate = Number(v); },
      get playbackRate() { return ms(this).playbackRate; },
      set playbackRate(v) { ms(this).playbackRate = Number(v); },
      get preservesPitch() { return ms(this).preservesPitch; },
      set preservesPitch(v) { ms(this).preservesPitch = !!v; },
      play() { return L.resolvedPromise(undefined); },
      pause() { },
      get volume() { return ms(this).volume; },
      set volume(v) {
        const n = Number(v);
        if (!(n >= 0 && n <= 1)) throw new DOMException(`Failed to set the 'volume' property on 'HTMLMediaElement': The volume provided (${v}) is outside the range [0, 1].`, 'IndexSizeError');
        ms(this).volume = n;
      },
      get muted() { const s = ms(this); return s.muted === null ? N.hasAttr(idOf(this), 'muted') : s.muted; },
      set muted(v) { ms(this).muted = !!v; },
      get textTracks() { return ms(this).text; },
      get audioTracks() { return ms(this).audio; },
      get videoTracks() { return ms(this).video; },
      addTextTrack(kind, label = '', language = '') { return { kind, label, language, mode: 'hidden', cues: null, activeCues: null, addCue() { }, removeCue() { }, addEventListener() { }, removeEventListener() { } }; },
      get sinkId() { return ''; },
      setSinkId() { return L.resolvedPromise(undefined); },
      get mediaKeys() { return null; },
      setMediaKeys() { return L.resolvedPromise(undefined); },
      get remote() { return undefined; },
    });
  }
  const HTMLVideoElement = htmlClass('HTMLVideoElement', ['video'], HTMLMediaElement);
  {
    const P = HTMLVideoElement.prototype;
    R.ulong(P, 'width'); R.ulong(P, 'height'); R.url(P, 'poster'); R.bool(P, 'playsInline', 'playsinline');
    R.bool(P, 'disablePictureInPicture', 'disablepictureinpicture');
    L.mixin(P, {
      get videoWidth() { return 0; },
      get videoHeight() { return 0; },
      getVideoPlaybackQuality() { return { creationTime: N.now(), droppedVideoFrames: 0, totalVideoFrames: 0, corruptedVideoFrames: 0 }; },
      requestPictureInPicture() { return L.rejectedPromise(new DOMException('Picture-in-Picture is not supported', 'NotSupportedError')); },
      requestVideoFrameCallback() { return 0; },
      cancelVideoFrameCallback() { },
    });
    L.defineEventHandlers(P, ['onenterpictureinpicture', 'onleavepictureinpicture']);
  }
  const HTMLAudioElement = htmlClass('HTMLAudioElement', ['audio'], HTMLMediaElement);
  const Audio = function Audio(src) {
    if (!new.target) throw new TypeError("Failed to construct 'Audio': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const a = L.document.createElement('audio');
    setAttr(a, idOf(a), 'preload', 'auto');
    if (src !== undefined) a.src = src;
    return a;
  };
  Audio.prototype = HTMLAudioElement.prototype;

  // --- dialog / details ---
  const HTMLDialogElement = htmlClass('HTMLDialogElement', ['dialog']);
  const dialogReturn = new WeakMap();
  {
    const P = HTMLDialogElement.prototype;
    R.bool(P, 'open');
    R.str(P, 'closedBy', 'closedby');
    L.mixin(P, {
      get returnValue() { const v = dialogReturn.get(this); return v === undefined ? '' : v; },
      set returnValue(v) { dialogReturn.set(this, `${v}`); },
      show() { if (!N.hasAttr(idOf(this), 'open')) setAttr(this, idOf(this), 'open', ''); },
      showModal() {
        if (!N.isConnected(idOf(this))) throw new DOMException("Failed to execute 'showModal' on 'HTMLDialogElement': The element is not in a Document.", 'InvalidStateError');
        if (!N.hasAttr(idOf(this), 'open')) setAttr(this, idOf(this), 'open', '');
      },
      close(returnValue) {
        if (!N.hasAttr(idOf(this), 'open')) return;
        removeAttr(this, idOf(this), 'open');
        if (returnValue !== undefined) dialogReturn.set(this, `${returnValue}`);
        const el = this;
        L.postTask(() => L.fire(el, 'close', { bubbles: false }));
      },
      requestClose(returnValue) {
        if (!N.hasAttr(idOf(this), 'open')) return;
        if (L.fire(this, 'cancel', { cancelable: true })) this.close(returnValue);
      },
    });
  }
  const HTMLDetailsElement = htmlClass('HTMLDetailsElement', ['details']);
  R.bool(HTMLDetailsElement.prototype, 'open');
  R.str(HTMLDetailsElement.prototype, 'name');
  const toggleQueued = new WeakMap();
  L.addAttrHook('open', (w, id, name, old, value) => {
    if (lnOf(w) !== 'details' || nsOf(w) !== HTML) return;
    if ((old === null) === (value === null)) return;
    const newState = value === null ? 'closed' : 'open';
    const q = toggleQueued.get(w);
    if (q !== undefined) { q.newState = newState; return; }
    const rec = { oldState: value === null ? 'open' : 'closed', newState };
    toggleQueued.set(w, rec);
    L.postTask(() => {
      toggleQueued.delete(w);
      L.fire(w, 'toggle', { oldState: rec.oldState, newState: rec.newState }, L.ToggleEvent);
    });
  });

  // --- tables ---
  function childrenByName(id, names) {
    const out = [];
    for (let c = N.firstChild(id); c !== 0; c = N.nextSibling(c)) {
      if (N.nodeType(c) === 1 && names.includes(N.localName(c)) && N.namespaceURI(c) === L.NS.HTML) out.push(c);
    }
    return out;
  }
  function firstChildByName(id, name) {
    for (let c = N.firstChild(id); c !== 0; c = N.nextSibling(c)) {
      if (N.nodeType(c) === 1 && N.localName(c) === name && N.namespaceURI(c) === L.NS.HTML) return c;
    }
    return 0;
  }
  function tableRows(tid) {
    const out = [];
    for (const s of childrenByName(tid, ['thead'])) for (const r of childrenByName(s, ['tr'])) out.push(r);
    for (let c = N.firstChild(tid); c !== 0; c = N.nextSibling(c)) {
      if (N.nodeType(c) !== 1 || N.namespaceURI(c) !== L.NS.HTML) continue;
      const ln = N.localName(c);
      if (ln === 'tr') out.push(c);
      else if (ln === 'tbody') for (const r of childrenByName(c, ['tr'])) out.push(r);
    }
    for (const s of childrenByName(tid, ['tfoot'])) for (const r of childrenByName(s, ['tr'])) out.push(r);
    return out;
  }
  const collCache = new WeakMap();
  function cachedColl(el, key, make) {
    let m = collCache.get(el);
    if (m === undefined) { m = new Map(); collCache.set(el, m); }
    let c = m.get(key);
    if (c === undefined) { c = make(); m.set(key, c); }
    return c;
  }
  function createChild(parentW, name, beforeId) {
    const el = L.document.createElement(name);
    L.preInsert(parentW, el, wrap(beforeId || 0), 'insert');
    return el;
  }
  const HTMLTableElement = htmlClass('HTMLTableElement', ['table']);
  {
    const P = HTMLTableElement.prototype;
    for (const p of ['align', 'border', 'frame', 'rules', 'summary', 'width', 'bgColor', 'cellPadding', 'cellSpacing']) R.str(P, p, p.toLowerCase());
    L.mixin(P, {
      get caption() { return wrap(firstChildByName(idOf(this), 'caption')); },
      set caption(v) {
        this.deleteCaption();
        if (v !== null && v !== undefined) L.preInsert(this, v, this.firstChild, 'caption');
      },
      createCaption() {
        const c = firstChildByName(idOf(this), 'caption');
        if (c !== 0) return wrap(c);
        return createChild(this, 'caption', N.firstChild(idOf(this)));
      },
      deleteCaption() { const c = firstChildByName(idOf(this), 'caption'); if (c !== 0) L.removeCore(idOf(this), this, c); },
      get tHead() { return wrap(firstChildByName(idOf(this), 'thead')); },
      set tHead(v) {
        this.deleteTHead();
        if (v !== null && v !== undefined) {
          let ref = N.firstChild(idOf(this));
          while (ref !== 0 && (N.nodeType(ref) !== 1 || N.localName(ref) === 'caption' || N.localName(ref) === 'colgroup')) ref = N.nextSibling(ref);
          L.preInsert(this, v, wrap(ref), 'tHead');
        }
      },
      createTHead() {
        const c = firstChildByName(idOf(this), 'thead');
        if (c !== 0) return wrap(c);
        let ref = N.firstChild(idOf(this));
        while (ref !== 0 && (N.nodeType(ref) !== 1 || N.localName(ref) === 'caption' || N.localName(ref) === 'colgroup')) ref = N.nextSibling(ref);
        return createChild(this, 'thead', ref);
      },
      deleteTHead() { const c = firstChildByName(idOf(this), 'thead'); if (c !== 0) L.removeCore(idOf(this), this, c); },
      get tFoot() { return wrap(firstChildByName(idOf(this), 'tfoot')); },
      set tFoot(v) { this.deleteTFoot(); if (v !== null && v !== undefined) L.preInsert(this, v, null, 'tFoot'); },
      createTFoot() {
        const c = firstChildByName(idOf(this), 'tfoot');
        if (c !== 0) return wrap(c);
        return createChild(this, 'tfoot', 0);
      },
      deleteTFoot() { const c = firstChildByName(idOf(this), 'tfoot'); if (c !== 0) L.removeCore(idOf(this), this, c); },
      get tBodies() { const id = idOf(this); return cachedColl(this, 'tbodies', () => L.makeHTMLCollection({ kind: 3, compute: () => childrenByName(id, ['tbody']) }, false)); },
      createTBody() {
        const bodies = childrenByName(idOf(this), ['tbody']);
        const ref = bodies.length ? N.nextSibling(bodies[bodies.length - 1]) : 0;
        return createChild(this, 'tbody', ref);
      },
      get rows() { const id = idOf(this); return cachedColl(this, 'rows', () => L.makeHTMLCollection({ kind: 3, compute: () => tableRows(id) }, true)); },
      insertRow(index = -1) {
        const i = L.toLong(index);
        const rows = tableRows(idOf(this));
        if (i < -1 || i > rows.length) throw new DOMException(`Failed to execute 'insertRow' on 'HTMLTableElement': The index provided (${i}) is outside the range [-1, ${rows.length}].`, 'IndexSizeError');
        const tr = L.document.createElement('tr');
        if (rows.length === 0) {
          const bodies = childrenByName(idOf(this), ['tbody']);
          if (bodies.length) L.preInsert(wrap(bodies[bodies.length - 1]), tr, null, 'insertRow');
          else { const tb = createChild(this, 'tbody', 0); L.preInsert(tb, tr, null, 'insertRow'); }
        } else if (i === -1 || i === rows.length) {
          const last = rows[rows.length - 1];
          L.preInsert(wrap(N.parent(last)), tr, null, 'insertRow');
        } else {
          const ref = rows[i];
          L.preInsert(wrap(N.parent(ref)), tr, wrap(ref), 'insertRow');
        }
        return tr;
      },
      deleteRow(index) {
        const i = L.toLong(index);
        const rows = tableRows(idOf(this));
        const r = i === -1 ? rows[rows.length - 1] : rows[i];
        if (i === -1 && rows.length === 0) return;
        if (r === undefined) throw new DOMException(`Failed to execute 'deleteRow' on 'HTMLTableElement': The index provided (${i}) is outside the range [-1, ${rows.length}].`, 'IndexSizeError');
        L.removeCore(N.parent(r), undefined, r);
      },
    });
  }
  const HTMLTableSectionElement = htmlClass('HTMLTableSectionElement', ['thead', 'tbody', 'tfoot']);
  {
    const P = HTMLTableSectionElement.prototype;
    for (const p of ['align', 'ch', 'chOff', 'vAlign']) R.str(P, p, p === 'ch' ? 'char' : p === 'chOff' ? 'charoff' : p.toLowerCase());
    L.mixin(P, {
      get rows() { const id = idOf(this); return cachedColl(this, 'rows', () => L.makeHTMLCollection({ kind: 3, compute: () => childrenByName(id, ['tr']) }, true)); },
      insertRow(index = -1) {
        const i = L.toLong(index);
        const rows = childrenByName(idOf(this), ['tr']);
        if (i < -1 || i > rows.length) throw new DOMException(`Failed to execute 'insertRow' on 'HTMLTableSectionElement': The provided index (${i}) is outside the range [-1, ${rows.length}].`, 'IndexSizeError');
        const tr = L.document.createElement('tr');
        L.preInsert(this, tr, i === -1 || i === rows.length ? null : wrap(rows[i]), 'insertRow');
        return tr;
      },
      deleteRow(index) {
        const i = L.toLong(index);
        const rows = childrenByName(idOf(this), ['tr']);
        if (i === -1) { if (rows.length) L.removeCore(idOf(this), this, rows[rows.length - 1]); return; }
        if (i < 0 || i >= rows.length) throw new DOMException(`Failed to execute 'deleteRow' on 'HTMLTableSectionElement': The provided index (${i}) is outside the range [-1, ${rows.length}].`, 'IndexSizeError');
        L.removeCore(idOf(this), this, rows[i]);
      },
    });
  }
  const HTMLTableRowElement = htmlClass('HTMLTableRowElement', ['tr']);
  {
    const P = HTMLTableRowElement.prototype;
    for (const p of ['align', 'ch', 'chOff', 'vAlign', 'bgColor']) R.str(P, p, p === 'ch' ? 'char' : p === 'chOff' ? 'charoff' : p.toLowerCase());
    L.mixin(P, {
      get rowIndex() {
        const id = idOf(this);
        let t = N.parent(id);
        if (t !== 0 && N.localName(t) !== 'table') t = N.parent(t);
        if (t === 0 || N.localName(t) !== 'table') return -1;
        return tableRows(t).indexOf(id);
      },
      get sectionRowIndex() {
        const id = idOf(this);
        const p = N.parent(id);
        if (p === 0) return -1;
        return childrenByName(p, ['tr']).indexOf(id);
      },
      get cells() { const id = idOf(this); return cachedColl(this, 'cells', () => L.makeHTMLCollection({ kind: 3, compute: () => childrenByName(id, ['td', 'th']) }, true)); },
      insertCell(index = -1) {
        const i = L.toLong(index);
        const cells = childrenByName(idOf(this), ['td', 'th']);
        if (i < -1 || i > cells.length) throw new DOMException(`Failed to execute 'insertCell' on 'HTMLTableRowElement': The value provided (${i}) is outside the range [-1, ${cells.length}].`, 'IndexSizeError');
        const td = L.document.createElement('td');
        L.preInsert(this, td, i === -1 || i === cells.length ? null : wrap(cells[i]), 'insertCell');
        return td;
      },
      deleteCell(index) {
        const i = L.toLong(index);
        const cells = childrenByName(idOf(this), ['td', 'th']);
        if (i === -1) { if (cells.length) L.removeCore(idOf(this), this, cells[cells.length - 1]); return; }
        if (i < 0 || i >= cells.length) throw new DOMException(`Failed to execute 'deleteCell' on 'HTMLTableRowElement': The value provided (${i}) is outside the range [0, ${cells.length}).`, 'IndexSizeError');
        L.removeCore(idOf(this), this, cells[i]);
      },
    });
  }
  const HTMLTableCellElement = htmlClass('HTMLTableCellElement', ['td', 'th']);
  {
    const P = HTMLTableCellElement.prototype;
    R.ulong(P, 'colSpan', 'colspan', 1, 1, 1000);
    R.ulong(P, 'rowSpan', 'rowspan', 1, 0, 65534);
    for (const p of ['headers', 'abbr', 'align', 'axis', 'height', 'width', 'ch', 'chOff', 'vAlign', 'bgColor']) R.str(P, p, p === 'ch' ? 'char' : p === 'chOff' ? 'charoff' : p.toLowerCase());
    R.enumerated(P, 'scope', 'scope', ['row', 'col', 'rowgroup', 'colgroup'], '', '');
    R.bool(P, 'noWrap', 'nowrap');
    def(P, 'cellIndex', function () {
      const id = idOf(this);
      const p = N.parent(id);
      if (p === 0 || N.localName(p) !== 'tr') return -1;
      return childrenByName(p, ['td', 'th']).indexOf(id);
    });
  }
  const HTMLTableColElement = htmlClass('HTMLTableColElement', ['col', 'colgroup']);
  R.ulong(HTMLTableColElement.prototype, 'span', 'span', 1, 1, 1000);
  for (const p of ['align', 'ch', 'chOff', 'vAlign', 'width']) R.str(HTMLTableColElement.prototype, p, p === 'ch' ? 'char' : p === 'chOff' ? 'charoff' : p.toLowerCase());
  const HTMLTableCaptionElement = htmlClass('HTMLTableCaptionElement', ['caption']);
  R.str(HTMLTableCaptionElement.prototype, 'align');

  // --- template ---
  const HTMLTemplateElement = htmlClass('HTMLTemplateElement', ['template']);
  const templateContent = new WeakMap(); // template wrapper -> fragment id (fallback model)
  let templatesExtracted = 0;
  // Preferred: the native keeps the template -> content fragment association (so its
  // innerHTML/outerHTML serialization, setInnerHTML and cloneNode see the contents).
  const nativeTemplates = typeof N.templateContent === 'function';
  L.templateInfo = function (el) {
    if (nativeTemplates) {
      const id = idOf(el);
      if (N.firstChild(id) !== 0) L.treeChanged(); // the parsed children are about to move
      return N.templateContent(id);
    }
    let f = templateContent.get(el);
    if (f === undefined) {
      f = N.createFragment();
      const id = idOf(el);
      let c, moved = false;
      while ((c = N.firstChild(id)) !== 0) { N.appendChild(f, c); moved = true; }
      templateContent.set(el, f);
      templatesExtracted++;
      if (moved) L.treeChanged();
    }
    return f;
  };
  {
    const P = HTMLTemplateElement.prototype;
    def(P, 'content', function () { return wrap(L.templateInfo(this)); });
    R.enumerated(P, 'shadowRootMode', 'shadowrootmode', ['open', 'closed'], '', '');
    R.bool(P, 'shadowRootDelegatesFocus', 'shadowrootdelegatesfocus');
    R.bool(P, 'shadowRootClonable', 'shadowrootclonable');
    R.bool(P, 'shadowRootSerializable', 'shadowrootserializable');
  }
  // Cloning: template contents and form control state
  L.cloneHooks.push(function (src, clone, deep) {
    if (typeOf(src) === 1 && lnOf(src) === 'template' && nsOf(src) === HTML && templateContent.has(src) && deep) {
      const cf = N.cloneNode(templateContent.get(src), true);
      templateContent.set(clone, cf);
      templatesExtracted++;
    }
    if (deep && templatesExtracted > 0) {
      const sid = idOf(src), cid = idOf(clone);
      if (N.firstChild(sid) !== 0) {
        const a = N.querySelectorAll(sid, 'template'), b = N.querySelectorAll(cid, 'template');
        for (let i = 0; i < a.length && i < b.length; i++) {
          const sw = L.cache.get(a[i]);
          if (sw !== undefined && templateContent.has(sw)) {
            const cw = wrap(b[i]);
            templateContent.set(cw, N.cloneNode(templateContent.get(sw), true));
            templatesExtracted++;
          }
        }
      }
    }
    if (typeOf(src) === 1) {
      copyFormState(idOf(src), idOf(clone), src);
      if (deep && N.firstChild(idOf(src)) !== 0) {
        const a = N.querySelectorAll(idOf(src), 'input,textarea,select'), b = a.length ? N.querySelectorAll(idOf(clone), 'input,textarea,select') : [];
        for (let i = 0; i < a.length && i < b.length; i++) copyFormState(a[i], b[i], null);
      }
    }
  });
  function copyFormState(s, c, sw) {
    const ln = sw !== null ? lnOf(sw) : N.localName(s);
    if (ln === 'input') {
      const type = (N.getAttr(s, 'type') || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') { const v = N.getChecked(s); if (v !== N.getChecked(c)) N.setChecked(c, v); }
      else if (valueModeOf(type) === 'value') { const v = N.getValue(s); if (v !== N.getValue(c)) N.setValue(c, v); }
    } else if (ln === 'textarea') {
      const v = N.getValue(s); if (v !== N.getValue(c)) N.setValue(c, v);
    } else if (ln === 'select') {
      const v = N.getSelectedIndex(s); if (v !== N.getSelectedIndex(c)) N.setSelectedIndex(c, v);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Forms
  // ---------------------------------------------------------------------------------------
  const LISTED = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);
  const SUBMITTABLE = new Set(['button', 'input', 'select', 'textarea']);
  const LABELABLE = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
  function isFACE(el) { const d = L.ceState.get(el); return d !== undefined && d !== L.CE_FAILED && d.formAssociated; }
  function formOwnerOf(el) {
    const id = idOf(el);
    const ln = lnOf(el);
    if (nsOf(el) !== HTML) return null;
    if (LISTED.has(ln) || isFACE(el)) {
      const f = N.getAttr(id, 'form');
      if (f !== null) {
        const t = N.isConnected(id) ? N.getElementById(f) : 0;
        return t !== 0 && N.localName(t) === 'form' ? wrap(t) : null;
      }
    }
    if (ln === 'legend') {
      const p = N.parent(id);
      return p !== 0 && N.localName(p) === 'fieldset' ? formOwnerOf(wrap(p)) : null;
    }
    if (ln === 'option') {
      let p = N.parent(id);
      if (p !== 0 && N.localName(p) === 'optgroup') p = N.parent(p);
      return p !== 0 && N.localName(p) === 'select' ? formOwnerOf(wrap(p)) : null;
    }
    const p = N.parent(id);
    if (p === 0) return null;
    const f = N.closest(p, 'form');
    return f === 0 ? null : wrap(f);
  }
  L.formOwnerOf = formOwnerOf;
  function formElementIds(form) {
    const fid = idOf(form);
    const ids = N.querySelectorAll(fid, 'button,fieldset,input,object,output,select,textarea');
    const out = [];
    for (const id of ids) {
      const w = wrap(id);
      if (formOwnerOf(w) === form) out.push(id);
    }
    const fAttr = N.getAttr(fid, 'id');
    if (fAttr !== null && fAttr !== '' && N.isConnected(fid)) {
      const extra = N.querySelectorAll(L.documentId, '[form=' + L.cssString(fAttr) + ']');
      if (extra.length) {
        for (const id of extra) if (!out.includes(id) && LISTED.has(N.localName(id)) && formOwnerOf(wrap(id)) === form) out.push(id);
        out.sort((a, b) => (N.compareDocumentPosition(a, b) & 4 ? -1 : 1));
      }
    }
    return out;
  }
  function formControlIds(form) {
    return formElementIds(form).filter((id) => !(N.localName(id) === 'input' && (N.getAttr(id, 'type') || '').toLowerCase() === 'image'));
  }
  class HTMLFormControlsCollection extends L.HTMLCollection {
    namedItem(name) {
      const n = `${name}`;
      if (n === '') return null;
      const ids = L.hcIds(L.hcData(this)).filter((id) => N.getAttr(id, 'id') === n || N.getAttr(id, 'name') === n);
      if (ids.length === 0) return null;
      if (ids.length === 1) return wrap(ids[0]);
      return new RadioNodeList(INTERNAL, ids);
    }
  }
  class RadioNodeList extends L.NodeList {
    constructor(token, ids) { super(token, 0, ids); }
    get value() {
      for (const id of L.nlIds(this)) {
        if (N.localName(id) === 'input' && (N.getAttr(id, 'type') || '').toLowerCase() === 'radio' && N.getChecked(id)) {
          const v = N.getAttr(id, 'value');
          return v === null ? 'on' : v;
        }
      }
      return '';
    }
    set value(v) {
      const s = `${v}`;
      for (const id of L.nlIds(this)) {
        if (N.localName(id) === 'input' && (N.getAttr(id, 'type') || '').toLowerCase() === 'radio') {
          const val = N.getAttr(id, 'value');
          if ((val === null ? 'on' : val) === s) { setChecked(wrap(id), true); return; }
        }
      }
    }
  }
  const formHandler = {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t)) {
        if (/^(0|[1-9][0-9]*)$/.test(p)) {
          const id = formControlIds(r)[+p];
          return id === undefined ? undefined : wrap(id);
        }
        const v = formNamedProperty(r, p);
        if (v !== undefined) return v;
      }
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      if (Reflect.has(t, p)) return true;
      return false;
    },
  };
  function formNamedProperty(form, name) {
    if (name === '') return undefined;
    const ids = formControlIds(form).filter((id) => N.getAttr(id, 'id') === name || N.getAttr(id, 'name') === name);
    if (ids.length === 1) return wrap(ids[0]);
    if (ids.length > 1) return new RadioNodeList(INTERNAL, ids);
    const img = N.querySelectorAll(idOf(form), 'img').filter((id) => N.getAttr(id, 'id') === name || N.getAttr(id, 'name') === name);
    if (img.length) return wrap(img[0]);
    return undefined;
  }
  L.elementWrapperMakers.set('form', (proto) => new Proxy(Object.create(proto), formHandler));

  const HTMLFormElement = htmlClass('HTMLFormElement', ['form']);
  const submittingForms = new WeakSet();
  {
    const P = HTMLFormElement.prototype;
    R.str(P, 'acceptCharset', 'accept-charset'); R.str(P, 'name'); R.str(P, 'target'); R.str(P, 'rel');
    R.tokens(P, 'relList', 'rel', ['noreferrer', 'noopener', 'opener']);
    R.bool(P, 'noValidate', 'novalidate');
    R.enumerated(P, 'autocomplete', 'autocomplete', ['on', 'off'], 'on', 'on');
    R.enumerated(P, 'enctype', 'enctype', ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'], 'application/x-www-form-urlencoded', 'application/x-www-form-urlencoded');
    R.enumerated(P, 'encoding', 'enctype', ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'], 'application/x-www-form-urlencoded', 'application/x-www-form-urlencoded');
    R.enumerated(P, 'method', 'method', ['get', 'post', 'dialog'], 'get', 'get');
    def(P, 'action', function () {
      const v = N.getAttr(idOf(this), 'action');
      if (v === null || v === '') return L.documentURL();
      const r = L.resolveURL(v);
      return r === null ? v : r;
    }, function (v) { setAttr(this, idOf(this), 'action', `${v}`); });
    L.mixin(P, {
      get elements() {
        const form = this;
        return cachedColl(this, 'elements', () => L.makeHTMLCollection({ kind: 3, compute: () => formControlIds(form) }, true, HTMLFormControlsCollection));
      },
      get length() { return formControlIds(this).length; },
      submit() {
        const id = idOf(this);
        if (!N.isConnected(id)) return;
        N.submitForm(id, 0);
        L.bumpAll();
      },
      requestSubmit(submitter) {
        if (submitter !== undefined && submitter !== null) {
          if (!isNode(submitter) || !isSubmitButton(submitter)) throw new TypeError("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not a submit button.");
          if (formOwnerOf(submitter) !== this) throw new DOMException("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not owned by this form element.", 'NotFoundError');
        }
        submitFormAlgorithm(this, submitter || null);
      },
      reset() { resetForm(this); },
      checkValidity() { return formCheckValidity(this, false); },
      reportValidity() { return formCheckValidity(this, true); },
    });
  }
  function isSubmitButton(el) {
    const ln = lnOf(el);
    if (nsOf(el) !== HTML) return false;
    if (ln === 'button') return buttonType(el) === 'submit';
    if (ln === 'input') { const t = inputType(el); return t === 'submit' || t === 'image'; }
    return false;
  }
  function submitFormAlgorithm(form, submitter) {
    const fid = idOf(form);
    if (!N.isConnected(fid)) return;
    if (submittingForms.has(form)) return;
    const noValidate = N.hasAttr(fid, 'novalidate') || (submitter !== null && N.hasAttr(idOf(submitter), 'formnovalidate'));
    if (!noValidate && !formCheckValidity(form, true)) return;
    submittingForms.add(form);
    let ok;
    try {
      ok = L.fire(form, 'submit', { bubbles: true, cancelable: true, submitter }, L.SubmitEvent);
    } finally {
      submittingForms.delete(form);
    }
    if (!ok) return;
    const method = submitter !== null && N.hasAttr(idOf(submitter), 'formmethod') ? (N.getAttr(idOf(submitter), 'formmethod') || '').toLowerCase() : (N.getAttr(fid, 'method') || '').toLowerCase();
    if (method === 'dialog') {
      const d = N.closest(fid, 'dialog');
      if (d !== 0) wrap(d).close(submitter !== null ? submitter.value : undefined);
      return;
    }
    const action = submitter !== null && N.hasAttr(idOf(submitter), 'formaction') ? N.getAttr(idOf(submitter), 'formaction') : N.getAttr(fid, 'action');
    if (action !== null && /^\s*javascript:/i.test(action)) {
      runJavascriptURL(action);
      return;
    }
    N.submitForm(fid, submitter !== null ? idOf(submitter) : 0);
    L.bumpAll();
  }
  L.submitFormAlgorithm = submitFormAlgorithm;
  function runJavascriptURL(url) {
    let code = url.replace(/^\s*javascript:/i, '');
    try { code = decodeURIComponent(code); } catch (_) { /* keep raw */ }
    try { N.evalScript(code, L.documentURL(), true); } catch (e) { L.reportScriptError(e); }
  }
  L.runJavascriptURL = runJavascriptURL;
  function resetForm(form) {
    if (!L.fire(form, 'reset', { bubbles: true, cancelable: true })) return;
    for (const id of formElementIds(form)) resetControl(wrap(id));
  }
  function resetControl(el) {
    const id = idOf(el);
    const ln = lnOf(el);
    if (ln === 'input') {
      const t = inputType(el);
      if (t === 'checkbox' || t === 'radio') N.setChecked(id, N.hasAttr(id, 'checked'));
      else if (valueModeOf(t) === 'value') N.setValue(id, sanitizeValue(t, N.getAttr(id, 'value') || '', el));
      selectionState.delete(el);
    } else if (ln === 'textarea') {
      N.setValue(id, N.textContent(id));
      selectionState.delete(el);
    } else if (ln === 'select') {
      const opts = selectOptionIds(id);
      let idx = -1;
      for (let i = 0; i < opts.length; i++) if (N.hasAttr(opts[i], 'selected')) idx = i;
      if (idx === -1 && !N.hasAttr(id, 'multiple') && opts.length) idx = 0;
      N.setSelectedIndex(id, idx);
      multiSelected.delete(el);
    } else if (ln === 'output') {
      const d = outputDefault.get(el);
      if (d !== undefined) { L.textContentSet(el, d); outputDefault.delete(el); }
    }
    const def2 = L.ceState.get(el);
    if (def2 !== undefined && def2 !== L.CE_FAILED && def2.formAssociated) L.ceCallback(el, def2, 'formResetCallback', []);
    state.attr++;
  }
  function formCheckValidity(form, report) {
    let ok = true;
    let first = null;
    for (const id of formElementIds(form)) {
      const el = wrap(id);
      if (!willValidate(el)) continue;
      if (!isValid(el)) {
        ok = false;
        const notCanceled = L.fire(el, 'invalid', { cancelable: true });
        if (report && notCanceled && first === null) first = el;
      }
    }
    if (first !== null) focusElement(first);
    return ok;
  }

  // Disabled state
  function isDisabledFormControl(el) {
    if (nsOf(el) !== HTML) return false;
    const ln = lnOf(el);
    if (!(ln === 'button' || ln === 'input' || ln === 'select' || ln === 'textarea' || ln === 'fieldset' || ln === 'optgroup' || ln === 'option' || isFACE(el))) return false;
    const id = idOf(el);
    if (N.hasAttr(id, 'disabled')) return true;
    if (ln === 'option') {
      const p = N.parent(id);
      return p !== 0 && N.localName(p) === 'optgroup' && N.hasAttr(p, 'disabled');
    }
    if (ln === 'optgroup') return false;
    let f = N.parent(id) === 0 ? 0 : N.closest(N.parent(id), 'fieldset[disabled]');
    while (f !== 0) {
      const legend = firstChildByName(f, 'legend');
      if (legend === 0 || !N.contains(legend, id)) return true;
      const p = N.parent(f);
      f = p === 0 ? 0 : N.closest(p, 'fieldset[disabled]');
    }
    return false;
  }
  L.isDisabledFormControl = isDisabledFormControl;

  // Constraint validation
  const customValidity = new WeakMap();
  function willValidate(el) {
    const ln = lnOf(el);
    if (!SUBMITTABLE.has(ln) && !isFACE(el)) return false;
    if (isDisabledFormControl(el)) return false;
    const id = idOf(el);
    if (N.closest(id, 'datalist') !== 0) return false;
    if (ln === 'input') {
      const t = inputType(el);
      if (t === 'hidden' || t === 'reset' || t === 'button') return false;
      if (N.hasAttr(id, 'readonly') && !['checkbox', 'radio', 'file', 'color', 'range'].includes(t)) return false;
    }
    if (ln === 'button' && buttonType(el) !== 'submit') return false;
    if (ln === 'textarea' && N.hasAttr(id, 'readonly')) return false;
    return true;
  }
  const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  function validityOf(el) {
    const f = {};
    const id = idOf(el);
    const cv = customValidity.get(el);
    if (cv) f.customError = true;
    const ln = lnOf(el);
    if (ln === 'input') {
      const t = inputType(el);
      const req = N.hasAttr(id, 'required');
      if (t === 'checkbox') { if (req && !N.getChecked(id)) f.valueMissing = true; return f; }
      if (t === 'radio') {
        if (req || radioGroupRequired(el)) { if (!radioGroupIds(el).some((r) => N.getChecked(r))) f.valueMissing = true; }
        return f;
      }
      if (t === 'file') { if (req && fileListOf(el).length === 0) f.valueMissing = true; return f; }
      if (valueModeOf(t) !== 'value') return f;
      const v = N.getValue(id);
      if (req && v === '') f.valueMissing = true;
      if (v === '') return f;
      if (t === 'email') {
        const parts = N.hasAttr(id, 'multiple') ? v.split(',').map((s) => s.trim()) : [v];
        if (parts.some((p) => !EMAIL_RE.test(p))) f.typeMismatch = true;
      } else if (t === 'url') {
        if (N.urlParse(v, null) === null) f.typeMismatch = true;
      }
      const pattern = N.getAttr(id, 'pattern');
      if (pattern !== null && ['text', 'search', 'url', 'tel', 'email', 'password'].includes(t)) {
        let re = null;
        try { re = new RegExp('^(?:' + pattern + ')$', 'v'); } catch (_) { try { re = new RegExp('^(?:' + pattern + ')$', 'u'); } catch (_2) { re = null; } }
        if (re !== null) {
          const vals = t === 'email' && N.hasAttr(id, 'multiple') ? v.split(',').map((s) => s.trim()) : [v];
          if (vals.some((x) => !re.test(x))) f.patternMismatch = true;
        }
      }
      if (t === 'number' || t === 'range') {
        const n = parseFloat(v);
        const min = parseFloatAttr(N.getAttr(id, 'min') || '');
        const max = parseFloatAttr(N.getAttr(id, 'max') || '');
        if (min !== null && n < min) f.rangeUnderflow = true;
        if (max !== null && n > max) f.rangeOverflow = true;
        const stepAttr = N.getAttr(id, 'step');
        if (stepAttr === null || stepAttr.toLowerCase() !== 'any') {
          const step = stepAttr !== null && parseFloatAttr(stepAttr) > 0 ? parseFloatAttr(stepAttr) : 1;
          const base = min !== null ? min : parseFloatAttr(N.getAttr(id, 'value') || '') || 0;
          const q = (n - base) / step;
          if (Math.abs(q - Math.round(q)) > 1e-7) f.stepMismatch = true;
        }
      } else if (['date', 'month', 'week', 'time', 'datetime-local'].includes(t)) {
        const min = N.getAttr(id, 'min'), max = N.getAttr(id, 'max');
        if (min && v < min) f.rangeUnderflow = true;
        if (max && v > max) f.rangeOverflow = true;
      }
      return f;
    }
    if (ln === 'textarea') {
      if (N.hasAttr(id, 'required') && N.getValue(id) === '') f.valueMissing = true;
      return f;
    }
    if (ln === 'select') {
      if (N.hasAttr(id, 'required')) {
        const opts = selectOptionIds(id);
        const sel = selectedOptionIds(el);
        if (sel.length === 0) f.valueMissing = true;
        else if (!N.hasAttr(id, 'multiple') && Number(N.getAttr(id, 'size') || 1) <= 1 && sel.length === 1 && sel[0] === opts[0] && optionValue(opts[0]) === '' && N.parent(opts[0]) === id) f.valueMissing = true;
      }
      return f;
    }
    return f;
  }
  function isValid(el) { const f = validityOf(el); return !VALIDITY_KEYS.some((k) => f[k]); }
  function validationMessageOf(el) {
    if (!willValidate(el)) return '';
    const f = validityOf(el);
    const id = idOf(el);
    if (f.customError) return customValidity.get(el);
    if (f.valueMissing) {
      const ln = lnOf(el);
      if (ln === 'select') return 'Please select an item in the list.';
      if (ln === 'input') {
        const t = inputType(el);
        if (t === 'checkbox') return 'Please check this box if you want to proceed.';
        if (t === 'radio') return 'Please select one of these options.';
        if (t === 'file') return 'Please select a file.';
      }
      return 'Please fill out this field.';
    }
    if (f.typeMismatch) {
      const v = N.getValue(id);
      if (inputType(el) === 'email') return v.includes('@') ? `Please enter a part following '@'. '${v}' is incomplete.` : `Please include an '@' in the email address. '${v}' is missing an '@'.`;
      return 'Please enter a URL.';
    }
    if (f.patternMismatch) return 'Please match the requested format.';
    if (f.rangeUnderflow) return `Value must be greater than or equal to ${N.getAttr(id, 'min')}.`;
    if (f.rangeOverflow) return `Value must be less than or equal to ${N.getAttr(id, 'max')}.`;
    if (f.stepMismatch) return 'Please enter a valid value.';
    return '';
  }
  const ConstraintValidation = {
    get willValidate() { return willValidate(this); },
    get validity() { const el = this; return new ValidityState(INTERNAL, () => (willValidate(el) ? validityOf(el) : {})); },
    get validationMessage() { return validationMessageOf(this); },
    checkValidity() {
      if (!willValidate(this) || isValid(this)) return true;
      L.fire(this, 'invalid', { cancelable: true });
      return false;
    },
    reportValidity() {
      if (!willValidate(this) || isValid(this)) return true;
      if (L.fire(this, 'invalid', { cancelable: true })) focusElement(this);
      return false;
    },
    setCustomValidity(error) {
      const s = `${error}`;
      if (s === '') customValidity.delete(this); else customValidity.set(this, s);
    },
    get labels() { return labelsFor(this); },
    get form() { return formOwnerOf(this); },
  };
  function labelsFor(el) {
    const id = idOf(el);
    const out = [];
    if (!N.isConnected(id)) {
      const c = N.closest(id, 'label');
      if (c !== 0 && labelControlId(c) === id) out.push(c);
      return L.staticNodeListW(out.map(wrap));
    }
    for (const l of N.querySelectorAll(L.documentId, 'label')) if (labelControlId(l) === id) out.push(l);
    return L.staticNodeListW(out.map(wrap));
  }
  function isLabelable(id) {
    if (N.nodeType(id) !== 1 || N.namespaceURI(id) !== L.NS.HTML) return false;
    const ln = N.localName(id);
    if (ln === 'input') return (N.getAttr(id, 'type') || '').toLowerCase() !== 'hidden';
    if (LABELABLE.has(ln)) return true;
    const w = L.cache.get(id);
    return w !== undefined && isFACE(w);
  }
  function labelControlId(lid) {
    const f = N.getAttr(lid, 'for');
    if (f !== null) {
      const t = N.isConnected(lid) ? N.getElementById(f) : N.querySelector(rootOfId(lid), '#' + L.cssEscape(f));
      return t !== 0 && isLabelable(t) ? t : 0;
    }
    for (const d of N.querySelectorAll(lid, 'button,input,meter,output,progress,select,textarea')) if (isLabelable(d)) return d;
    return 0;
  }
  function rootOfId(id) { let r = id, p; while ((p = N.parent(r)) !== 0) r = p; return r; }

  // --- input ---
  const INPUT_TYPES = ['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time',
    'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button'];
  const INPUT_TYPE_SET = new Set(INPUT_TYPES);
  function inputType(el) {
    const v = N.getAttr(idOf(el), 'type');
    if (v === null) return 'text';
    const l = L.asciiLower(v);
    return INPUT_TYPE_SET.has(l) ? l : 'text';
  }
  L.inputType = inputType;
  function valueModeOf(t) {
    switch (t) {
      case 'hidden': case 'submit': case 'image': case 'reset': case 'button': return 'default';
      case 'checkbox': case 'radio': return 'default/on';
      case 'file': return 'filename';
      default: return 'value';
    }
  }
  const SELECTION_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);
  function sanitizeValue(t, v, el) {
    switch (t) {
      case 'text': case 'search': case 'tel': case 'password': return v.replace(/[\r\n]/g, '');
      case 'url': return L.stripWS(v.replace(/[\r\n]/g, ''));
      case 'email': return N.hasAttr(idOf(el), 'multiple') ? v.split(',').map((s) => L.stripWS(s)).join(',') : L.stripWS(v.replace(/[\r\n]/g, ''));
      case 'number': return /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(v) && Number.isFinite(parseFloat(v)) ? v : '';
      case 'range': {
        const id = idOf(el);
        const min = parseFloatAttr(N.getAttr(id, 'min') || '') ?? 0;
        let max = parseFloatAttr(N.getAttr(id, 'max') || '') ?? 100;
        if (max < min) max = min;
        let n = parseFloat(v);
        if (!Number.isFinite(n)) n = max < min ? min : min + (max - min) / 2;
        n = Math.min(max, Math.max(min, n));
        return String(n);
      }
      case 'color': return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#000000';
      case 'date': return /^\d{4,}-\d{2}-\d{2}$/.test(v) ? v : '';
      case 'month': return /^\d{4,}-\d{2}$/.test(v) ? v : '';
      case 'week': return /^\d{4,}-W\d{2}$/.test(v) ? v : '';
      case 'time': return /^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(v) ? v : '';
      case 'datetime-local': return /^\d{4,}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(v) ? v.replace(' ', 'T') : '';
      default: return v;
    }
  }
  const selectionState = new WeakMap(); // el -> {start, end, dir}
  const indeterminate = new WeakMap();
  // mirror to the native (optional N.setIndeterminate) so :indeterminate matches
  function setIndeterminate(el, v) {
    indeterminate.set(el, v);
    if (typeof N.setIndeterminate === 'function') { try { N.setIndeterminate(idOf(el), v); } catch (_) { /* optional */ } }
  }
  const fileLists = new WeakMap();
  function fileListOf(el) {
    let f = fileLists.get(el);
    if (f === undefined) { f = L.createFileList([]); fileLists.set(el, f); }
    return f;
  }
  function radioGroupIds(el) {
    const id = idOf(el);
    const name = N.getAttr(id, 'name');
    if (name === null || name === '') return [id];
    const form = formOwnerOf(el);
    const scope = form !== null ? idOf(form) : rootOfId(id);
    const out = [];
    for (const r of N.querySelectorAll(scope, 'input[type=radio i]')) {
      if (N.getAttr(r, 'name') !== name) continue;
      if (formOwnerOf(wrap(r)) !== form) continue;
      out.push(r);
    }
    if (!out.includes(id)) out.push(id);
    return out;
  }
  function radioGroupRequired(el) { return radioGroupIds(el).some((r) => N.hasAttr(r, 'required')); }
  function setChecked(el, v) {
    const id = idOf(el);
    const b = !!v;
    N.setChecked(id, b);
    if (b && inputType(el) === 'radio') {
      for (const r of radioGroupIds(el)) if (r !== id && N.getChecked(r)) N.setChecked(r, false);
    }
    state.attr++;
  }
  L.setChecked = setChecked;
  function selectionAllowed(el) { return SELECTION_TYPES.has(inputType(el)); }
  function selState(el) {
    let s = selectionState.get(el);
    const len = N.getValue(idOf(el)).length;
    if (s === undefined) { s = { start: len, end: len, dir: 'none' }; selectionState.set(el, s); }
    if (s.start > len) s.start = len;
    if (s.end > len) s.end = len;
    return s;
  }
  const SelectionAPI = {
    select() {
      if (lnOf(this) === 'input' && !selectionAllowed(this) && inputType(this) !== 'email' && inputType(this) !== 'number') return;
      const len = N.getValue(idOf(this)).length;
      selectionState.set(this, { start: 0, end: len, dir: 'none' });
      const el = this;
      L.postTask(() => L.fire(el, 'select', { bubbles: true }));
    },
    get selectionStart() {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) return null;
      return selState(this).start;
    },
    set selectionStart(v) {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) throw new DOMException(`Failed to set the 'selectionStart' property on 'HTMLInputElement': The input element's type ('${inputType(this)}') does not support selection.`, 'InvalidStateError');
      const s = selState(this);
      const n = Math.min(L.toULong(v), N.getValue(idOf(this)).length);
      s.start = n;
      if (s.end < n) s.end = n;
    },
    get selectionEnd() {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) return null;
      return selState(this).end;
    },
    set selectionEnd(v) {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) throw new DOMException(`Failed to set the 'selectionEnd' property on 'HTMLInputElement': The input element's type ('${inputType(this)}') does not support selection.`, 'InvalidStateError');
      const s = selState(this);
      const n = Math.min(L.toULong(v), N.getValue(idOf(this)).length);
      s.end = n;
      if (s.start > n) s.start = n;
    },
    get selectionDirection() {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) return null;
      return selState(this).dir;
    },
    set selectionDirection(v) {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) throw new DOMException("Failed to set the 'selectionDirection' property: The input element's type does not support selection.", 'InvalidStateError');
      const d = `${v}`;
      selState(this).dir = d === 'forward' || d === 'backward' ? d : 'none';
    },
    setSelectionRange(start, end, direction) {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) throw new DOMException(`Failed to execute 'setSelectionRange' on 'HTMLInputElement': The input element's type ('${inputType(this)}') does not support selection.`, 'InvalidStateError');
      const len = N.getValue(idOf(this)).length;
      let e = Math.min(L.toULong(end), len);
      const s = Math.min(L.toULong(start), e);
      if (e < s) e = s;
      const d = direction === 'forward' || direction === 'backward' ? direction : 'none';
      selectionState.set(this, { start: s, end: e, dir: d });
    },
    setRangeText(replacement, start, end, selectMode = 'preserve') {
      if (lnOf(this) === 'input' && !selectionAllowed(this)) throw new DOMException("Failed to execute 'setRangeText': The input element's type does not support selection.", 'InvalidStateError');
      const id = idOf(this);
      const val = N.getValue(id);
      const s0 = selState(this);
      let st = start === undefined ? s0.start : L.toULong(start);
      let en = start === undefined ? s0.end : L.toULong(end);
      if (st > en) throw new DOMException("Failed to execute 'setRangeText': The provided start value is larger than the end value.", 'IndexSizeError');
      st = Math.min(st, val.length); en = Math.min(en, val.length);
      const rep = `${replacement}`;
      N.setValue(id, val.slice(0, st) + rep + val.slice(en));
      const newEnd = st + rep.length;
      if (selectMode === 'select') selectionState.set(this, { start: st, end: newEnd, dir: 'none' });
      else if (selectMode === 'start') selectionState.set(this, { start: st, end: st, dir: 'none' });
      else if (selectMode === 'end') selectionState.set(this, { start: newEnd, end: newEnd, dir: 'none' });
      else {
        const delta = rep.length - (en - st);
        let ss = s0.start, se = s0.end;
        if (ss > en) ss += delta; else if (ss > st) ss = st;
        if (se > en) se += delta; else if (se > st) se = newEnd;
        selectionState.set(this, { start: ss, end: se, dir: 'none' });
      }
    },
  };
  const HTMLInputElement = htmlClass('HTMLInputElement', ['input']);
  {
    const P = HTMLInputElement.prototype;
    R.str(P, 'accept'); R.str(P, 'alt'); R.str(P, 'autocomplete'); R.str(P, 'dirName', 'dirname');
    R.bool(P, 'disabled'); R.str(P, 'formEnctype', 'formenctype'); R.str(P, 'formMethod', 'formmethod');
    R.bool(P, 'formNoValidate', 'formnovalidate'); R.str(P, 'formTarget', 'formtarget');
    R.ulong(P, 'height'); R.str(P, 'max'); R.long(P, 'maxLength', 'maxlength', -1, true); R.str(P, 'min');
    R.long(P, 'minLength', 'minlength', -1, true); R.bool(P, 'multiple'); R.str(P, 'name'); R.str(P, 'pattern');
    R.str(P, 'placeholder'); R.bool(P, 'readOnly', 'readonly'); R.bool(P, 'required'); R.ulong(P, 'size', 'size', 20, 1);
    R.url(P, 'src'); R.str(P, 'step'); R.ulong(P, 'width'); R.str(P, 'align'); R.str(P, 'useMap', 'usemap');
    R.str(P, 'capture'); R.bool(P, 'webkitdirectory'); R.bool(P, 'incremental');
    R.str(P, 'popoverTargetAction', 'popovertargetaction');
    def(P, 'formAction', function () {
      const v = N.getAttr(idOf(this), 'formaction');
      if (v === null || v === '') { const f = formOwnerOf(this); return f !== null ? f.action : L.documentURL(); }
      const r = L.resolveURL(v);
      return r === null ? v : r;
    }, function (v) { setAttr(this, idOf(this), 'formaction', `${v}`); });
    L.mixin(P, ConstraintValidation);
    L.mixin(P, SelectionAPI);
    L.mixin(P, {
      get type() { return inputType(this); },
      set type(v) { setAttr(this, idOf(this), 'type', `${v}`); },
      get defaultValue() { return attrOrEmpty(this, 'value'); },
      set defaultValue(v) { setAttr(this, idOf(this), 'value', `${v}`); },
      get value() {
        const t = inputType(this);
        switch (valueModeOf(t)) {
          case 'value': return N.getValue(idOf(this));
          case 'default': return attrOrEmpty(this, 'value');
          case 'default/on': { const v = N.getAttr(idOf(this), 'value'); return v === null ? 'on' : v; }
          default: { const f = fileListOf(this); return f.length ? 'C:\\fakepath\\' + f[0].name : ''; }
        }
      },
      set value(v) {
        const t = inputType(this);
        const s = v === null ? '' : `${v}`;
        switch (valueModeOf(t)) {
          case 'value': {
            const id = idOf(this);
            const nv = sanitizeValue(t, s, this);
            const old = N.getValue(id);
            N.setValue(id, nv);
            if (old !== nv) {
              const len = nv.length;
              selectionState.set(this, { start: len, end: len, dir: 'none' });
            }
            state.attr++;
            break;
          }
          case 'filename':
            if (s !== '') throw new DOMException("Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename, which may only be programmatically set to the empty string.", 'InvalidStateError');
            fileLists.set(this, L.createFileList([]));
            break;
          default:
            setAttr(this, idOf(this), 'value', s);
        }
      },
      get valueAsNumber() {
        const t = inputType(this);
        const v = N.getValue(idOf(this));
        if (v === '') return NaN;
        switch (t) {
          case 'number': case 'range': return parseFloat(v);
          case 'date': { const m = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(v); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
          case 'month': { const m = /^(\d{4,})-(\d{2})$/.exec(v); return m ? (+m[1] - 1970) * 12 + (+m[2] - 1) : NaN; }
          case 'time': { const m = /^(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/.exec(v); return m ? ((+m[1] * 60 + +m[2]) * 60 + (+m[3] || 0)) * 1000 : NaN; }
          case 'datetime-local': { const d = Date.parse(v + 'Z'); return Number.isFinite(d) ? d : NaN; }
          case 'week': { const m = /^(\d{4,})-W(\d{2})$/.exec(v); if (!m) return NaN; const jan4 = Date.UTC(+m[1], 0, 4); const day = (new Date(jan4).getUTCDay() + 6) % 7; return jan4 - day * 864e5 + (+m[2] - 1) * 7 * 864e5; }
          default: return NaN;
        }
      },
      set valueAsNumber(n) {
        const t = inputType(this);
        const num2 = Number(n);
        if (!Number.isFinite(num2) && !Number.isNaN(num2)) throw new TypeError("Failed to set the 'valueAsNumber' property on 'HTMLInputElement': The value provided is infinite.");
        const p = (x, l = 2) => String(x).padStart(l, '0');
        let s = '';
        if (Number.isNaN(num2)) s = '';
        else if (t === 'number' || t === 'range') s = String(num2);
        else if (t === 'date' || t === 'datetime-local') { const d = new Date(num2); s = `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` + (t === 'datetime-local' ? `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : ''); }
        else if (t === 'time') { const d = new Date(num2); s = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` + (d.getUTCSeconds() ? `:${p(d.getUTCSeconds())}` : ''); }
        else if (t === 'month') { const y = Math.floor(num2 / 12) + 1970, m = (num2 % 12 + 12) % 12 + 1; s = `${p(y, 4)}-${p(m)}`; }
        else throw new DOMException("Failed to set the 'valueAsNumber' property on 'HTMLInputElement': This input element does not support Number values.", 'InvalidStateError');
        this.value = s;
      },
      get valueAsDate() {
        const t = inputType(this);
        if (!['date', 'month', 'week', 'time'].includes(t)) return null;
        const n = this.valueAsNumber;
        if (Number.isNaN(n)) return null;
        if (t === 'month') { const y = Math.floor(n / 12) + 1970, m = n % 12; return new Date(Date.UTC(y, m, 1)); }
        return new Date(n);
      },
      set valueAsDate(d) {
        const t = inputType(this);
        if (!['date', 'month', 'week', 'time'].includes(t)) throw new DOMException("Failed to set the 'valueAsDate' property on 'HTMLInputElement': This input element does not support Date values.", 'InvalidStateError');
        if (d === null) { this.value = ''; return; }
        if (!(d instanceof Date)) throw new TypeError("Failed to set the 'valueAsDate' property on 'HTMLInputElement': The provided value is not a Date.");
        if (t === 'month') { this.value = `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; return; }
        this.valueAsNumber = d.getTime();
      },
      get checked() { return N.getChecked(idOf(this)); },
      set checked(v) { setChecked(this, v); },
      get defaultChecked() { return N.hasAttr(idOf(this), 'checked'); },
      set defaultChecked(v) { if (v) setAttr(this, idOf(this), 'checked', ''); else removeAttr(this, idOf(this), 'checked'); },
      get indeterminate() { return !!indeterminate.get(this); },
      set indeterminate(v) { setIndeterminate(this, !!v); state.attr++; },
      get files() { const t = inputType(this); return t === 'file' ? fileListOf(this) : null; },
      set files(v) { if (inputType(this) === 'file' && v !== null && v !== undefined) fileLists.set(this, v); },
      get list() {
        const v = N.getAttr(idOf(this), 'list');
        if (v === null) return null;
        const t = N.getElementById(v);
        return t !== 0 && N.localName(t) === 'datalist' ? wrap(t) : null;
      },
      stepUp(n = 1) { stepBy(this, L.toLong(n)); },
      stepDown(n = 1) { stepBy(this, -L.toLong(n)); },
      showPicker() { },
      get popoverTargetElement() { return null; },
      set popoverTargetElement(v) { },
    });
  }
  function stepBy(el, n) {
    const t = inputType(el);
    if (t !== 'number' && t !== 'range') throw new DOMException("Failed to execute 'stepUp' on 'HTMLInputElement': This form element is not steppable.", 'InvalidStateError');
    const id = idOf(el);
    const stepAttr = N.getAttr(id, 'step');
    if (stepAttr !== null && stepAttr.toLowerCase() === 'any') throw new DOMException("Failed to execute 'stepUp' on 'HTMLInputElement': This form element does not have an allowed value step.", 'InvalidStateError');
    const step = stepAttr !== null && parseFloatAttr(stepAttr) > 0 ? parseFloatAttr(stepAttr) : 1;
    let v = parseFloat(N.getValue(id));
    if (!Number.isFinite(v)) v = 0;
    let nv = v + step * n;
    const min = parseFloatAttr(N.getAttr(id, 'min') || ''), max = parseFloatAttr(N.getAttr(id, 'max') || '');
    if (min !== null && nv < min) nv = min;
    if (max !== null && nv > max) nv = max;
    N.setValue(id, String(Math.round(nv * 1e10) / 1e10));
  }

  // --- textarea ---
  const HTMLTextAreaElement = htmlClass('HTMLTextAreaElement', ['textarea']);
  {
    const P = HTMLTextAreaElement.prototype;
    R.str(P, 'autocomplete'); R.ulong(P, 'cols', 'cols', 20, 1); R.str(P, 'dirName', 'dirname'); R.bool(P, 'disabled');
    R.long(P, 'maxLength', 'maxlength', -1, true); R.long(P, 'minLength', 'minlength', -1, true); R.str(P, 'name');
    R.str(P, 'placeholder'); R.bool(P, 'readOnly', 'readonly'); R.bool(P, 'required'); R.ulong(P, 'rows', 'rows', 2, 1);
    R.str(P, 'wrap');
    L.mixin(P, ConstraintValidation);
    L.mixin(P, SelectionAPI);
    L.mixin(P, {
      get type() { return 'textarea'; },
      get defaultValue() { return N.textContent(idOf(this)); },
      set defaultValue(v) { L.textContentSet(this, v); },
      get value() { return N.getValue(idOf(this)); },
      set value(v) {
        const id = idOf(this);
        const s = (v === null ? '' : `${v}`).replace(/\r\n?/g, '\n');
        const old = N.getValue(id);
        N.setValue(id, s);
        if (old !== s) selectionState.set(this, { start: s.length, end: s.length, dir: 'none' });
        state.attr++;
      },
      get textLength() { return N.getValue(idOf(this)).length; },
    });
  }

  // --- select / option / optgroup / datalist ---
  function selectOptionIds(sid) {
    const out = [];
    for (let c = N.firstChild(sid); c !== 0; c = N.nextSibling(c)) {
      if (N.nodeType(c) !== 1 || N.namespaceURI(c) !== L.NS.HTML) continue;
      const ln = N.localName(c);
      if (ln === 'option') out.push(c);
      else if (ln === 'optgroup') {
        for (let o = N.firstChild(c); o !== 0; o = N.nextSibling(o)) {
          if (N.nodeType(o) === 1 && N.localName(o) === 'option' && N.namespaceURI(o) === L.NS.HTML) out.push(o);
        }
      }
    }
    return out;
  }
  L.selectOptionIds = selectOptionIds;
  const multiSelected = new WeakMap(); // select -> Set(option ids) (multiple selects only)
  function isMultiple(sel) { return N.hasAttr(idOf(sel), 'multiple'); }
  function multiSet(sel) {
    let s = multiSelected.get(sel);
    if (s === undefined) {
      s = new Set();
      for (const o of selectOptionIds(idOf(sel))) if (N.hasAttr(o, 'selected')) s.add(o);
      multiSelected.set(sel, s);
    }
    return s;
  }
  function selectedOptionIds(sel) {
    const sid = idOf(sel);
    const opts = selectOptionIds(sid);
    if (isMultiple(sel)) { const s = multiSet(sel); return opts.filter((o) => s.has(o)); }
    const i = N.getSelectedIndex(sid);
    return i >= 0 && i < opts.length ? [opts[i]] : [];
  }
  function optionValue(oid) {
    const v = N.getAttr(oid, 'value');
    return v !== null ? v : L.collapseWS(N.textContent(oid));
  }
  function selectOf(optId) {
    let p = N.parent(optId);
    if (p !== 0 && N.localName(p) === 'optgroup') p = N.parent(p);
    return p !== 0 && N.localName(p) === 'select' ? p : 0;
  }
  function firstEnabledIndex(opts) {
    for (let i = 0; i < opts.length; i++) if (!N.hasAttr(opts[i], 'disabled')) return i;
    return opts.length ? 0 : -1;
  }
  class HTMLOptionsCollection extends L.HTMLCollection {
    get length() { return L.hcIds(L.hcData(this)).length; }
    set length(v) {
      const sel = wrap(L.hcData(this).select);
      const n = L.toULong(v);
      const opts = selectOptionIds(idOf(sel));
      if (n > opts.length) {
        for (let i = opts.length; i < n; i++) L.preInsert(sel, L.document.createElement('option'), null, 'length');
      } else {
        for (let i = opts.length - 1; i >= n; i--) L.removeCore(N.parent(opts[i]), undefined, opts[i]);
      }
    }
    get selectedIndex() { return wrap(L.hcData(this).select).selectedIndex; }
    set selectedIndex(v) { wrap(L.hcData(this).select).selectedIndex = v; }
    add(element, before) { wrap(L.hcData(this).select).add(element, before); }
    remove(index) { wrap(L.hcData(this).select).remove(index); }
  }
  const selectHandler = {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t) && /^(0|[1-9][0-9]*)$/.test(p)) {
        const id = selectOptionIds(idOf(r))[+p];
        return id === undefined ? undefined : wrap(id);
      }
      return Reflect.get(t, p, r);
    },
    set(t, p, v, r) {
      if (typeof p === 'string' && /^(0|[1-9][0-9]*)$/.test(p)) {
        const sel = r;
        const idx = +p;
        const opts = selectOptionIds(idOf(sel));
        if (v === null || v === undefined) { if (opts[idx] !== undefined) L.removeCore(N.parent(opts[idx]), undefined, opts[idx]); return true; }
        if (idx < opts.length) L.replaceChildImpl(wrap(N.parent(opts[idx])), v, wrap(opts[idx]));
        else {
          for (let i = opts.length; i < idx; i++) L.preInsert(sel, L.document.createElement('option'), null, 'set');
          L.preInsert(sel, v, null, 'set');
        }
        return true;
      }
      return Reflect.set(t, p, v, r);
    },
  };
  L.elementWrapperMakers.set('select', (proto) => new Proxy(Object.create(proto), selectHandler));
  const HTMLSelectElement = htmlClass('HTMLSelectElement', ['select']);
  {
    const P = HTMLSelectElement.prototype;
    R.str(P, 'autocomplete'); R.bool(P, 'disabled'); R.bool(P, 'multiple'); R.str(P, 'name'); R.bool(P, 'required');
    R.ulong(P, 'size');
    L.mixin(P, ConstraintValidation);
    L.mixin(P, {
      get type() { return isMultiple(this) ? 'select-multiple' : 'select-one'; },
      get options() {
        const sid = idOf(this);
        return cachedColl(this, 'options', () => L.makeHTMLCollection({ kind: 3, compute: () => selectOptionIds(sid), select: sid }, true, HTMLOptionsCollection));
      },
      get length() { return selectOptionIds(idOf(this)).length; },
      set length(v) { this.options.length = v; },
      item(i) { const id = selectOptionIds(idOf(this))[Number(i) >>> 0]; return id === undefined ? null : wrap(id); },
      namedItem(name) { return this.options.namedItem(name); },
      add(element, before = null) {
        if (!isNode(element) || !(lnOf(element) === 'option' || lnOf(element) === 'optgroup')) throw new TypeError("Failed to execute 'add' on 'HTMLSelectElement': The provided value is not of type '(HTMLOptGroupElement or HTMLOptionElement)'.");
        let ref = null;
        if (typeof before === 'number') { const id = selectOptionIds(idOf(this))[before]; ref = id === undefined ? null : wrap(id); }
        else if (before !== null && before !== undefined) ref = before;
        const parent = ref !== null ? ref.parentNode : this;
        L.preInsert(parent, element, ref, 'add');
      },
      remove(index) {
        if (arguments.length === 0) { L.Element.prototype.remove.call(this); return; }
        const id = selectOptionIds(idOf(this))[L.toLong(index)];
        if (id !== undefined) L.removeCore(N.parent(id), undefined, id);
      },
      get selectedOptions() {
        const sel = this;
        return cachedColl(this, 'selectedOptions', () => L.makeHTMLCollection({ kind: 3, compute: () => selectedOptionIds(sel) }, false));
      },
      get selectedIndex() {
        if (isMultiple(this)) { const s = selectedOptionIds(this); return s.length ? selectOptionIds(idOf(this)).indexOf(s[0]) : -1; }
        return N.getSelectedIndex(idOf(this));
      },
      set selectedIndex(v) {
        const i = L.toLong(v);
        if (isMultiple(this)) {
          const opts = selectOptionIds(idOf(this));
          const s = multiSet(this);
          s.clear();
          if (i >= 0 && i < opts.length) s.add(opts[i]);
        } else {
          N.setSelectedIndex(idOf(this), i);
        }
        state.attr++;
      },
      get value() {
        const s = selectedOptionIds(this);
        return s.length ? optionValue(s[0]) : '';
      },
      set value(v) {
        const s = `${v}`;
        const opts = selectOptionIds(idOf(this));
        const idx = opts.findIndex((o) => optionValue(o) === s);
        this.selectedIndex = idx;
      },
      showPicker() { },
    });
  }
  const HTMLOptionElement = htmlClass('HTMLOptionElement', ['option']);
  {
    const P = HTMLOptionElement.prototype;
    R.bool(P, 'disabled');
    L.mixin(P, {
      get form() { return formOwnerOf(this); },
      get label() { const v = N.getAttr(idOf(this), 'label'); return v !== null ? v : this.text; },
      set label(v) { setAttr(this, idOf(this), 'label', `${v}`); },
      get defaultSelected() { return N.hasAttr(idOf(this), 'selected'); },
      set defaultSelected(v) { if (v) setAttr(this, idOf(this), 'selected', ''); else removeAttr(this, idOf(this), 'selected'); },
      get selected() {
        const id = idOf(this);
        const sid = selectOf(id);
        if (sid === 0) return optionSelectedDetached.has(this) ? optionSelectedDetached.get(this) : N.hasAttr(id, 'selected');
        const sel = wrap(sid);
        return selectedOptionIds(sel).includes(id);
      },
      set selected(v) {
        const id = idOf(this);
        const sid = selectOf(id);
        if (sid === 0) { optionSelectedDetached.set(this, !!v); return; }
        const sel = wrap(sid);
        const opts = selectOptionIds(sid);
        const i = opts.indexOf(id);
        if (isMultiple(sel)) { const s = multiSet(sel); if (v) s.add(id); else s.delete(id); }
        else if (v) N.setSelectedIndex(sid, i);
        else if (N.getSelectedIndex(sid) === i) N.setSelectedIndex(sid, firstEnabledIndex(opts));
        state.attr++;
      },
      get value() { return optionValue(idOf(this)); },
      set value(v) { setAttr(this, idOf(this), 'value', `${v}`); },
      get text() {
        let s = '';
        const walk = (id) => {
          for (let c = N.firstChild(id); c !== 0; c = N.nextSibling(c)) {
            const t = N.nodeType(c);
            if (t === 3) s += N.getText(c);
            else if (t === 1 && N.localName(c) !== 'script') walk(c);
          }
        };
        walk(idOf(this));
        return L.collapseWS(s);
      },
      set text(v) { L.textContentSet(this, v); },
      get index() {
        const id = idOf(this);
        const sid = selectOf(id);
        return sid === 0 ? 0 : selectOptionIds(sid).indexOf(id);
      },
    });
  }
  const optionSelectedDetached = new WeakMap();
  const Option = function Option(text, value, defaultSelected, selected) {
    if (!new.target) throw new TypeError("Failed to construct 'Option': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    const o = L.document.createElement('option');
    if (text !== undefined && `${text}` !== '') L.preInsert(o, L.document.createTextNode(`${text}`), null, 'Option');
    if (value !== undefined) setAttr(o, idOf(o), 'value', `${value}`);
    if (defaultSelected) setAttr(o, idOf(o), 'selected', '');
    if (selected) optionSelectedDetached.set(o, true);
    return o;
  };
  Option.prototype = HTMLOptionElement.prototype;
  // An option whose selectedness is true (`new Option(.., .., .., true)`, `option.selected =
  // true` while detached, or a `selected` attribute) becomes the selected option when it is
  // inserted into a select (like browsers: the inserted option wins).
  L.optionsInserted = function (pid, pln, ids) {
    let sid = pid;
    if (pln === 'optgroup') { const p = N.parent(pid); sid = p !== 0 && N.localName(p) === 'select' ? p : 0; }
    if (sid === 0) return;
    const sel = wrap(sid);
    const multiple = isMultiple(sel);
    let chosen = 0;
    const visit = (oid) => {
      const ow = L.cache.get(oid);
      let selected;
      if (ow !== undefined && optionSelectedDetached.has(ow)) { selected = optionSelectedDetached.get(ow); optionSelectedDetached.delete(ow); }
      else selected = N.hasAttr(oid, 'selected');
      if (!selected) return;
      if (multiple) { if (multiSelected.has(sel)) multiSet(sel).add(oid); } else chosen = oid;
    };
    for (const nid of ids) {
      if (N.nodeType(nid) !== 1 || N.namespaceURI(nid) !== L.NS.HTML) continue;
      const ln = N.localName(nid);
      if (ln === 'option') visit(nid);
      else if (ln === 'optgroup' && pln === 'select') {
        for (let o = N.firstChild(nid); o !== 0; o = N.nextSibling(o)) if (N.nodeType(o) === 1 && N.localName(o) === 'option') visit(o);
      }
    }
    if (chosen !== 0) {
      const idx = selectOptionIds(sid).indexOf(chosen);
      if (idx >= 0 && N.getSelectedIndex(sid) !== idx) { N.setSelectedIndex(sid, idx); state.attr++; }
    }
  };
  const HTMLOptGroupElement = htmlClass('HTMLOptGroupElement', ['optgroup']);
  R.bool(HTMLOptGroupElement.prototype, 'disabled'); R.str(HTMLOptGroupElement.prototype, 'label');
  const HTMLDataListElement = htmlClass('HTMLDataListElement', ['datalist']);
  def(HTMLDataListElement.prototype, 'options', function () {
    const id = idOf(this);
    return cachedColl(this, 'options', () => L.queryCollection(id, 'option', true));
  });

  // --- button / label / fieldset / legend / output / progress / meter ---
  function buttonType(el) {
    const v = N.getAttr(idOf(el), 'type');
    if (v === null) return 'submit';
    const l = L.asciiLower(v);
    return l === 'reset' || l === 'button' ? l : 'submit';
  }
  const HTMLButtonElement = htmlClass('HTMLButtonElement', ['button']);
  {
    const P = HTMLButtonElement.prototype;
    R.bool(P, 'disabled'); R.str(P, 'formEnctype', 'formenctype'); R.str(P, 'formMethod', 'formmethod');
    R.bool(P, 'formNoValidate', 'formnovalidate'); R.str(P, 'formTarget', 'formtarget'); R.str(P, 'name');
    R.str(P, 'value'); R.str(P, 'popoverTargetAction', 'popovertargetaction'); R.str(P, 'command');
    def(P, 'formAction', function () {
      const v = N.getAttr(idOf(this), 'formaction');
      if (v === null || v === '') { const f = formOwnerOf(this); return f !== null ? f.action : L.documentURL(); }
      const r = L.resolveURL(v);
      return r === null ? v : r;
    }, function (v) { setAttr(this, idOf(this), 'formaction', `${v}`); });
    L.mixin(P, ConstraintValidation);
    L.mixin(P, {
      get type() { return buttonType(this); },
      set type(v) { setAttr(this, idOf(this), 'type', `${v}`); },
      get popoverTargetElement() { return null; },
      set popoverTargetElement(v) { },
      get commandForElement() { return null; },
      set commandForElement(v) { },
    });
  }
  const HTMLLabelElement = htmlClass('HTMLLabelElement', ['label']);
  {
    const P = HTMLLabelElement.prototype;
    R.str(P, 'htmlFor', 'for');
    def(P, 'control', function () { return wrap(labelControlId(idOf(this))); });
    def(P, 'form', function () { const c = labelControlId(idOf(this)); return c === 0 ? null : formOwnerOf(wrap(c)); });
  }
  const HTMLFieldSetElement = htmlClass('HTMLFieldSetElement', ['fieldset']);
  {
    const P = HTMLFieldSetElement.prototype;
    R.bool(P, 'disabled'); R.str(P, 'name');
    L.mixin(P, ConstraintValidation);
    L.mixin(P, {
      get type() { return 'fieldset'; },
      get elements() {
        const id = idOf(this);
        return cachedColl(this, 'elements', () => L.makeHTMLCollection({ kind: 3, compute: () => N.querySelectorAll(id, 'button,fieldset,input,object,output,select,textarea') }, true, HTMLFormControlsCollection));
      },
      checkValidity() {
        let ok = true;
        for (const id of N.querySelectorAll(idOf(this), 'button,input,select,textarea')) if (!wrap(id).checkValidity()) ok = false;
        return ok;
      },
      reportValidity() { return this.checkValidity(); },
    });
  }
  const HTMLLegendElement = htmlClass('HTMLLegendElement', ['legend']);
  R.str(HTMLLegendElement.prototype, 'align');
  def(HTMLLegendElement.prototype, 'form', function () { return formOwnerOf(this); });
  const HTMLOutputElement = htmlClass('HTMLOutputElement', ['output']);
  const outputDefault = new WeakMap();
  {
    const P = HTMLOutputElement.prototype;
    R.str(P, 'name');
    R.tokens(P, 'htmlFor', 'for');
    L.mixin(P, ConstraintValidation);
    L.mixin(P, {
      get type() { return 'output'; },
      get defaultValue() { const d = outputDefault.get(this); return d !== undefined ? d : N.textContent(idOf(this)); },
      set defaultValue(v) { if (outputDefault.has(this)) outputDefault.set(this, `${v}`); else L.textContentSet(this, v); },
      get value() { return N.textContent(idOf(this)); },
      set value(v) { if (!outputDefault.has(this)) outputDefault.set(this, N.textContent(idOf(this))); L.textContentSet(this, v); },
    });
  }
  const HTMLProgressElement = htmlClass('HTMLProgressElement', ['progress']);
  {
    const P = HTMLProgressElement.prototype;
    def(P, 'max', function () { const v = parseFloatAttr(N.getAttr(idOf(this), 'max') || ''); return v !== null && v > 0 ? v : 1; }, function (v) { const n = Number(v); if (n > 0) setAttr(this, idOf(this), 'max', String(n)); });
    def(P, 'value', function () { const v = parseFloatAttr(N.getAttr(idOf(this), 'value') || ''); if (v === null || v < 0) return 0; return Math.min(v, this.max); }, function (v) { setAttr(this, idOf(this), 'value', String(Number(v))); });
    def(P, 'position', function () { return N.hasAttr(idOf(this), 'value') ? this.value / this.max : -1; });
    def(P, 'labels', function () { return labelsFor(this); });
  }
  const HTMLMeterElement = htmlClass('HTMLMeterElement', ['meter']);
  {
    const P = HTMLMeterElement.prototype;
    for (const [p, d] of [['value', 0], ['min', 0], ['max', 1], ['low', 0], ['high', 1], ['optimum', 0.5]]) R.double(P, p, p, d);
    def(P, 'labels', function () { return labelsFor(this); });
  }

  // ---------------------------------------------------------------------------------------
  // Click activation behaviour (see NATIVE_API.md "Additions": default action split)
  // ---------------------------------------------------------------------------------------
  function isActivationElement(el) {
    if (nsOf(el) !== HTML) return lnOf(el) === 'a' && nsOf(el) === SVG;
    switch (lnOf(el)) {
      case 'a': case 'area': case 'button': case 'input': case 'label': return true;
      case 'summary': return isDetailsSummary(el);
      default: return false;
    }
  }
  function isDetailsSummary(el) {
    const id = idOf(el);
    const p = N.parent(id);
    if (p === 0 || N.localName(p) !== 'details' || N.namespaceURI(p) !== L.NS.HTML) return false;
    return firstChildByName(p, 'summary') === id;
  }
  L.activation = {
    begin(path, event) {
      let target = null;
      for (let i = 0; i < path.length; i++) {
        const t = path[i];
        if (!isNode(t) || typeOf(t) !== 1) { if (i === 0 && !event.bubbles) break; continue; }
        if (isActivationElement(t)) { target = t; break; }
        if (i === 0 && !event.bubbles) break;
      }
      if (target === null) return null;
      const st = { target, restore: null, changed: false };
      if (lnOf(target) === 'input' && nsOf(target) === HTML && !isDisabledFormControl(target)) {
        const t = inputType(target);
        const id = idOf(target);
        if (t === 'checkbox') {
          const old = N.getChecked(id), oldInd = !!indeterminate.get(target);
          N.setChecked(id, !old);
          if (oldInd) setIndeterminate(target, false);
          st.changed = true;
          st.restore = () => { N.setChecked(id, old); if (oldInd) setIndeterminate(target, true); };
        } else if (t === 'radio') {
          if (!N.getChecked(id)) {
            const group = radioGroupIds(target);
            const prev = group.find((r) => r !== id && N.getChecked(r)) || 0;
            setChecked(target, true);
            st.changed = true;
            st.restore = () => { N.setChecked(id, false); if (prev !== 0) N.setChecked(prev, true); };
          } else {
            st.restore = () => { };
          }
        }
      }
      return st;
    },
    end(st, event, canceled) {
      const el = st.target;
      if (canceled) {
        if (st.restore !== null) { st.restore(); state.attr++; return true; }
        return false;
      }
      const ln = lnOf(el);
      const id = idOf(el);
      if (ln === 'input' && nsOf(el) === HTML) {
        const t = inputType(el);
        if (t === 'checkbox' || t === 'radio') {
          if (st.changed) {
            state.attr++;
            L.fire(el, 'input', { bubbles: true, composed: true });
            L.fire(el, 'change', { bubbles: true });
          }
          return st.restore !== null;
        }
        if (isDisabledFormControl(el)) return true;
        if (t === 'submit' || t === 'image') {
          const f = formOwnerOf(el);
          if (f !== null) submitFormAlgorithm(f, el);
          return true;
        }
        if (t === 'reset') {
          const f = formOwnerOf(el);
          if (f !== null) resetForm(f);
          return true;
        }
        if (t === 'file' || t === 'color' || t === 'date' || t === 'datetime-local' || t === 'month' || t === 'time' || t === 'week') {
          if (!event.isTrusted) N.runDefaultAction(id, 'click');
          return !event.isTrusted;
        }
        return false;
      }
      if (ln === 'button') {
        if (isDisabledFormControl(el)) return true;
        const t = buttonType(el);
        const f = formOwnerOf(el);
        if (f === null || t === 'button') return false;
        if (t === 'submit') submitFormAlgorithm(f, el);
        else resetForm(f);
        return true;
      }
      if (ln === 'label') {
        const cid = labelControlId(id);
        if (cid === 0) return false;
        const target = L.EV.target(event);
        if (isNode(target) && N.contains(cid, idOf(target))) return false;
        // interactive content inside the label (other than the control) does not forward
        if (isNode(target) && target !== el) {
          const inter = N.closest(idOf(target), 'a[href],button,input,select,textarea,details,summary,iframe,label');
          if (inter !== 0 && inter !== id && N.contains(id, inter)) return false;
        }
        const control = wrap(cid);
        if (isDisabledFormControl(control)) return true;
        const tt = lnOf(control) === 'input' ? inputType(control) : '';
        if (!(lnOf(control) === 'input' && (tt === 'checkbox' || tt === 'radio' || tt === 'submit' || tt === 'reset' || tt === 'button' || tt === 'image' || tt === 'file'))) {
          focusElement(control);
        }
        const ev = new L.PointerEvent('click', { bubbles: true, cancelable: true, composed: true, view: L.window, detail: event.detail, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, button: event.button, pointerType: event.pointerType || '' });
        L.EV.setTrusted(ev, event.isTrusted);
        if (!clickInProgress.has(control)) {
          clickInProgress.add(control);
          try { L.dispatchCore(control, ev, null); } finally { clickInProgress.delete(control); }
        }
        return true;
      }
      if (ln === 'summary') {
        const p = N.parent(id);
        const d = wrap(p);
        if (N.hasAttr(p, 'open')) removeAttr(d, p, 'open'); else setAttr(d, p, 'open', '');
        return true;
      }
      if (ln === 'a' || ln === 'area') {
        const href = N.getAttr(id, 'href') !== null ? N.getAttr(id, 'href') : N.getAttr(id, 'xlink:href');
        if (href === null) return false;
        if (/^\s*javascript:/i.test(href)) {
          runJavascriptURL(href);
          return true;
        }
        if (!event.isTrusted) {
          N.runDefaultAction(id, 'click');
          L.bumpAll();
          return true;
        }
        return false;
      }
      return false;
    },
  };

  // ---------------------------------------------------------------------------------------
  // Exposure
  // ---------------------------------------------------------------------------------------
  exposedHTML.HTMLFormControlsCollection = HTMLFormControlsCollection;
  exposedHTML.HTMLOptionsCollection = HTMLOptionsCollection;
  exposedHTML.RadioNodeList = RadioNodeList;
  exposedHTML.ValidityState = ValidityState;
  exposedHTML.ElementInternals = ElementInternals;
  exposedHTML.CustomStateSet = CustomStateSet;
  exposedHTML.SVGElement = SVGElement;
  exposedHTML.SVGGraphicsElement = SVGGraphicsElement;
  exposedHTML.SVGGeometryElement = SVGGeometryElement;
  exposedHTML.SVGSVGElement = SVGSVGElement;
  exposedHTML.SVGAnimatedString = SVGAnimatedString;
  exposedHTML.SVGAnimatedLength = SVGAnimatedLength;
  exposedHTML.SVGLength = SVGLength;
  exposedHTML.SVGAnimatedRect = SVGAnimatedRect;
  exposedHTML.SVGAnimatedTransformList = SVGAnimatedTransformList;
  exposedHTML.SVGPoint = L.DOMPoint;
  exposedHTML.SVGMatrix = L.DOMMatrix;
  exposedHTML.SVGRect = L.DOMRect;
  exposedHTML.MathMLElement = MathMLElement;
  exposedHTML.CanvasRenderingContext2D = CanvasRenderingContext2D;
  exposedHTML.CanvasGradient = CanvasGradient;
  exposedHTML.CanvasPattern = CanvasPattern;
  exposedHTML.TextMetrics = TextMetrics;
  exposedHTML.ImageData = ImageData;
  exposedHTML.Path2D = Path2D;
  exposedHTML.TimeRanges = TimeRanges;
  exposedHTML.MediaError = MediaError;
  exposedHTML.TextTrackList = TextTrackList;
  exposedHTML.AudioTrackList = AudioTrackList;
  exposedHTML.VideoTrackList = VideoTrackList;
  exposedHTML.Image = Image;
  exposedHTML.Option = Option;
  exposedHTML.Audio = Audio;
  for (const k in exposedHTML) L.expose(k, exposedHTML[k]);
  L.expose('SVGSVGElement', SVGSVGElement);
  Object.assign(L, exposedHTML);
  L.labelControlId = labelControlId;
  L.inputValueMode = valueModeOf;
  L.selectedOptionIds = selectedOptionIds;
  L.optionValue = optionValue;
  L.formControlIds = formControlIds;
  L.fileListOf = fileListOf;
  L.isSubmitButton = isSubmitButton;
  L.buttonType = buttonType;
  L.willValidate = willValidate;
})(globalThis.__layer);
