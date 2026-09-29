# otto.de: Svelte custom elements lose their light children (open)

Symptom: `TypeError: Cannot read properties of null (reading '#id')` at `get firstChild`
(Svelte 5 template `first_child(...)`), `hydration_mismatch`, page 76% of Chromium height,
score 34.

Mechanism (verified with a local copy of the page and a hook on `importNode`):
1. Svelte clones its template with `document.importNode(template.content, true)`; the
   clone contains `<oc-row-v2><div class="title">…</div></oc-row-v2>`.
2. `importNode` upgrades the element; its constructor calls `attachShadow()`.
3. `attachShadow` (20_dom.js `shadowPrepare`) moves the host's children into a light
   fragment; `host.firstChild/childNodes` then show the (empty) shadow content, so Svelte
   walks `firstChild(row)` -> null and crashes.
Minimal repro: constructor with `this.attachShadow({mode:'open'})`, importNode of a
fragment with `<x><div>x</div></x>`: `x.childNodes.length` is 0 (Chromium: 1).

Fixed on the way (commit "Keep template contents inert"): elements inside template contents
were upgraded too, which emptied the template itself.

Remaining fix = dossier content-missing-b (`shadow-dom-flattened-into-light-tree`): present
the light tree from the JS getters (interim) or real shadow trees in blitz-dom (proper).

Not engine causes in the German shopping/news ranking: kleinanzeigen.de (IP-range block
page 403 in Chromium and Sharko alike), idealo/zalando/mediamarkt/saturn/rewe/conrad/ebay
(bot walls, see dossiers/bot-walls: TLS/h2 fingerprint).
