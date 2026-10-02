# sitediff: Sharko vs Chromium on real sites

`tools/sitediff` loads the same sites in Sharko (headless) and in Chromium (Playwright)
and diffs what came out. It answers "where is Sharko wrong on the web?" with numbers
instead of anecdotes, and it groups the failures by cause, so a fix is made where it
repairs many sites at once rather than one site at a time.

```
node tools/sitediff/run.js                        # the list in sites.txt
node tools/sitediff/run.js --random=40 --seed=7   # ... plus 40 random Tranco domains
node tools/sitediff/run.js https://www.mydealz.de/ https://www.heise.de/
node tools/sitediff/run.js --dark                 # prefers-color-scheme: dark in both
node tools/sitediff/run.js --compare-only         # only redo the diffs and the report
```

Needs a built browser (`target/profiling` or `target/release`, or `--browser=`) and
Playwright with its Chromium (`npm i -g playwright && npx playwright install chromium`).
Behind a MITM proxy Chromium is started with `--ignore-certificate-errors` through
`$HTTPS_PROXY`.

## What is compared

Both browsers run the same probe (`probe.js`) after `load` + `--settle` ms at 1280×800
with the same User-Agent:

- the visible text (`innerText`): words Chromium shows that Sharko does not, and the
  other way round (hidden content leaking out);
- a sample of up to 800 laid-out elements, matched by id or nth-of-type path: position,
  size, dark/light background and text colour, font size, `display`;
- images (loaded/broken), stylesheets (readable rules), fonts, page height and width,
  element count, `prefers-color-scheme`;
- console errors, reduced to signatures (`X is not a function`, ...) and counted only
  when Chromium does not report the same;
- the screenshots, downscaled and compared in Chromium (blank page, gross differences);
- crashes, hangs, navigation failures and load timeouts of Sharko.

Each finding is an issue tag with a weight; the sum (capped at 100) is the site's score.
0 means "like Chromium", anything under 10 is noise (ads, tickers, fonts). The report
lists issues and Sharko-only errors by the number of sites they hit — the order in which
to fix things.

## Output

`out/` (git-ignored):

- `report.md` — the ranking and, per site, the issues with an example each;
- `summary.json` — the same as data, plus per-site metrics;
- `<site>/chromium.{json,png}`, `<site>/sharko.{json,png}`, `<site>/sharko.log`
  (Sharko's console), `<site>/diff.json`.

`report.md` ends its tables with "Load times": Sharko's own engine time (first frame, DOMContentLoaded,
load) next to the wall time of the whole process (start, `--settle`, probe, screenshot) and Chromium's load.
The V8 snapshot is kept across the fresh per-site profiles, so it does not count as page load.
`BROWSER_DEBUG_NET=1` (one line per request), `BROWSER_DEBUG_STYLE=1` (every style+layout pass >= 20 ms)
and `BROWSER_DEBUG_LOAD=1` show where a slow load goes.

Chromium results are the reference and are cached; `--refresh` re-runs them. Sharko is
re-run every time, so after a fix `node tools/sitediff/run.js` shows what changed.

## Gate, causes, trend

```
node tools/sitediff/gate.js   [summary.json] [--baseline=previous.json]   # pass/fail, per-site trend
node tools/sitediff/causes.js [summary.json] [--top=25]                   # the work list by cause
```

A site that answers Sharko with a challenge or block page ("Nur einen Moment…", "verify
you are human", "unusual traffic") gets the `bot-wall` tag: it measures the server's bot
detection, not the engine. `gate.js` counts walls apart and takes the median and the 60+
count over the rendering sites only; with `--baseline` it lists the sites that moved by
15 or more and the walls that appeared or passed.

`causes.js` turns the same summary into the order of work: Sharko-only error signatures
by the number of sites they hit, issue tags by total weight, stylesheets Sharko lost
(readable sheets and rules against Chromium's), and the slowest load events relative to
Chromium. The Windows smoke report job prints both after every sweep.

## Reading a diff

- `js-errors` with `X is not a function` / `X is not defined` — a missing Web API; check
  `tools/api-inventory` and add it in `crates/script`.
- `body-background`, `backgrounds-differ`, `text-colors-differ` — usually a CSS feature
  the stylesheet relies on (`color-scheme`, `light-dark()`, a media query, `:has()`,
  custom properties in a fallback) resolving differently.
- `layout-shifted`, `sizes-differ`, `page-too-short` — a layout feature (grid/flex
  detail, `position: sticky`, aspect-ratio, container queries) — reproduce with a small
  page and fix in `vendor/blitz-dom`/Taffy.
- `text-missing`/`dom-differs` with few errors — a script path that silently does
  nothing (event never fires, a promise never resolves, fetch/XHR difference).
- `images-broken` — image format, `srcset`/`sizes`, lazy loading or a network detail.
- `blocked` on the Chromium side is a bot wall; the site is skipped, not scored.

Bot walls, consent banners and A/B tests make single runs noisy: a site is worth looking
at when its score is high in two runs, and a cause is worth fixing when it hits several
sites.
