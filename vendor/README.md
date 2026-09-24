# Vendored crates

Forks of upstream crates with fixes needed by this browser. Each change is marked with
a `// PATCH:` comment so it can be upstreamed or re-applied on upgrades.

* `blitz-dom` 0.3.0-beta.2 — DOM/style/layout core (DioxusLabs/blitz).
* `blitz-paint` 0.3.0-beta.2 — painter (DioxusLabs/blitz).

Patches so far:
1. `blitz-dom/src/layout/table.rs`: anonymous table objects (non-table children of a
   `display: table` box become full-row cells instead of being dropped).
2. `blitz-dom/src/layout/construct.rs`, `inline.rs`, `document.rs`: horizontal
   margin/border/padding of inline elements via zero-height spacer inline boxes.
3. `blitz-paint/src/text.rs`: inline backgrounds cover the padding spacers.
