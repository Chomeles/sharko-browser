# Vendored crates

Forks of upstream crates with fixes needed by this browser. Each change is marked with
a `// PATCH:` comment so it can be upstreamed or re-applied on upgrades.

* `blitz-dom` 0.3.0-beta.2 — DOM/style/layout core (DioxusLabs/blitz).
* `blitz-paint` 0.3.0-beta.2 — painter (DioxusLabs/blitz).
* `anyrender_vello` 0.14.0 — Vello GPU backend (DioxusLabs/anyrender).
* `parley` 0.11.1 — text layout (linebender/parley).
* `taffy` 0.14.0 — box layout: block/flex/grid (DioxusLabs/taffy).

Patches so far:
1. `blitz-dom/src/layout/table.rs`: anonymous table objects (non-table children of a
   `display: table` box become full-row cells instead of being dropped).
2. `blitz-dom/src/layout/construct.rs`, `inline.rs`, `document.rs`: horizontal
   margin/border/padding of inline elements via zero-height spacer inline boxes.
3. `blitz-paint/src/text.rs`: inline backgrounds cover the padding spacers.
4. `blitz-dom` + `blitz-paint`: `position: sticky` (vertical), incl. hit testing.
5. `blitz-dom/src/net.rs`: fetch only the Latin `unicode-range` subsets of web fonts.
6. `anyrender_vello`: area anti-aliasing and only its pipelines (faster GPU startup).
7. `anyrender_vello/src/window_renderer.rs`: GPU initialisation on a background thread
   (`resume_in_background`), explicit adapter choice (no software rasterizers, integrated
   GPU first, Vulkan/Metal before DX12, no GL), a persistent Vulkan pipeline cache and a
   warm-up frame so that the first real frame is fast.
8. `parley/src/resolve/tree.rs`, `builder.rs`: CSS white-space collapsing across inline
   element boundaries (no trimming at every span start/end, `&nbsp;` is never
   collapsed); spacer boxes that are transparent to collapsing.
9. `blitz-dom/src/shadow_css.rs`, `document.rs`, `stylo.rs`: style scoping for the
   emulated shadow DOM (stylesheets inside a shadow host only apply to its subtree,
   `:host`, `::slotted()`), `<style>`/`<link>` in `<template>` contents are inert.
10. `blitz-dom/src/stylo.rs`: `:defined` (built-ins always, custom elements once
    upgraded); class selectors compare bytes instead of interning an atom per token.
11. `blitz-dom/src/layout/construct.rs`: inline `<svg>`: referenced elements outside the
    `<svg>` (`<use href="#icon">` sprites, `url(#gradient)`) are copied into a `<defs>`;
    own serializer that keeps `currentColor` and passes CSS-set `fill`/`stroke` (and the
    root's `color`) to usvg.
12. `taffy/src/compute/block.rs`, `blitz-dom/src/layout/replaced.rs`: compressible replaced
    elements: a percentage `width`/`max-width` resolves against zero for the min-content
    contribution (`<img width=872 style="max-width:100%">` in a flex item can shrink).
13. `blitz-dom/src/layout/damage.rs`: `top`/`left`/… are ignored for `position: static`
    and for `sticky` (applied at paint time) instead of acting as relative offsets.
14. `blitz-dom/src/layout/construct.rs`, `document.rs`: empty inline elements get a
    zero-width box, so they have a position (`getClientRects()`, IntersectionObserver).
15. `blitz-dom/src/font_defaults.rs`, `stylo_to_parley.rs`: browser default fonts
    (`sans-serif` → Arial, `serif` → Times New Roman) and metric-compatible substitutes
    (Liberation/Croscore) for missing Arial, Helvetica, Times, Courier.
16. `blitz-dom/src/net.rs`: `@font-face` `format()` strings (`'woff'`,
    `'embedded-opentype'`, …) and URL extensions with `?query#fragment`: the bulletproof
    `url(f.eot?#iefix) format('embedded-opentype'), url(f.woff)` syntax loaded the EOT.
17. `parley/src/resolve/tree.rs`: collapsible spaces at the end of the paragraph are
    removed even inside an inline element (no empty line for a trailing space).
18. `taffy/src/compute/block.rs`: an item's own floats no longer force clearance on it;
    `taffy/src/compute/float.rs`: floats fit with 1/64 px tolerance (percentage columns
    that add up to 100%).
19. Form controls: `placeholder` text (`blitz-dom` layout, `blitz-paint` in 54% of the text
    color) and `:placeholder-shown`; text inputs use the page's font; drop-down
    `<select>` shows its selected option (`:checked` state, UA stylesheet rules in
    `assets/default.css`) with an arrow unless `appearance: none`.
20. `blitz-paint/src/text.rs`: `text-overflow: ellipsis`.
21. `blitz-dom/src/document.rs`, `net.rs`, `mutator.rs`: the `media` attribute of
    `<link>`/`<style>` (print stylesheets no longer apply on screen or block rendering;
    changing it, as in `media="print" onload="this.media='all'"`, re-evaluates the sheet).
22. `blitz-dom/src/document.rs`, `mutator.rs`: `load`/`error` events for `<img>`,
    `<link rel=stylesheet>` and `<iframe>` (`take_element_load_events`); detached images
    (`new Image()`) load.
23. `blitz-dom/src/layout/abspos.rs`: absolutely positioned and fixed boxes are laid out
    against their containing block (nearest positioned/transformed ancestor, or the
    viewport) instead of their parent; `blitz-paint`: fixed boxes stay in place when the
    viewport scrolls.
