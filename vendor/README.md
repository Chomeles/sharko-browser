# Vendored crates

Forks of upstream crates with fixes needed by this browser. Each change is marked with
a `// PATCH:` comment so it can be upstreamed or re-applied on upgrades.

* `blitz-dom` 0.3.0-beta.2 — DOM/style/layout core (DioxusLabs/blitz).
* `blitz-paint` 0.3.0-beta.2 — painter (DioxusLabs/blitz).
* `anyrender_vello` 0.14.0 — Vello GPU backend (DioxusLabs/anyrender).
* `parley` 0.11.1 — text layout (linebender/parley).
* `taffy` 0.14.0 — box layout: block/flex/grid (DioxusLabs/taffy).
* `stylo_taffy` 0.3.0-beta.2 — Stylo→Taffy style conversion (DioxusLabs/blitz), unmodified
  except for its dependency on Stylo 0.21.

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
24. `blitz-dom/src/stylo.rs`: an element's first style resolution always carries full
    layout damage (inserting a subtree that was hidden no longer leaves stale layout).
25. `blitz-dom/src/document.rs`, `mutator.rs`: stylesheets inserted by script after
    parsing no longer block rendering (`set_parser_done`), as in browsers.
26. `blitz-dom/src/layout/inline.rs`, `taffy/src/tree/cache.rs`: inline roots whose line
    breaks were computed for a different width during intrinsic sizing are re-broken at
    their final width (`relayout_stale_inline_roots`).
27. `blitz-dom/src/layout/inline.rs`, `parley/src/layout/line_break.rs`: a float that
    does not fit next to the content already on the current line is placed below it.
28. `blitz-dom/src/layout/mod.rs`: block children that place floats bypass the layout
    cache (their float placement depends on the parent's float context).
29. `blitz-dom/src/layout/inline.rs`, `taffy/src/compute/block.rs`: floats inside inline
    content count towards the enclosing block formatting context (its height grows to
    contain them, and the block is not served from the layout cache, which let a later
    float overlap them).
30. `blitz-dom/src/layout/inline.rs`: shrink-to-fit widths include the floats of inline
    content under a definite available width too.
31. `taffy/src/compute/block.rs`: a block formatting context whose content ends with
    floats keeps its bottom padding and border below them.
32. `blitz-dom/src/document.rs`: `getBoundingClientRect()` applies CSS transforms, ancestor
    scroll offsets and sticky shifts, and `position: fixed` boxes keep their viewport
    position when the page scrolls.
33. Incremental layout passes (a script that writes a style and reads `offsetWidth` no
    longer pays for the whole document, 20x faster in the layout-thrash benchmark):
    `taffy/src/compute/mod.rs` exposes `round_single_layout`, and `blitz-dom` rounds only
    subtrees whose layout changed (`round_layout_incremental`, layout-dirty flags set by
    `set_unrounded_layout`); `layout/damage.rs` flushes styles to taffy only in damaged
    subtrees; `resolve.rs` rebuilds layout children only there; `layout/abspos.rs` fixes
    out-of-flow boxes only in changed subtrees; stale inline roots are tracked in a list.
34. `blitz-dom/src/stylo.rs`: a new style object always carries (repaint) damage, also
    when it looks the same, so that the node's taffy style (which points into the
    style's `calc()` values) is refreshed.
35. `blitz-dom/src/layout/verify.rs`: `BLITZ_VERIFY_INCREMENTAL=1` re-runs the style
    flush, out-of-flow fixup and rounding over the whole tree after each layout and
    reports nodes where the incremental result differs.
36. `blitz-dom/src/legacy_hints.rs`, `stylo.rs`: legacy table/font attributes as
    presentational hints: `cellspacing`, `cellpadding`, `border` and `align=center` on
    `<table>`, `valign`/`nowrap` on cells and rows, `<font color face size>`; `<table
    align>` no longer centers the table's text.
37. `blitz-dom/src/layout/table.rs`: a row's `height` is its minimum height (also for
    rows without cells, e.g. spacer rows).
