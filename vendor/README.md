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
52. `blitz-dom/src/resolve.rs`: transform resolution never skips anonymous blocks (their
    damage isn't tracked): animated inline-blocks next to blocks kept the transform of
    their first keyframe, so e.g. `scale(0)` spinners stayed invisible.
53. `blitz-dom/src/layout/damage.rs`: children hoisted into a stacking context are
    collected in (order-modified) tree order, so equal z-indexes paint in document
    order; descendants used to come before direct children (a consent dialog's backdrop
    covered the dialog).
54. `blitz-dom/src/node/node.rs`: hit testing always tries a stacking context's hoisted
    children; its `content_area` is computed before layout and was stale or empty, so
    z-indexed boxes nested in another stacking context could not be clicked.
55. `blitz-dom/src/document.rs`: `font_context()` and `set_canvas_pixels()` for the
    embedder's canvas 2D implementation (the canvas' pixels are shown as its image).
56. `taffy/src/compute/flexbox.rs`: a single-line row flex container sized under definite
    available space is fit-content wide (max-content clamped to the space, at least its
    items' minimum sizes), not max-content: text in a flex row inside a column with
    `align-items: flex-start` didn't wrap (heise.de's consent dialog overflowed).
57. `blitz-dom/src/layout/construct.rs`, `layout/damage.rs`: a removed `::before`/`::after`
    is also dropped from its element's layout and paint children (not rebuilt for inline
    elements), and damage traversals skip ids of dropped nodes; the dangling id panicked
    and left welt.de blank.
58. `blitz-dom/src/stylo.rs`: `frameborder` on `<iframe>`/`<frame>` that isn't a non-zero
    integer ("0", "no") maps to zero border widths, as in Chrome (ad iframes showed 2px
    inset borders).
59. `taffy/src/compute/grid/mod.rs`: a grid container with an unknown width under a
    definite available width is fit-content wide (its max-content width clamped to the
    available space, not below its min-content width); `1fr` columns kept their
    max-content size, so a grid in a column flex container with `align-items:
    flex-start` overflowed it (focus.de consent dialog).
60. `blitz-dom/src/layout/damage.rs`, `assets/default.css`: buttons are `box-sizing:
    border-box` (as in Chrome), and `text-align: left/right/start/end` on a button whose
    contents the UA centers (`justify-content: center`) aligns them to that side.
61. `parley/src/shape/mod.rs`: a pictograph with the default text presentation (e.g.
    ▶ ✔ ❤, Emoji_Presentation=No) and no U+FE0F is shaped with the text fonts and their
    fallbacks instead of the emoji font first (its color bitmaps didn't render: blank).
62. `parley/src/layout/line_break.rs`: the empty line after a trailing newline (kept for
    the cursor with an empty run) doesn't count toward the layout's height: `text<br>`,
    `<br>` and `<pre>a\n</pre>` are one line tall, as in browsers (every block ending in
    a `<br>` had an extra blank line).
63. `parley/src/builder.rs`, `blitz-dom/src/layout/construct.rs`, `node/text.rs`,
    `document.rs`: inline layouts record the text byte range of each DOM text node
    (`TextLayout::text_nodes`), and `text_range_client_rects()` returns the line rects of
    part of a text node (Range geometry), without hanging trailing spaces.
64. `blitz-dom/src/node/element.rs`, `stylo.rs`: `ElementData::script_animation_declarations`
    holds the current values of script animations (`Element.animate`); `animation_rule`
    cascades them after the element's CSS animations (at the animation level, so the
    style attribute stays untouched) and `has_animations` accounts for them.
65. `blitz-dom/src/mutator.rs`, `net.rs`, `document.rs`: `<link rel=preload>` fetches its
    resource and fires `load`; changing a `<link>`'s `rel` loads or drops its stylesheet
    (the async-CSS pattern `rel=preload as=style` + `rel='stylesheet'` from script left
    welt.de unstyled).
