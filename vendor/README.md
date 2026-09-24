# Vendored crates

Forks of upstream crates with fixes needed by this browser. Each change is marked with
a `// PATCH:` comment so it can be upstreamed or re-applied on upgrades.

* `blitz-dom` 0.3.0-beta.2 — DOM/style/layout core (DioxusLabs/blitz).
* `blitz-paint` 0.3.0-beta.2 — painter (DioxusLabs/blitz).
* `anyrender_vello` 0.14.0 — Vello GPU backend (DioxusLabs/anyrender).

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