38. `parley/src/layout/data.rs`, `blitz-dom/src/stylo_to_parley.rs`, `layout/construct.rs`:
    `line-height: normal` uses the font's ascent, descent and line gap, each rounded to
    whole pixels like Chromium (it was 1.2em, so text was ~5% taller than in browsers).
39. `blitz-dom/assets/default.css`, `layout/mod.rs`: form controls use the 13.33px control
    font and Chromium's box metrics; text inputs are sized by their `size` attribute
    (20 characters by default) instead of 300px.
40. Stylo 0.21 with `:has()` and `:nth-child(An+B of S)` enabled (`document.rs`);
    `blitz-dom/src/has_invalidation.rs` runs Stylo's relative-selector invalidation
    (as Gecko's glue does) for attribute/class/id/state changes before each style pass
    and for insertions/removals in `mutator.rs`, so `:has()` rules follow DOM changes.
41. `blitz-dom/src/node/node.rs`, `stylo.rs`: nodes remember their index in the parent's
    child list, so sibling lookups during selector matching (`+`, `~`, `:nth-*`) no longer
    scan the whole child list at every step.
42. `blitz-dom/src/scrolling.rs`: `scroll_into_view` scrolls every scrolling ancestor
    (innermost first) before the viewport and honours `block`/`inline`, so carousels and
    tab strips scroll themselves instead of the whole page jumping.
43. `blitz-dom/src/layout/construct.rs`, `node/svg.rs`: SVG paint from CSS reaches usvg
    as sRGB `rgb()`/`rgba()`, and `color(display-p3|srgb|srgb-linear …)` in SVG markup
    and images is rewritten as `rgb()` (usvg painted wide-gamut colors black).
44. `blitz-dom/src/stylo.rs`, `document.rs`: CSS animation and transition events
    (`animationstart`/`iteration`/`end`, `transitionrun`/`start`/`end`) are recorded
    while ticking Stylo's animations (`take_animation_events`) for the embedder to
    dispatch; `each_custom_state` and `implicit_scope_for_sheet_in_shadow_root` no
    longer `todo!()`-panic (reachable from `:has()` invalidation).
45. `blitz-dom/src/node/svg.rs`, `layout/construct.rs`: SVG `currentcolor` in any spelling
    resolves to the element's color, and paint that comes from `var()` in presentation
    attributes is always forwarded from CSS (usvg knows neither).
46. `taffy/src/style/mod.rs`, `compute/block.rs`, `stylo_taffy`: `position: fixed`
    boxes no longer add to their container's scrollable overflow (a fixed `body`
    made the page unscrollable).
47. `blitz-dom/src/layout/inline.rs`: floats inside inline formatting contexts count
    toward the scrollable overflow.
48. `blitz-dom/src/node/node.rs`, `blitz-paint/src/render.rs`: absolute/fixed children
    hoisted into an ancestor stacking context are painted and hit-tested at their real
    position (including scroll offsets) and clipped by the overflow of the ancestors
    between them and their containing block (carousels painted slides outside the box).
49. `blitz-dom/src/image_source.rs` (new), `mutator.rs`, `document.rs`, `layout/mod.rs`,
    `resolve.rs`: `<img>` source selection (`srcset` with `x`/`w` descriptors, `sizes`,
    `<picture>`/`<source media type>`, Chromium's candidate choice), density-corrected
    intrinsic sizes, re-selection on attribute and viewport changes, and
    `loading="lazy"` (loads within 1250px of the viewport, never while
    `display: none`). Before, only `src` loaded and every image of a page was fetched
    and decoded up front (t-online.de: 1.4 GB).
50. `blitz-dom/src/net.rs`, `layout/damage.rs`: image responses are keyed by the
    requested URL, not the final URL after redirects (redirected images never showed);
    decoded images are no longer copied before the RGBA conversion.
51. `blitz-dom/src/document.rs`: `getBoundingClientRect()` of an `<img>` (and other
    replaced elements) without data is its own box, not its line's fragment.
