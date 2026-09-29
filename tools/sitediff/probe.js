// The in-page probe of tools/sitediff: the same function runs in Sharko (via --eval)
// and in Chromium (via Playwright) and returns what the comparison needs — the visible
// text, a sample of laid-out elements with their boxes and key styles, image and
// stylesheet state and a few document-level numbers. Synchronous, plain ES2017, no
// dependencies (it has to run in both engines; a probe that itself throws in Sharko is
// recorded as a `probe-error` finding).
'use strict';

function probe() {
  const out = { probeErrors: [] };
  const step = (name, f) => {
    try {
      f();
    } catch (e) {
      out.probeErrors.push(name + ': ' + (e && e.message ? e.message : String(e)));
    }
  };
  const round = (n) => Math.round(n);
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1, BR: 1, WBR: 1 };

  step('document', () => {
    const cs = getComputedStyle(document.body);
    const hs = getComputedStyle(document.documentElement);
    out.href = location.href;
    out.title = document.title;
    out.readyState = document.readyState;
    out.dark = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    out.viewport = { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
    out.doc = {
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      elements: document.getElementsByTagName('*').length,
      bodyBg: cs.backgroundColor,
      bodyColor: cs.color,
      htmlBg: hs.backgroundColor,
      bodyFont: cs.fontFamily,
      lang: document.documentElement.lang,
      frames: document.getElementsByTagName('iframe').length,
    };
  });

  step('text', () => {
    const t = document.body.innerText || '';
    out.text = t.replace(/\s+/g, ' ').trim().slice(0, 40000);
  });

  step('images', () => {
    const imgs = document.images;
    const s = { total: imgs.length, loaded: 0, broken: 0, pending: 0, visibleBroken: [] };
    for (let i = 0; i < imgs.length; i++) {
      const im = imgs[i];
      if (!im.complete) {
        s.pending++;
        continue;
      }
      if (im.naturalWidth > 0) s.loaded++;
      else if (im.currentSrc || im.src) {
        s.broken++;
        const r = im.getBoundingClientRect();
        if (r.width > 8 && r.height > 8 && s.visibleBroken.length < 10) {
          s.visibleBroken.push((im.currentSrc || im.src).slice(0, 160));
        }
      }
    }
    out.images = s;
  });

  step('stylesheets', () => {
    const sheets = document.styleSheets;
    const s = { total: sheets.length, readable: 0, rules: 0, links: document.querySelectorAll('link[rel~="stylesheet"]').length };
    for (let i = 0; i < sheets.length; i++) {
      try {
        s.rules += sheets[i].cssRules.length;
        s.readable++;
      } catch (e) {
        /* cross-origin */
      }
    }
    out.stylesheets = s;
  });

  step('fonts', () => {
    if (document.fonts) {
      let loaded = 0;
      let total = 0;
      document.fonts.forEach((f) => {
        total++;
        if (f.status === 'loaded') loaded++;
      });
      out.fonts = { total, loaded, status: document.fonts.status };
    }
  });

  step('elements', () => {
    // A key that identifies an element in both engines: its id when unique, else the
    // nth-of-type path from <body>.
    const ids = Object.create(null);
    const withId = document.querySelectorAll('[id]');
    for (let i = 0; i < withId.length; i++) ids[withId[i].id] = (ids[withId[i].id] || 0) + 1;
    const keyOf = (el) => {
      const parts = [];
      let e = el;
      while (e && e !== document.body && e.nodeType === 1) {
        if (e.id && ids[e.id] === 1 && /^[A-Za-z][\w:-]{0,40}$/.test(e.id)) {
          parts.push('#' + e.id);
          break;
        }
        let n = 1;
        let s = e.previousElementSibling;
        while (s) {
          if (s.tagName === e.tagName) n++;
          s = s.previousElementSibling;
        }
        parts.push(e.tagName.toLowerCase() + ':' + n);
        e = e.parentNode;
      }
      return parts.reverse().join('/');
    };
    const all = document.body.querySelectorAll('*');
    const els = [];
    const maxY = 3000;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < all.length && i < 6000 && els.length < 800; i++) {
      const el = all[i];
      if (SKIP[el.tagName]) continue;
      // The <svg> root is a box like any other; its content is compared as pixels only.
      if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 400 || r.bottom <= 0 || r.top >= maxY) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
      let own = '';
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) own += c.nodeValue;
      }
      own = own.replace(/\s+/g, ' ').trim().slice(0, 40);
      els.push({
        k: keyOf(el),
        t: el.tagName.toLowerCase(),
        r: [round(r.left), round(r.top), round(r.width), round(r.height)],
        bg: cs.backgroundColor,
        c: cs.color,
        fs: parseFloat(cs.fontSize) || 0,
        d: cs.display,
        p: cs.position,
        x: own,
      });
    }
    out.elements = els;
    out.elementsScanned = Math.min(all.length, 6000);
  });

  return out;
}

module.exports = { source: '(' + probe.toString() + ')()' };
