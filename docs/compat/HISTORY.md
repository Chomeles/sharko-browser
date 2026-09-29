# Compatibility history

One row per milestone check. Source: Windows CI run "Windows smoke" (sharded `tools/sitediff` against Chromium, then `tools/sitediff/gate.js`). Lower scores are better; the gate needs median <= 8 and at most 5% of sites at 60 or more, with no crashes or hangs.

| Date (UTC) | Commit | Sites compared | Median | Sites >= 60 | Crashes/hangs | Gate | Notes |
|---|---|---|---|---|---|---|---|
| 2026-09-29 | first Windows sweep (before the fixes below) | 179 | 13 | 39 (22%) | 0 | fail | baseline |
| 2026-09-29 | f4f5daf | 179 | 9 | 30 (17%) | 0 | fail | after shadow/currentScript, Origin, crash fixes, body overflow, SVG sprites, JS-layer lanes; run 36565184639 |
| 2026-09-29 | 7cdc212 (v0.2.1 + lanes chrome-headers, container-queries, german-sites, base-href, css-prefs, layout-investigation) | 180 | 8 | 27 (15%) | 0 | fail | top issues: js-errors 57, dom-differs 36, stylesheets-missing 27, layout-partly-shifted 21, images-missing 20; run 36597537789 |