66. `blitz-dom/src/document.rs`, `mutator.rs`: `linked_stylesheet_source()` keeps the
    source text of each `<link rel=stylesheet>`'s sheet (CSSOM `cssRules` of linked
    sheets).
67. `blitz-dom/src/node/node.rs`, `document.rs`: walks up `layout_parent` tolerate ids of
    dropped nodes (`try_with`), instead of panicking in a native (a stale pointer to a
    rebuilt anonymous box crashed getBoundingClientRect on welt.de once).
68. `taffy/src/compute/grid/types/grid_item.rs`: a grid item's specified minimum size that
    can't be resolved during track sizing (a percentage against the indefinite grid area)
    counts as zero for its minimum contribution instead of falling back to the
    content-based automatic minimum; `main { min-width: 100% }` in a `1fr` column full of
    wide slider content stretched the column (n-tv.de grew to 10^35 px).
69. `blitz-dom/src/net.rs`, `document.rs`: an `@import`ed stylesheet is handed to the
    document as `Resource::NestedCss` and hooked into its import rule (and its fonts
    fetched) on the document's thread; the network callback thread wrote the shared
    style lock, which panicked while the page was styling (nytimes.com: 20 panics).
70. `blitz-dom/src/layout/construct.rs`, `layout/mod.rs`: a replaced element (img, canvas,
    video, iframe, embed) never builds boxes for its children, so `display: table` on it
    no longer replaces its image/canvas data with a table context (the replaced layout
    then panicked at `unreachable!()`; the fallback now uses the tag's intrinsic sizes).
    Found by `tools/fuzz/run.js`.
71. `blitz-dom/src/traversal.rs`: `node_layout_ancestors` stops at the first id that no
    longer exists instead of indexing it. The hover/active node is retargeted when its
    subtree is removed, but its `layout_parent` chain can still name an anonymous box
    dropped by a later box rebuild, and a native click arriving between a DOM mutation
    and the next resolve then panicked (`invalid SlotMap key`; `tools/fuzz/run.js
    --clicks=30`, seeds 108 and 136).
72. `taffy/src/compute/block.rs`, `flexbox.rs`, `grid/mod.rs`, `grid/alignment.rs`: scrollable
    overflow per CSS Overflow 3 §2.2. A scroll container's end padding extends the overflow
    region past the end edges of its in-flow children's margin boxes; it was added on top
    of whatever overflow the descendants contributed, so a child overflowing by its border
    box got the padding a second time and negative margins never pulled it back in
    (`scrollWidth`/`scrollHeight` too large, phantom scrollbars). Flex and grid items'
    margin boxes are part of the region. Zero-area boxes still contribute nothing.
73. `blitz-dom/src/layout/inline.rs`: atomic inline boxes (inline-block, inline-flex, …)
    and floats take the scrollable overflow rect of the layout pass that placed them (it
    stayed stale from an earlier layout of the element as a block, so an inline-block's
    `scrollWidth` reported the former block width), and where their `overflow` is visible
    it escapes into the inline container's scrollable overflow.
74. `blitz-dom/src/mutator.rs`, `iframe.rs`: an `<iframe>` without `src` (or with
    `about:blank`) gets an empty document right away (the initial `about:blank` document
    of the HTML spec, with the parent's base URL), so scripts can `contentDocument.write`
    into it or fill it through `contentWindow.document` before it ever loads anything.
    A `srcdoc` document records the `<iframe>`'s `load` event like a fetched one (the
    initial empty document records none).
75. `blitz-dom/src/document.rs`: `remove_sub_document` keeps the removed iframe document
    alive until the host calls `drop_detached_sub_documents()` (the renderer does, between
    tasks). Script realms hold raw pointers to the documents of their frames for the
    duration of a script entry; a frame removed during that entry (a script removing an
    `<iframe>` and then using its document's objects, or an iframe removing itself) must
    not free the document under a realm that is still running.
