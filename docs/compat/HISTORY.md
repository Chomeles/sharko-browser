# Compatibility history

One row per milestone check. Source: Windows CI run "Windows smoke" (sharded `tools/sitediff` against Chromium, then `tools/sitediff/gate.js`). Lower scores are better; the gate needs median <= 8 and at most 5% of sites at 60 or more, with no crashes or hangs.

| Date (UTC) | Commit | Sites compared | Median | Sites >= 60 | Crashes/hangs | Gate | Notes |
|---|---|---|---|---|---|---|---|
| 2026-09-29 | first Windows sweep (before the fixes below) | 179 | 13 | 39 (22%) | 0 | fail | baseline |
| 2026-09-29 | f4f5daf | 179 | 9 | 30 (17%) | 0 | fail | after shadow/currentScript, Origin, crash fixes, body overflow, SVG sprites, JS-layer lanes; run 36565184639 |
