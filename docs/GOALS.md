# Goals: what "a normal browser" means for Sharko

The bar is a browser that makes sense on the market: it works the way people expect, every day, on the sites they use. Progress is measured against three stages; each has exit criteria that a machine can check (sitediff gate, WPT pass rates, a scripted checklist), so "done" is never a feeling.

## Stage 1: reads the web (target: 2-4 weeks)

Exit criteria (all must hold on the Windows CI run, no proxy):
- `tools/sitediff` over the curated list (~240 sites) plus 200 random top-10k domains: median score <= 5, no crashes or hangs, <= 5% of sites scoring 60 or more (bot walls excluded only when Chromium itself is blocked).
- Cloudflare, Akamai and DataDome interstitials pass on the sites where Chromium passes (engine causes fixed: shadow DOM, cross-frame node moves, Chrome-consistent environment).
- Login and form flows work on: Google account, Microsoft account, Amazon, PayPal, GitHub, Reddit, German consent dialogs (Sourcepoint, OneTrust, Usercentrics) on the 20 biggest German news/shopping sites.
- WPT: html/dom, dom, css/cssom, cssom-view, fetch, xhr, url, encoding, shadow-dom, custom-elements each >= 90% of subtests (current values in `docs/compat/HISTORY.md`).
- No renderer crash in a 30-minute scripted browsing loop over 100 sites (stability lane).
- UI basics: tabs, address bar with search, back/forward, reload, bookmarks, history, downloads, find in page, zoom, settings, dark mode.

## Stage 2: does most of what people do (target: 2-4 months)

- Video and audio: HTML media elements play H.264/VP9/AV1/AAC/Opus (Windows Media Foundation or bundled decoders), Media Source Extensions, captions; YouTube, Twitch, news video work. (Widevine DRM: out of scope.)
- WebGL 1/2 through the GPU stack, canvas and SVG complete, fonts and text rendering on par (web fonts, variable fonts, emoji).
- Service workers, Cache API, Push absence handled honestly, IndexedDB persistent and shared across frames, WebRTC basics.
- Layout parity: css reftests run by our runner (reftest support), container queries, subgrid, content-visibility, scroll snapping, sticky, viewport units.
- sitediff median <= 3 with real user interactions replayed (recorded from Chromium).
- Password manager and autofill, printing, PDF viewer, downloads manager, permissions UI.

## Stage 3: viable as a main browser (target: 6-12 months)

- Site isolation and OS sandbox (Windows job objects and integrity levels), safe auto-update channels (nightly, beta, stable, rollback), crash reporting with symbolication.
- Extensions (at least a WebExtensions subset with content scripts and ad-blocking APIs), sync, profiles.
- Accessibility (screen reader support), IME and complex text input, high-DPI and multi-monitor behaviour.
- Performance parity or better on start-up, page load and memory (published numbers).

## How progress is tracked

- `docs/compat/HISTORY.md`: one row per milestone check: sitediff median and gate result, WPT pass rate per lane, crash counts, timings.
- `docs/lanes/*.md`: each lane's backlog and status.
- The release gate (`tools/sitediff/gate.js`) decides when a version is published (Windows only).
