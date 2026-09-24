// 10_events.js — Event classes, EventTarget, the DOM dispatch algorithm, event handler
// IDL/content attributes, AbortController/AbortSignal.
(function (L) {
  'use strict';
  const N = L.N;
  const DOMException = L.DOMException;

  const NONE = 0, CAPTURING_PHASE = 1, AT_TARGET = 2, BUBBLING_PHASE = 3;
  // Event flag bits
  const F_STOP = 1, F_STOP_IMM = 2, F_CANCELED = 4, F_PASSIVE = 8, F_DISPATCH = 16, F_UNINIT = 32;

  function initDict(init, ctorName) {
    if (init === undefined || init === null) return null;
    if (typeof init !== 'object' && typeof init !== 'function') {
      throw new TypeError(`Failed to construct '${ctorName}': The provided value is not of type '${ctorName}Init'.`);
    }
    return init;
  }
  function num(v) { v = Number(v); return v === v ? v : 0; }        // double (NaN -> 0)
  function lng(v) { return Number(v) | 0; }                          // long
  function ulng(v) { return Number(v) >>> 0; }

  // Internal: allows extra (non-standard) init members when the layer constructs events
  // for native input.
  let nativeConstruction = false;

  // ---------------------------------------------------------------------------------------
  // Event
  // ---------------------------------------------------------------------------------------
  let EV;
  class Event {
    #type;
    #bubbles = false;
    #cancelable = false;
    #composed = false;
    #trusted = false;
    #ts;
    #target = null;
    #current = null;
    #phase = NONE;
    #flags = 0;
    #path = null;
    #related = null;
    constructor(type, eventInitDict) {
      if (arguments.length < 1) {
        throw new TypeError(`Failed to construct '${new.target.name}': 1 argument required, but only 0 present.`);
      }
      this.#type = `${type}`;
      const d = initDict(eventInitDict, new.target.name);
      if (d !== null) {
        this.#bubbles = !!d.bubbles;
        this.#cancelable = !!d.cancelable;
        this.#composed = !!d.composed;
      }
      this.#ts = N.now();
    }
    get type() { return this.#type; }
    get target() { return this.#target; }
    get srcElement() { return this.#target; }
    get currentTarget() { return this.#current; }
    composedPath() {
      const p = this.#path;
      return p === null ? [] : p.slice();
    }
    get eventPhase() { return this.#phase; }
    stopPropagation() { this.#flags |= F_STOP; }
    get cancelBubble() { return (this.#flags & F_STOP) !== 0; }
    set cancelBubble(v) { if (v) this.#flags |= F_STOP; }
    stopImmediatePropagation() { this.#flags |= F_STOP | F_STOP_IMM; }
    get bubbles() { return this.#bubbles; }
    get cancelable() { return this.#cancelable; }
    get returnValue() { return (this.#flags & F_CANCELED) === 0; }
    set returnValue(v) { if (!v) this.preventDefault(); }
    preventDefault() {
      if (this.#cancelable && (this.#flags & F_PASSIVE) === 0) this.#flags |= F_CANCELED;
    }
    get defaultPrevented() { return (this.#flags & F_CANCELED) !== 0; }
    get composed() { return this.#composed; }
    get isTrusted() { return this.#trusted; }
    get timeStamp() { return this.#ts; }
    initEvent(type, bubbles = false, cancelable = false) {
      if (this.#flags & F_DISPATCH) return;
      this.#flags = 0;
      this.#trusted = false;
      this.#target = null;
      this.#type = `${type}`;
      this.#bubbles = !!bubbles;
      this.#cancelable = !!cancelable;
    }
    static {
      EV = {
        is: (e) => typeof e === 'object' && e !== null && #type in e,
        type: (e) => e.#type,
        target: (e) => e.#target,
        setTarget: (e, t) => { e.#target = t; },
        setCurrent: (e, t) => { e.#current = t; },
        setPhase: (e, p) => { e.#phase = p; },
        flags: (e) => e.#flags,
        setFlag: (e, f) => { e.#flags |= f; },
        clearFlag: (e, f) => { e.#flags &= ~f; },
        setPath: (e, p) => { e.#path = p; },
        setTrusted: (e, t) => { e.#trusted = !!t; },
        setUninitialized: (e) => { e.#flags |= F_UNINIT; },
        bubbles: (e) => e.#bubbles,
        related: (e) => e.#related,
        setRelated: (e, r) => { e.#related = r; },
      };
    }
  }
  L.defineConstants([Event, Event.prototype], { NONE, CAPTURING_PHASE, AT_TARGET, BUBBLING_PHASE });
  L.EV = EV;

  class CustomEvent extends Event {
    #detail = null;
    constructor(type, init) {
      super(type, init);
      if (init !== undefined && init !== null && init.detail !== undefined) this.#detail = init.detail;
    }
    get detail() { return this.#detail; }
    initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
      if (EV.flags(this) & F_DISPATCH) return;
      this.initEvent(type, bubbles, cancelable);
      this.#detail = detail;
    }
  }

  class UIEvent extends Event {
    #view = null;
    #detail = 0;
    #which = 0;
    constructor(type, init) {
      super(type, init);
      if (init !== undefined && init !== null) {
        if (init.view !== undefined) this.#view = init.view;
        this.#detail = lng(init.detail);
        this.#which = ulng(init.which);
      }
    }
    get view() { return this.#view; }
    get detail() { return this.#detail; }
    get which() { return this.#which; }
    initUIEvent(type, bubbles = false, cancelable = false, view = null, detail = 0) {
      if (EV.flags(this) & F_DISPATCH) return;
      this.initEvent(type, bubbles, cancelable);
      this.#view = view;
      this.#detail = lng(detail);
    }
  }

  const MODIFIER_KEYS = {
    Control: 'ctrlKey', Shift: 'shiftKey', Alt: 'altKey', Meta: 'metaKey',
    AltGraph: 'modifierAltGraph', CapsLock: 'modifierCapsLock', Fn: 'modifierFn',
    FnLock: 'modifierFnLock', Hyper: 'modifierHyper', NumLock: 'modifierNumLock',
    ScrollLock: 'modifierScrollLock', Super: 'modifierSuper', Symbol: 'modifierSymbol',
    SymbolLock: 'modifierSymbolLock',
  };
  function readModifiers(d) {
    const m = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
    if (d !== null) {
      for (const k in MODIFIER_KEYS) {
        const f = MODIFIER_KEYS[k];
        if (d[f]) m[f] = true;
      }
    }
    return m;
  }

  class MouseEvent extends UIEvent {
    #d;
    constructor(type, init) {
      super(type, init);
      const d = initDict(init, new.target.name);
      const m = readModifiers(d);
      const s = {
        screenX: 0, screenY: 0, clientX: 0, clientY: 0, button: 0, buttons: 0,
        movementX: 0, movementY: 0, pageX: null, pageY: null, offsetX: null, offsetY: null, mods: m,
      };
      if (d !== null) {
        s.screenX = num(d.screenX); s.screenY = num(d.screenY);
        s.clientX = num(d.clientX); s.clientY = num(d.clientY);
        s.button = (Number(d.button) << 16) >> 16; s.buttons = Number(d.buttons) & 0xffff;
        s.movementX = num(d.movementX); s.movementY = num(d.movementY);
        if (d.relatedTarget !== undefined && d.relatedTarget !== null) EV.setRelated(this, d.relatedTarget);
        if (nativeConstruction) {
          if (d.pageX !== undefined) s.pageX = num(d.pageX);
          if (d.pageY !== undefined) s.pageY = num(d.pageY);
          if (d.offsetX !== undefined) s.offsetX = num(d.offsetX);
          if (d.offsetY !== undefined) s.offsetY = num(d.offsetY);
        }
      }
      this.#d = s;
    }
    get screenX() { return this.#d.screenX; }
    get screenY() { return this.#d.screenY; }
    get clientX() { return this.#d.clientX; }
    get clientY() { return this.#d.clientY; }
    get x() { return this.#d.clientX; }
    get y() { return this.#d.clientY; }
    get pageX() {
      const s = this.#d;
      if (s.pageX !== null) return s.pageX;
      return s.clientX + (L.scrollX ? L.scrollX() : 0);
    }
    get pageY() {
      const s = this.#d;
      if (s.pageY !== null) return s.pageY;
      return s.clientY + (L.scrollY ? L.scrollY() : 0);
    }
    get offsetX() {
      const s = this.#d;
      if (s.offsetX !== null) return s.offsetX;
      const r = L.targetRect ? L.targetRect(EV.target(this)) : null;
      return r ? s.clientX - r[0] : s.clientX;
    }
    get offsetY() {
      const s = this.#d;
      if (s.offsetY !== null) return s.offsetY;
      const r = L.targetRect ? L.targetRect(EV.target(this)) : null;
      return r ? s.clientY - r[1] : s.clientY;
    }
    get layerX() { return this.offsetX; }
    get layerY() { return this.offsetY; }
    get movementX() { return this.#d.movementX; }
    get movementY() { return this.#d.movementY; }
    get ctrlKey() { return this.#d.mods.ctrlKey; }
    get shiftKey() { return this.#d.mods.shiftKey; }
    get altKey() { return this.#d.mods.altKey; }
    get metaKey() { return this.#d.mods.metaKey; }
    get button() { return this.#d.button; }
    get buttons() { return this.#d.buttons; }
    get relatedTarget() { return EV.related(this); }
    get which() { return this.#d.button + 1; }
    get fromElement() {
      const t = this.type;
      return t === 'mouseover' || t === 'mouseenter' || t === 'pointerover' ? EV.related(this) : EV.target(this);
    }
    get toElement() {
      const t = this.type;
      return t === 'mouseout' || t === 'mouseleave' || t === 'pointerout' ? EV.related(this) : EV.target(this);
    }
    getModifierState(key) {
      const f = MODIFIER_KEYS[`${key}`];
      return f ? !!this.#d.mods[f] : false;
    }
    initMouseEvent(type, bubbles = false, cancelable = false, view = null, detail = 0, screenX = 0, screenY = 0,
      clientX = 0, clientY = 0, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false, button = 0,
      relatedTarget = null) {
      if (EV.flags(this) & F_DISPATCH) return;
      this.initUIEvent(type, bubbles, cancelable, view, detail);
      const s = this.#d;
      s.screenX = num(screenX); s.screenY = num(screenY); s.clientX = num(clientX); s.clientY = num(clientY);
      s.mods = { ctrlKey: !!ctrlKey, altKey: !!altKey, shiftKey: !!shiftKey, metaKey: !!metaKey };
      s.button = (Number(button) << 16) >> 16;
      EV.setRelated(this, relatedTarget);
    }
  }

  class PointerEvent extends MouseEvent {
    #p;
    constructor(type, init) {
      super(type, init);
      const d = init === undefined || init === null ? {} : init;
      this.#p = {
        pointerId: lng(d.pointerId),
        width: d.width === undefined ? 1 : num(d.width),
        height: d.height === undefined ? 1 : num(d.height),
        pressure: num(d.pressure),
        tangentialPressure: num(d.tangentialPressure),
        tiltX: lng(d.tiltX), tiltY: lng(d.tiltY), twist: lng(d.twist),
        altitudeAngle: d.altitudeAngle === undefined ? Math.PI / 2 : num(d.altitudeAngle),
        azimuthAngle: num(d.azimuthAngle),
        pointerType: d.pointerType === undefined ? '' : `${d.pointerType}`,
        isPrimary: !!d.isPrimary,
        persistentDeviceId: lng(d.persistentDeviceId),
        coalesced: Array.isArray(d.coalescedEvents) ? d.coalescedEvents.slice() : [],
        predicted: Array.isArray(d.predictedEvents) ? d.predictedEvents.slice() : [],
      };
    }
    get pointerId() { return this.#p.pointerId; }
    get width() { return this.#p.width; }
    get height() { return this.#p.height; }
    get pressure() { return this.#p.pressure; }
    get tangentialPressure() { return this.#p.tangentialPressure; }
    get tiltX() { return this.#p.tiltX; }
    get tiltY() { return this.#p.tiltY; }
    get twist() { return this.#p.twist; }
    get altitudeAngle() { return this.#p.altitudeAngle; }
    get azimuthAngle() { return this.#p.azimuthAngle; }
    get pointerType() { return this.#p.pointerType; }
    get isPrimary() { return this.#p.isPrimary; }
    get persistentDeviceId() { return this.#p.persistentDeviceId; }
    getCoalescedEvents() { return this.#p.coalesced.slice(); }
    getPredictedEvents() { return this.#p.predicted.slice(); }
  }

  class WheelEvent extends MouseEvent {
    #w;
    constructor(type, init) {
      super(type, init);
      const d = init === undefined || init === null ? {} : init;
      this.#w = { deltaX: num(d.deltaX), deltaY: num(d.deltaY), deltaZ: num(d.deltaZ), deltaMode: ulng(d.deltaMode) };
    }
    get deltaX() { return this.#w.deltaX; }
    get deltaY() { return this.#w.deltaY; }
    get deltaZ() { return this.#w.deltaZ; }
    get deltaMode() { return this.#w.deltaMode; }
    get wheelDelta() { return Math.round(-(this.#w.deltaY || this.#w.deltaX) * 1.2); }
    get wheelDeltaX() { return Math.round(-this.#w.deltaX * 1.2); }
    get wheelDeltaY() { return Math.round(-this.#w.deltaY * 1.2); }
  }
  L.defineConstants([WheelEvent, WheelEvent.prototype], { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });

  class DragEvent extends MouseEvent {
    #dt = null;
    constructor(type, init) {
      super(type, init);
      if (init && init.dataTransfer !== undefined) this.#dt = init.dataTransfer;
    }
    get dataTransfer() { return this.#dt; }
  }

  // keyCode derivation for native keyboard events without explicit keyCode
  const KEYCODES = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27,
    ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
    ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93, NumLock: 144,
    ScrollLock: 145, ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219,
    '\\': 220, ']': 221, "'": 222, ':': 186, '+': 187, '<': 188, '_': 189, '>': 190, '?': 191, '~': 192,
    '{': 219, '|': 220, '}': 221, '"': 222, '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55,
    '*': 56, '(': 57, ')': 48,
  };
  function deriveKeyCode(key, code) {
    if (typeof code === 'string') {
      let m = /^Key([A-Z])$/.exec(code);
      if (m) return m[1].charCodeAt(0);
      m = /^Digit([0-9])$/.exec(code);
      if (m) return 48 + +m[1];
      m = /^Numpad([0-9])$/.exec(code);
      if (m) return 96 + +m[1];
      m = /^F([0-9]{1,2})$/.exec(code);
      if (m) return 111 + +m[1];
    }
    if (typeof key === 'string') {
      if (key.length === 1) {
        const c = key.toUpperCase();
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c.charCodeAt(0);
      }
      if (key in KEYCODES) return KEYCODES[key];
      const m = /^F([0-9]{1,2})$/.exec(key);
      if (m) return 111 + +m[1];
    }
    return 0;
  }

  class KeyboardEvent extends UIEvent {
    #k;
    constructor(type, init) {
      super(type, init);
      const d = initDict(init, new.target.name);
      const s = {
        key: '', code: '', location: 0, repeat: false, isComposing: false, charCode: 0, keyCode: 0,
        mods: readModifiers(d),
      };
      if (d !== null) {
        if (d.key !== undefined) s.key = `${d.key}`;
        if (d.code !== undefined) s.code = `${d.code}`;
        s.location = ulng(d.location);
        s.repeat = !!d.repeat;
        s.isComposing = !!d.isComposing;
        s.charCode = ulng(d.charCode);
        s.keyCode = ulng(d.keyCode);
        if (nativeConstruction) {
          if (!s.keyCode) s.keyCode = type === 'keypress' ? 0 : deriveKeyCode(s.key, s.code);
          if (type === 'keypress' && !s.charCode) {
            s.charCode = s.key === 'Enter' ? 13 : s.key.length === 1 ? s.key.charCodeAt(0) : 0;
            if (!s.keyCode) s.keyCode = s.charCode;
          }
        }
      }
      this.#k = s;
    }
    get key() { return this.#k.key; }
    get code() { return this.#k.code; }
    get location() { return this.#k.location; }
    get ctrlKey() { return this.#k.mods.ctrlKey; }
    get shiftKey() { return this.#k.mods.shiftKey; }
    get altKey() { return this.#k.mods.altKey; }
    get metaKey() { return this.#k.mods.metaKey; }
    get repeat() { return this.#k.repeat; }
    get isComposing() { return this.#k.isComposing; }
    get charCode() { return this.#k.charCode; }
    get keyCode() { return this.#k.keyCode; }
    get which() { return this.type === 'keypress' ? (this.#k.charCode || this.#k.keyCode) : this.#k.keyCode; }
    getModifierState(key) {
      const f = MODIFIER_KEYS[`${key}`];
      return f ? !!this.#k.mods[f] : false;
    }
    initKeyboardEvent(type, bubbles = false, cancelable = false, view = null, key = '', location = 0,
      ctrlKey = false, altKey = false, shiftKey = false, metaKey = false) {
      if (EV.flags(this) & F_DISPATCH) return;
      this.initUIEvent(type, bubbles, cancelable, view, 0);
      const s = this.#k;
      s.key = `${key}`; s.location = ulng(location);
      s.mods = { ctrlKey: !!ctrlKey, altKey: !!altKey, shiftKey: !!shiftKey, metaKey: !!metaKey };
    }
  }
  L.defineConstants([KeyboardEvent, KeyboardEvent.prototype], {
    DOM_KEY_LOCATION_STANDARD: 0, DOM_KEY_LOCATION_LEFT: 1, DOM_KEY_LOCATION_RIGHT: 2, DOM_KEY_LOCATION_NUMPAD: 3,
  });

  class FocusEvent extends UIEvent {
    constructor(type, init) {
      super(type, init);
      if (init && init.relatedTarget !== undefined && init.relatedTarget !== null) EV.setRelated(this, init.relatedTarget);
    }
    get relatedTarget() { return EV.related(this); }
  }

  class InputEvent extends UIEvent {
    #i;
    constructor(type, init) {
      super(type, init);
      const d = init === undefined || init === null ? {} : init;
      this.#i = {
        data: d.data === undefined || d.data === null ? null : `${d.data}`,
        isComposing: !!d.isComposing,
        inputType: d.inputType === undefined ? '' : `${d.inputType}`,
        dataTransfer: d.dataTransfer === undefined ? null : d.dataTransfer,
        ranges: Array.isArray(d.targetRanges) ? d.targetRanges.slice() : [],
      };
    }
    get data() { return this.#i.data; }
    get isComposing() { return this.#i.isComposing; }
    get inputType() { return this.#i.inputType; }
    get dataTransfer() { return this.#i.dataTransfer; }
    getTargetRanges() { return this.#i.ranges.slice(); }
  }

  class CompositionEvent extends UIEvent {
    #data = '';
    constructor(type, init) {
      super(type, init);
      if (init && init.data !== undefined && init.data !== null) this.#data = `${init.data}`;
    }
    get data() { return this.#data; }
    initCompositionEvent(type, bubbles = false, cancelable = false, view = null, data = '') {
      this.initUIEvent(type, bubbles, cancelable, view, 0);
      this.#data = `${data}`;
    }
  }

  class Touch {
    #t;
    constructor(init) {
      if (!init || init.identifier === undefined || init.target === undefined) {
        throw new TypeError("Failed to construct 'Touch': required member identifier/target is undefined.");
      }
      this.#t = {
        identifier: lng(init.identifier), target: init.target,
        clientX: num(init.clientX), clientY: num(init.clientY), screenX: num(init.screenX),
        screenY: num(init.screenY), pageX: num(init.pageX), pageY: num(init.pageY),
        radiusX: num(init.radiusX), radiusY: num(init.radiusY), rotationAngle: num(init.rotationAngle),
        force: num(init.force),
      };
    }
    get identifier() { return this.#t.identifier; }
    get target() { return this.#t.target; }
    get clientX() { return this.#t.clientX; }
    get clientY() { return this.#t.clientY; }
    get screenX() { return this.#t.screenX; }
    get screenY() { return this.#t.screenY; }
    get pageX() { return this.#t.pageX; }
    get pageY() { return this.#t.pageY; }
    get radiusX() { return this.#t.radiusX; }
    get radiusY() { return this.#t.radiusY; }
    get rotationAngle() { return this.#t.rotationAngle; }
    get force() { return this.#t.force; }
  }
  class TouchList {
    #items;
    constructor(token, items) {
      if (token !== L.INTERNAL) throw L.illegal();
      this.#items = items || [];
    }
    get length() { return this.#items.length; }
    item(i) { const v = this.#items[i >>> 0]; return v === undefined ? null : v; }
    *[Symbol.iterator]() { yield* this.#items; }
    static { L.touchListItem = (o, i) => o.#items[i]; }
  }
  L.makeIndexed(TouchList.prototype, (o, i) => L.touchListItem(o, i), 16);
  class TouchEvent extends UIEvent {
    #t;
    constructor(type, init) {
      super(type, init);
      const d = init === undefined || init === null ? {} : init;
      const tl = (a) => new TouchList(L.INTERNAL, Array.isArray(a) ? a.slice() : []);
      this.#t = {
        touches: tl(d.touches), targetTouches: tl(d.targetTouches), changedTouches: tl(d.changedTouches),
        mods: readModifiers(d),
      };
    }
    get touches() { return this.#t.touches; }
    get targetTouches() { return this.#t.targetTouches; }
    get changedTouches() { return this.#t.changedTouches; }
    get altKey() { return this.#t.mods.altKey; }
    get metaKey() { return this.#t.mods.metaKey; }
    get ctrlKey() { return this.#t.mods.ctrlKey; }
    get shiftKey() { return this.#t.mods.shiftKey; }
  }

  // Simple "record" event classes: name -> [members with defaults]
  function simpleEvent(name, Base, members) {
    const keys = Object.keys(members);
    const C = {
      [name]: class extends Base {
        constructor(type, init) {
          super(type, init);
          const d = init === undefined || init === null ? null : init;
          const s = {};
          for (const k of keys) {
            const def = members[k];
            let v = d !== null ? d[k] : undefined;
            if (v === undefined) v = typeof def === 'function' ? def() : def;
            else if (typeof def === 'number') v = Number(v);
            else if (typeof def === 'string') v = `${v}`;
            else if (typeof def === 'boolean') v = !!v;
            s[k] = v;
          }
          store.set(this, s);
        }
      },
    }[name];
    const store = new WeakMap();
    for (const k of keys) {
      Object.defineProperty(C.prototype, k, {
        get() { const s = store.get(this); if (s === undefined) throw new TypeError('Illegal invocation'); return s[k]; },
        enumerable: true, configurable: true,
      });
    }
    C.store = store;
    return C;
  }

  const ErrorEvent = simpleEvent('ErrorEvent', Event, { message: '', filename: '', lineno: 0, colno: 0, error: null });
  const ProgressEvent = simpleEvent('ProgressEvent', Event, { lengthComputable: false, loaded: 0, total: 0 });
  const PopStateEvent = simpleEvent('PopStateEvent', Event, { state: null, hasUAVisualTransition: false });
  const HashChangeEvent = simpleEvent('HashChangeEvent', Event, { oldURL: '', newURL: '' });
  const PageTransitionEvent = simpleEvent('PageTransitionEvent', Event, { persisted: false });
  const AnimationEvent = simpleEvent('AnimationEvent', Event, { animationName: '', elapsedTime: 0, pseudoElement: '' });
  const TransitionEvent = simpleEvent('TransitionEvent', Event, { propertyName: '', elapsedTime: 0, pseudoElement: '' });
  const SubmitEvent = simpleEvent('SubmitEvent', Event, { submitter: null });
  const FormDataEvent = simpleEvent('FormDataEvent', Event, { formData: null });
  const PromiseRejectionEvent = simpleEvent('PromiseRejectionEvent', Event, { promise: null, reason: undefined });
  const MediaQueryListEvent = simpleEvent('MediaQueryListEvent', Event, { media: '', matches: false });
  const ToggleEvent = simpleEvent('ToggleEvent', Event, { oldState: '', newState: '' });
  const ClipboardEvent = simpleEvent('ClipboardEvent', Event, { clipboardData: null });
  const SecurityPolicyViolationEvent = simpleEvent('SecurityPolicyViolationEvent', Event, {
    documentURI: '', referrer: '', blockedURI: '', violatedDirective: '', effectiveDirective: '',
    originalPolicy: '', sourceFile: '', sample: '', disposition: 'enforce', statusCode: 0, lineNumber: 0, columnNumber: 0,
  });
  const StorageEvent = simpleEvent('StorageEvent', Event, { key: null, oldValue: null, newValue: null, url: '', storageArea: null });
  StorageEvent.prototype.initStorageEvent = function (type, bubbles = false, cancelable = false, key = null,
    oldValue = null, newValue = null, url = '', storageArea = null) {
    this.initEvent(type, bubbles, cancelable);
    Object.assign(StorageEvent.store.get(this), { key, oldValue, newValue, url: `${url}`, storageArea });
  };

  class MessageEvent extends Event {
    #m;
    constructor(type, init) {
      super(type, init);
      const d = init === undefined || init === null ? {} : init;
      this.#m = {
        data: d.data === undefined ? null : d.data,
        origin: d.origin === undefined ? '' : `${d.origin}`,
        lastEventId: d.lastEventId === undefined ? '' : `${d.lastEventId}`,
        source: d.source === undefined ? null : d.source,
        ports: Array.isArray(d.ports) ? Object.freeze(d.ports.slice()) : Object.freeze([]),
      };
    }
    get data() { return this.#m.data; }
    get origin() { return this.#m.origin; }
    get lastEventId() { return this.#m.lastEventId; }
    get source() { return this.#m.source; }
    get ports() { return this.#m.ports; }
    initMessageEvent(type, bubbles = false, cancelable = false, data = null, origin = '', lastEventId = '', source = null, ports = []) {
      this.initEvent(type, bubbles, cancelable);
      this.#m = { data, origin: `${origin}`, lastEventId: `${lastEventId}`, source, ports: Object.freeze(Array.from(ports || [])) };
    }
  }

  const CloseEvent = simpleEvent('CloseEvent', Event, { wasClean: false, code: 0, reason: '' });

  class BeforeUnloadEvent extends Event {
    #rv = '';
    get returnValue() { return this.#rv; }
    set returnValue(v) { this.#rv = `${v}`; if (this.#rv !== '') this.preventDefault(); }
  }

  // ---------------------------------------------------------------------------------------
  // EventTarget
  // ---------------------------------------------------------------------------------------
  // target -> Map<type, Listener[]>
  const LS = new WeakMap();
  L.listenerStore = LS;

  function Listener(type, callback, capture, once, passive) {
    this.type = type;
    this.callback = callback;
    this.capture = capture;
    this.once = once;
    this.passive = passive;
    this.removed = false;
    this.handler = null; // HandlerRecord for event-handler IDL/content attributes
  }

  function resolveTarget(t) { return t === undefined || t === null ? L.window : t; }

  const PASSIVE_DEFAULT_TYPES = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);
  function defaultPassive(target, type) {
    if (!PASSIVE_DEFAULT_TYPES.has(type)) return false;
    if (target === L.window || target === L.document) return true;
    if (L.isNode(target)) {
      const ln = L.lnOf(target);
      if ((ln === 'html' || ln === 'body') && L.nsOf(target) === 0 && L.isConnectedNode(target)) return true;
    }
    return false;
  }

  function addListener(target, l) {
    let map = LS.get(target);
    if (map === undefined) { map = new Map(); LS.set(target, map); }
    let list = map.get(l.type);
    if (list === undefined) { list = []; map.set(l.type, list); }
    list.push(l);
    return list;
  }
  function prependListener(target, l) {
    let map = LS.get(target);
    if (map === undefined) { map = new Map(); LS.set(target, map); }
    let list = map.get(l.type);
    if (list === undefined) { list = []; map.set(l.type, list); }
    list.unshift(l);
  }
  function removeListenerObj(target, l) {
    l.removed = true;
    const map = LS.get(target);
    if (map === undefined) return;
    const list = map.get(l.type);
    if (list === undefined) return;
    const i = list.indexOf(l);
    if (i >= 0) list.splice(i, 1);
  }
  L.hasListeners = function (target, type) {
    const map = LS.get(target);
    if (map === undefined) return false;
    const list = map.get(type);
    return list !== undefined && list.length > 0;
  };

  function flattenCapture(options) {
    if (typeof options === 'boolean') return options;
    if (options !== null && typeof options === 'object') return !!options.capture;
    return !!options;
  }

  class EventTarget {
    constructor() { /* listeners are stored in a WeakMap keyed by the target */ }
    addEventListener(type, callback, options) {
      const target = resolveTarget(this);
      if (arguments.length < 2) {
        throw new TypeError(`Failed to execute 'addEventListener' on 'EventTarget': 2 arguments required, but only ${arguments.length} present.`);
      }
      if (callback === null || callback === undefined) return;
      if (typeof callback !== 'function' && typeof callback !== 'object') {
        throw new TypeError("Failed to execute 'addEventListener' on 'EventTarget': The callback provided as parameter 2 is not an object.");
      }
      type = `${type}`;
      let capture = false, once = false, passive = null, signal = null;
      if (options !== null && typeof options === 'object') {
        capture = !!options.capture;
        once = !!options.once;
        const p = options.passive;
        if (p !== undefined) passive = !!p;
        const s = options.signal;
        if (s !== undefined) {
          if (!L.isAbortSignal(s)) {
            throw new TypeError("Failed to execute 'addEventListener' on 'EventTarget': Failed to read the 'signal' property from 'AddEventListenerOptions': Failed to convert value to 'AbortSignal'.");
          }
          signal = s;
        }
      } else if (options !== undefined) {
        capture = !!options;
      }
      if (signal !== null && L.signalAborted(signal)) return;
      if (passive === null) passive = defaultPassive(target, type);
      const map = LS.get(target);
      if (map !== undefined) {
        const list = map.get(type);
        if (list !== undefined) {
          for (let i = 0; i < list.length; i++) {
            const l = list[i];
            if (l.handler === null && l.callback === callback && l.capture === capture) return;
          }
        }
      }
      const l = new Listener(type, callback, capture, once, passive);
      addListener(target, l);
      if (signal !== null) L.addAbortAlgorithm(signal, () => removeListenerObj(target, l));
    }
    removeEventListener(type, callback, options) {
      const target = resolveTarget(this);
      if (callback === null || callback === undefined) return;
      type = `${type}`;
      const capture = flattenCapture(options);
      const map = LS.get(target);
      if (map === undefined) return;
      const list = map.get(type);
      if (list === undefined) return;
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l.handler === null && l.callback === callback && l.capture === capture) {
          l.removed = true;
          list.splice(i, 1);
          return;
        }
      }
    }
    dispatchEvent(event) {
      const target = resolveTarget(this);
      if (!EV.is(event)) {
        throw new TypeError("Failed to execute 'dispatchEvent' on 'EventTarget': parameter 1 is not of type 'Event'.");
      }
      const f = EV.flags(event);
      if ((f & F_DISPATCH) || (f & F_UNINIT)) {
        throw new DOMException("Failed to execute 'dispatchEvent' on 'EventTarget': The event is already being dispatched.", 'InvalidStateError');
      }
      EV.setTrusted(event, false);
      return (dispatchCore(target, event, null) & 1) === 0;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Event handlers (IDL attributes like el.onclick, and content attributes onclick="...")
  // ---------------------------------------------------------------------------------------
  // GlobalEventHandlers (Chrome, minus touch handlers which are hidden without a touch screen)
  const GLOBAL_HANDLERS = [
    'onabort', 'onanimationend', 'onanimationiteration', 'onanimationstart', 'onauxclick', 'onbeforeinput',
    'onbeforematch', 'onbeforetoggle', 'onblur', 'oncancel', 'oncanplay', 'oncanplaythrough', 'onchange',
    'onclick', 'onclose', 'oncontentvisibilityautostatechange', 'oncontextlost', 'oncontextmenu',
    'oncontextrestored', 'oncopy', 'oncuechange', 'oncut', 'ondblclick', 'ondrag', 'ondragend', 'ondragenter',
    'ondragleave', 'ondragover', 'ondragstart', 'ondrop', 'ondurationchange', 'onemptied', 'onended', 'onerror',
    'onfocus', 'onfocusin', 'onfocusout', 'onformdata', 'ongotpointercapture', 'oninput', 'oninvalid',
    'onkeydown', 'onkeypress', 'onkeyup', 'onload', 'onloadeddata', 'onloadedmetadata', 'onloadstart',
    'onlostpointercapture', 'onmousedown', 'onmouseenter', 'onmouseleave', 'onmousemove', 'onmouseout',
    'onmouseover', 'onmouseup', 'onmousewheel', 'onpaste', 'onpause', 'onplay', 'onplaying', 'onpointercancel',
    'onpointerdown', 'onpointerenter', 'onpointerleave', 'onpointermove', 'onpointerout', 'onpointerover',
    'onpointerrawupdate', 'onpointerup', 'onprogress', 'onratechange', 'onreset', 'onresize', 'onscroll',
    'onscrollend', 'onsecuritypolicyviolation', 'onseeked', 'onseeking', 'onselect', 'onselectionchange',
    'onselectstart', 'onslotchange', 'onstalled', 'onsubmit', 'onsuspend', 'ontimeupdate', 'ontoggle',
    'ontransitioncancel', 'ontransitionend', 'ontransitionrun', 'ontransitionstart', 'onvolumechange',
    'onwaiting', 'onwebkitanimationend', 'onwebkitanimationiteration', 'onwebkitanimationstart',
    'onwebkittransitionend', 'onwheel',
  ];
  const WINDOW_HANDLERS = [
    'onafterprint', 'onbeforeprint', 'onbeforeunload', 'onhashchange', 'onlanguagechange', 'onmessage',
    'onmessageerror', 'onoffline', 'ononline', 'onpagehide', 'onpageshow', 'onpopstate', 'onrejectionhandled',
    'onstorage', 'onunhandledrejection', 'onunload', 'onpagereveal', 'onpageswap',
  ];
  // Handlers of <body>/<frameset> that are forwarded to the window
  const BODY_FORWARDED = ['onblur', 'onerror', 'onfocus', 'onload', 'onresize', 'onscroll'].concat(WINDOW_HANDLERS);
  const DOCUMENT_HANDLERS = ['onreadystatechange', 'onvisibilitychange', 'onfullscreenchange', 'onfullscreenerror',
    'onpointerlockchange', 'onpointerlockerror', 'onfreeze', 'onresume', 'onprerenderingchange',
    'onwebkitfullscreenchange', 'onwebkitfullscreenerror', 'onbeforecopy', 'onbeforecut', 'onbeforepaste', 'onsearch'];
  L.GLOBAL_HANDLERS = GLOBAL_HANDLERS;
  L.WINDOW_HANDLERS = WINDOW_HANDLERS;
  L.BODY_FORWARDED = BODY_FORWARDED;
  L.DOCUMENT_HANDLERS = DOCUMENT_HANDLERS;

  const SPECIAL_TYPES = {
    onwebkitanimationend: 'webkitAnimationEnd', onwebkitanimationiteration: 'webkitAnimationIteration',
    onwebkitanimationstart: 'webkitAnimationStart', onwebkittransitionend: 'webkitTransitionEnd',
  };
  function handlerType(name) { return SPECIAL_TYPES[name] || name.slice(2); }
  // event type -> content attribute name, for types that have content attributes
  const TYPE_TO_ATTR = new Map();
  for (const n of GLOBAL_HANDLERS.concat(WINDOW_HANDLERS, DOCUMENT_HANDLERS)) TYPE_TO_ATTR.set(handlerType(n), n);
  const ATTR_IS_HANDLER = new Set(GLOBAL_HANDLERS.concat(WINDOW_HANDLERS));
  const GLOBAL_TYPES = new Set(GLOBAL_HANDLERS.map(handlerType));
  const FORWARDED_TYPES = new Set(BODY_FORWARDED.map(handlerType));
  L.isHandlerAttr = (name) => ATTR_IS_HANDLER.has(name);
  function isBodyLike(el) {
    const ln = L.lnOf(el);
    return (ln === 'body' || ln === 'frameset') && L.nsOf(el) === 0;
  }

  // target -> Map<type, HandlerRecord>
  const HS = new WeakMap();
  function handlerRec(target, type, create) {
    let m = HS.get(target);
    if (m === undefined) {
      if (!create) return undefined;
      m = new Map();
      HS.set(target, m);
    }
    let r = m.get(type);
    if (r === undefined && create) {
      r = { value: null, listener: null, scopeEl: null, type, target };
      m.set(type, r);
    }
    return r;
  }

  function isWindow(t) { return t === L.window; }

  function makeHandlerListener(rec) {
    const l = new Listener(rec.type, null, false, false, false);
    l.handler = rec;
    l.callback = function (event) { return runHandler(rec, this, event); };
    return l;
  }
  function activate(rec, prepend) {
    if (rec.listener !== null) return;
    const l = makeHandlerListener(rec);
    rec.listener = l;
    if (prepend) prependListener(rec.target, l); else addListener(rec.target, l);
  }
  function deactivate(rec) {
    if (rec.listener !== null) {
      removeListenerObj(rec.target, rec.listener);
      rec.listener = null;
    }
    rec.value = null;
  }

  // Compile an inline handler content attribute with the legacy scope chain
  // (document, form owner, element).
  function compileHandler(rec) {
    const code = rec.value;
    const type = rec.type;
    const isErr = type === 'error' && isWindow(rec.target);
    const el = rec.scopeEl;
    const attrName = TYPE_TO_ATTR.get(type) || 'on' + type;
    const params = isErr ? 'event, source, lineno, colno, error' : 'event';
    const src = 'with(__d)with(__f)with(__e){return function ' + attrName + '(' + params + '){\n' + code + '\n}}';
    let fn = null;
    try {
      const factory = N.compileFunction(src, ['__d', '__f', '__e'], L.documentURL ? L.documentURL() : '');
      const form = el !== null && L.formOwnerOf ? L.formOwnerOf(el) : null;
      fn = factory(L.document || {}, form || {}, el || {});
    } catch (e) {
      L.report(e);
      fn = null;
    }
    rec.value = fn;
    return fn;
  }
  function handlerValue(rec) {
    if (typeof rec.value === 'string') return compileHandler(rec);
    return rec.value;
  }

  function runHandler(rec, thisArg, event) {
    const fn = handlerValue(rec);
    if (fn === null || fn === undefined) return;
    if (typeof fn !== 'function') return;
    const type = rec.type;
    let ret;
    if (type === 'error' && isWindow(rec.target) && event instanceof ErrorEvent) {
      ret = Reflect.apply(fn, thisArg, [event.message, event.filename, event.lineno, event.colno, event.error]);
      if (ret === true) event.preventDefault();
      return;
    }
    ret = Reflect.apply(fn, thisArg, [event]);
    if (type === 'beforeunload') {
      if (ret !== undefined && ret !== null) {
        event.preventDefault();
        if (event instanceof BeforeUnloadEvent && event.returnValue === '') event.returnValue = `${ret}`;
      }
    } else if (ret === false) {
      event.preventDefault();
    }
  }

  // Look for an inline handler content attribute that the layer has not seen yet (set by
  // the parser, innerHTML or cloning) and register it (at the front: it existed before any
  // listener could have been added).
  function discoverInline(target, type) {
    const m = HS.get(target);
    if (m !== undefined && m.has(type)) return;
    const attr = TYPE_TO_ATTR.get(type);
    if (attr === undefined) return;
    let el;
    if (isWindow(target)) {
      if (!FORWARDED_TYPES.has(type)) return;
      el = L.bodyElement ? L.bodyElement() : null;
      if (el === null) return;
    } else if (L.isNode(target) && L.lnOf(target) !== '') {
      if (!GLOBAL_TYPES.has(type)) return;
      if (FORWARDED_TYPES.has(type) && isBodyLike(target)) return; // belongs to the window
      el = target;
    } else {
      return;
    }
    const code = N.getAttr(L.idOf(el), attr);
    if (code === null) return;
    const rec = handlerRec(target, type, true);
    rec.value = code;
    rec.scopeEl = el;
    activate(rec, true);
  }

  // IDL getter/setter implementations
  function getHandlerIDL(target, type) {
    discoverInline(target, type);
    const rec = handlerRec(target, type, false);
    if (rec === undefined) return null;
    const v = handlerValue(rec);
    return v === undefined ? null : v;
  }
  function setHandlerIDL(target, type, value) {
    discoverInline(target, type);
    const rec = handlerRec(target, type, true);
    if (value === null || value === undefined || (typeof value !== 'function' && typeof value !== 'object')) {
      deactivate(rec);
      return;
    }
    rec.value = value;
    activate(rec, false);
  }
  // Called by the attribute mutation path when an on* content attribute changes.
  L.handlerAttrChanged = function (el, name, value) {
    if (!ATTR_IS_HANDLER.has(name)) return;
    let target = el;
    const type = handlerType(name);
    if (isBodyLike(el) && FORWARDED_TYPES.has(type)) {
      if (!(L.isBodyOfDocument && L.isBodyOfDocument(el))) return;
      target = L.window;
    } else if (!GLOBAL_TYPES.has(type)) {
      return;
    }
    const rec = handlerRec(target, type, true);
    if (value === null) { deactivate(rec); return; }
    rec.value = value;
    rec.scopeEl = el;
    activate(rec, false);
  };

  L.defineEventHandlers = function (proto, names, targetFn) {
    for (const name of names) {
      const type = handlerType(name);
      Object.defineProperty(proto, name, {
        get: targetFn
          ? function () { return getHandlerIDL(targetFn(this), type); }
          : function () { return getHandlerIDL(resolveTarget(this), type); },
        set: targetFn
          ? function (v) { setHandlerIDL(targetFn(this), type, v); }
          : function (v) { setHandlerIDL(resolveTarget(this), type, v); },
        enumerable: true,
        configurable: true,
      });
    }
  };
  L.getHandlerIDL = getHandlerIDL;
  L.setHandlerIDL = setHandlerIDL;

  // ---------------------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------------------
  L.currentEvent = undefined; // window.event
  L.eventParent = function () { return null; }; // replaced by 20_dom.js
  L.activation = null; // click activation behaviour, installed by 30_html.js

  function buildPath(target, event) {
    const path = [target];
    let t = L.eventParent(target, event);
    while (t !== null && t !== undefined) {
      path.push(t);
      t = L.eventParent(t, event);
    }
    return path;
  }

  function invoke(ct, event, phase, pass, type) {
    const map = LS.get(ct);
    if (map === undefined) return;
    const list = map.get(type);
    if (list === undefined || list.length === 0) return;
    EV.setPhase(event, phase);
    EV.setCurrent(event, ct);
    const snapshot = list.length === 1 ? [list[0]] : list.slice();
    for (let i = 0; i < snapshot.length; i++) {
      const l = snapshot[i];
      if (l.removed) continue;
      if (pass === 1) { if (!l.capture) continue; } else if (l.capture) continue;
      if (l.once) removeListenerObj(ct, l);
      if (l.passive) EV.setFlag(event, F_PASSIVE);
      const prevEvent = L.currentEvent;
      L.currentEvent = event;
      try {
        const cb = l.callback;
        if (typeof cb === 'function') {
          Reflect.apply(cb, ct, [event]);
        } else {
          const he = cb.handleEvent;
          if (typeof he !== 'function') throw new TypeError("'handleEvent' property of event listener is not a function");
          Reflect.apply(he, cb, [event]);
        }
      } catch (e) {
        L.report(e);
      }
      L.currentEvent = prevEvent;
      if (l.passive) EV.clearFlag(event, F_PASSIVE);
      if (EV.flags(event) & F_STOP_IMM) break;
    }
  }

  // Core dispatch; returns bit flags: 1 = canceled, 2 = propagation stopped,
  // 4 = default/activation behaviour performed by the JS layer.
  function dispatchCore(target, event, pathOverride, targetOverride) {
    EV.setFlag(event, F_DISPATCH);
    const type = EV.type(event);
    const evTarget = targetOverride === undefined ? target : targetOverride;
    EV.setTarget(event, evTarget);
    const path = pathOverride !== null ? pathOverride : buildPath(target, event);
    EV.setPath(event, path);

    // Inline handler discovery (content attributes set by the parser / innerHTML / clone)
    if (TYPE_TO_ATTR.has(type)) {
      for (let i = 0; i < path.length; i++) discoverInline(path[i], type);
    }

    let act = null;
    if (type === 'click' && L.activation !== null && event instanceof MouseEvent) {
      try { act = L.activation.begin(path, event); } catch (e) { L.report(e); act = null; }
    }

    // capture
    for (let i = path.length - 1; i > 0; i--) {
      if (EV.flags(event) & F_STOP) break;
      invoke(path[i], event, CAPTURING_PHASE, 1, type);
    }
    // target: capturing listeners, then non-capturing
    if (!(EV.flags(event) & F_STOP)) invoke(path[0], event, AT_TARGET, 1, type);
    if (!(EV.flags(event) & F_STOP)) invoke(path[0], event, AT_TARGET, 2, type);
    // bubble
    if (EV.bubbles(event)) {
      for (let i = 1; i < path.length; i++) {
        if (EV.flags(event) & F_STOP) break;
        invoke(path[i], event, BUBBLING_PHASE, 2, type);
      }
    }
    const f = EV.flags(event);
    let result = ((f & F_CANCELED) ? 1 : 0) | ((f & F_STOP) ? 2 : 0);
    EV.setPhase(event, NONE);
    EV.setCurrent(event, null);
    EV.setPath(event, []);
    EV.clearFlag(event, F_DISPATCH | F_STOP | F_STOP_IMM);

    if (act !== null) {
      try {
        if (L.activation.end(act, event, (result & 1) !== 0)) result |= 4;
      } catch (e) {
        L.report(e);
      }
    }
    return result;
  }
  L.dispatchCore = dispatchCore;
  // Dispatch a (possibly trusted) event created by the layer; returns !defaultPrevented.
  L.dispatch = function (target, event, trusted) {
    EV.setTrusted(event, trusted !== false);
    return (dispatchCore(target, event, null) & 1) === 0;
  };
  // Fire a simple event: L.fire(target, 'load', {bubbles:false}, Event)
  L.fire = function (target, type, init, Ctor, trusted) {
    const ev = new (Ctor || Event)(type, init);
    EV.setTrusted(ev, trusted !== false);
    return (dispatchCore(target, ev, null) & 1) === 0;
  };
  // Dispatch at the window with the Document as target ("legacy target override").
  L.fireAtWindowWithDocumentTarget = function (type, init, Ctor) {
    const ev = new (Ctor || Event)(type, init);
    EV.setTrusted(ev, true);
    return (dispatchCore(L.window, ev, [L.window], L.document) & 1) === 0;
  };
  L.createNativeEvent = function (Ctor, type, init) {
    nativeConstruction = true;
    try {
      const ev = new Ctor(type, init);
      EV.setTrusted(ev, true);
      return ev;
    } finally {
      nativeConstruction = false;
    }
  };

  // ---------------------------------------------------------------------------------------
  // AbortController / AbortSignal
  // ---------------------------------------------------------------------------------------
  const abortAlgos = new WeakMap();
  class AbortSignal extends EventTarget {
    #aborted = false;
    #reason = undefined;
    constructor(token) {
      if (token !== L.INTERNAL) throw L.illegal();
      super();
    }
    get aborted() { return this.#aborted; }
    get reason() { return this.#reason; }
    throwIfAborted() { if (this.#aborted) throw this.#reason; }
    static abort(reason) {
      const s = new AbortSignal(L.INTERNAL);
      s.#aborted = true;
      s.#reason = reason === undefined ? new DOMException('signal is aborted without reason', 'AbortError') : reason;
      return s;
    }
    static timeout(ms) {
      const s = new AbortSignal(L.INTERNAL);
      const delay = Number(ms);
      if (!(delay >= 0)) throw new TypeError("Failed to execute 'timeout' on 'AbortSignal': Value is outside the 'unsigned long long' value range.");
      L.internalTimeout(() => signalAbort(s, new DOMException('signal timed out', 'TimeoutError')), delay);
      return s;
    }
    static any(signals) {
      const s = new AbortSignal(L.INTERNAL);
      const list = Array.from(signals);
      for (const x of list) {
        if (!(x instanceof AbortSignal)) throw new TypeError("Failed to execute 'any' on 'AbortSignal': Failed to convert value to 'AbortSignal'.");
      }
      for (const x of list) {
        if (x.#aborted) { s.#aborted = true; s.#reason = x.#reason; return s; }
      }
      for (const x of list) L.addAbortAlgorithm(x, () => signalAbort(s, x.#reason));
      return s;
    }
    static {
      L.isAbortSignal = (o) => typeof o === 'object' && o !== null && #aborted in o;
      L.signalAborted = (o) => o.#aborted;
      L.signalReason = (o) => o.#reason;
      L.signalAbortInternal = (s, reason) => {
        if (s.#aborted) return;
        s.#aborted = true;
        s.#reason = reason === undefined ? new DOMException('signal is aborted without reason', 'AbortError') : reason;
        const algos = abortAlgos.get(s);
        abortAlgos.delete(s);
        if (algos) for (const fn of algos) L.safeCall(fn, undefined, []);
        L.fire(s, 'abort', { bubbles: false, cancelable: false });
      };
    }
  }
  function signalAbort(s, reason) { L.signalAbortInternal(s, reason); }
  L.createAbortSignal = () => new AbortSignal(L.INTERNAL);
  L.addAbortAlgorithm = function (signal, fn) {
    if (L.signalAborted(signal)) return;
    let a = abortAlgos.get(signal);
    if (a === undefined) { a = []; abortAlgos.set(signal, a); }
    a.push(fn);
  };
  L.defineEventHandlers(AbortSignal.prototype, ['onabort']);

  class AbortController {
    #signal = new AbortSignal(L.INTERNAL);
    get signal() { return this.#signal; }
    abort(reason) { signalAbort(this.#signal, reason); }
  }

  // ---------------------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------------------
  Object.assign(L, {
    Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, DragEvent, KeyboardEvent, FocusEvent,
    InputEvent, CompositionEvent, TouchEvent, Touch, TouchList, ErrorEvent, ProgressEvent, PopStateEvent,
    HashChangeEvent, PageTransitionEvent, AnimationEvent, TransitionEvent, SubmitEvent, FormDataEvent,
    PromiseRejectionEvent, MediaQueryListEvent, ToggleEvent, ClipboardEvent, StorageEvent, MessageEvent,
    BeforeUnloadEvent, SecurityPolicyViolationEvent, EventTarget, AbortSignal, AbortController, CloseEvent,
  });
  for (const [name, C] of Object.entries({
    Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, DragEvent, KeyboardEvent, FocusEvent,
    InputEvent, CompositionEvent, TouchEvent, Touch, TouchList, ErrorEvent, ProgressEvent, PopStateEvent,
    HashChangeEvent, PageTransitionEvent, AnimationEvent, TransitionEvent, SubmitEvent, FormDataEvent,
    PromiseRejectionEvent, MediaQueryListEvent, ToggleEvent, ClipboardEvent, StorageEvent, MessageEvent,
    BeforeUnloadEvent, SecurityPolicyViolationEvent, EventTarget, AbortSignal, AbortController, CloseEvent,
  })) L.expose(name, C);
  L.expose('DOMException', L.DOMException);

  // Map of event type -> constructor used for native events (hooks.onEvent)
  const NATIVE_EVENT_CLASSES = new Map();
  for (const t of ['click', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup', 'pointermove', 'pointerover',
    'pointerout', 'pointerenter', 'pointerleave', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
    'pointerrawupdate']) NATIVE_EVENT_CLASSES.set(t, PointerEvent);
  for (const t of ['mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'dblclick'])
    NATIVE_EVENT_CLASSES.set(t, MouseEvent);
  for (const t of ['wheel', 'mousewheel']) NATIVE_EVENT_CLASSES.set(t, WheelEvent);
  for (const t of ['keydown', 'keyup', 'keypress']) NATIVE_EVENT_CLASSES.set(t, KeyboardEvent);
  for (const t of ['focus', 'blur', 'focusin', 'focusout']) NATIVE_EVENT_CLASSES.set(t, FocusEvent);
  for (const t of ['beforeinput']) NATIVE_EVENT_CLASSES.set(t, InputEvent);
  for (const t of ['compositionstart', 'compositionupdate', 'compositionend']) NATIVE_EVENT_CLASSES.set(t, CompositionEvent);
  for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) NATIVE_EVENT_CLASSES.set(t, TouchEvent);
  for (const t of ['drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop']) NATIVE_EVENT_CLASSES.set(t, DragEvent);
  for (const t of ['copy', 'cut', 'paste']) NATIVE_EVENT_CLASSES.set(t, ClipboardEvent);
  for (const t of ['select', 'selectstart', 'selectionchange', 'resize']) NATIVE_EVENT_CLASSES.set(t, t === 'resize' ? UIEvent : Event);
  NATIVE_EVENT_CLASSES.set('submit', SubmitEvent);
  NATIVE_EVENT_CLASSES.set('toggle', ToggleEvent);
  NATIVE_EVENT_CLASSES.set('beforetoggle', ToggleEvent);
  L.nativeEventClass = function (type, init) {
    if (type === 'input') return init && init.inputType !== undefined ? InputEvent : Event;
    return NATIVE_EVENT_CLASSES.get(type) || Event;
  };
})(globalThis.__layer);
