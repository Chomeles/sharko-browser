# How parallel developer sessions work

Several Claude sessions work at the same time, one per area ("lane"). The lead (a human or the lead session) merges. Nobody waits for the user: work, commit, push, update the lane file.

## Setup (once per container)
`tools/dev-setup.sh [extra WPT dirs]` checks disk, sparse-clones WPT to `../wpt` (override with `WPT_DIR`), adds hosts entries, starts `./wpt serve`, installs the JS test deps and prints the build and test commands. Safe to re-run. Then one build: `cargo build -j 3 --profile profiling -p browser-core -p browser-launcher`.

## Branches
- One branch per lane: `claude/lane-<area>` (e.g. `claude/lane-layout-css`), cut from `origin/claude/dreamy-galileo-qhqico` (the shared branch).
- Side work inside a lane: `claude/lane-<area>-<topic>`; merge it into the lane branch yourself.
- Never push tags, never open pull requests unless the lead asks.

## Commits and pushes
- Small commits, one thing each. Body carries the numbers before/after (WPT dir counts, `compare.js` TOTAL, sitediff sites).
- Add `[skip ci]` to the subject unless you want a CI run. The Windows workflow runs when `tools/ci/windows-smoke.trigger` changes; touch that file only in a commit that needs Windows verification.
- Every fix ships a regression test (JS-layer test, Rust test, repro page with `.expected.json` from Chromium, or a WPT flip).
- `tools/check.sh` (add `--rust` for native changes) must be green before you push.
- Push after each green commit, not at the end of the day: `git push -u origin claude/lane-<area>`.

## Rebase and merge etiquette
- The lead merges lane branches into the shared branch. You do not merge into it.
- Before pushing, if your lane branch is behind: `git fetch && git rebase origin/claude/dreamy-galileo-qhqico`. Re-run the fast tests after a non-trivial rebase.
- Never force-push the shared branch. On your own lane branch, `--force-with-lease` only after your own rebase, and never over someone else's commits.
- Conflicts in another lane's files: keep their side, adapt your change, and note it in your lane file. Conflicts in `expected.json`, `xfail.txt` or `NATIVE_API.md`: re-generate or merge both sides, never drop the other lane's entries.

## The loop
1. Pick the top open item of your lane's backlog (`docs/lanes/<area>.md`).
2. Reference step: read how Chromium, Firefox, WebKit, Servo or Ladybird do it (`docs/REFERENCE-MAP.md`). Port the algorithm, do not invent one; add a `// Ported from ...` comment and a `THIRD_PARTY_NOTICES.md` entry.
3. Minimal repro (`tools/repros/<area>/`) and its expected output from Chromium.
4. Fix the root cause.
5. Tests plus the WPT directories the item names: no UNEXPECTED; `--update` only when there are new passes, never accept PASS -> FAIL. Confirm `--update` with a non-batch run.
6. Commit, push.
7. Update the item's status in the lane file's backlog, then take the next item.

## Reporting
- Report through files and commit messages, not chat. A commit subject says what moved ("dom: iframe identity, html/dom 71.2 -> 73.0%").
- At every milestone (an item done, a baseline changed, a blocker found) update the `Status` section of `docs/lanes/<area>.md`: date, what landed, numbers, what is next, blockers.
- If blocked on something outside your lane, write it in `Status` under "Blocked", switch to the next backlog item and keep going.

## Decisions
Alone: implementation design inside your lane; order within the backlog when an item is blocked; adding tests, repros and WPT directories; refactors inside your crates; new numbered files in the JS layer; updating baselines when numbers improve.
Ask the lead (write it in `Status`, continue elsewhere): changes to another lane's files beyond a few lines; new dependencies or vendoring a new crate; edits to `vendor/*` (need a `// PATCH:` comment and a `vendor/README.md` entry); public API or `NATIVE_API.md` changes other lanes use; accepting a WPT/sitediff regression; CI, release or license changes; deleting features.

## Disk and CPU hygiene
- One build at a time per machine, `-j 3`. Do not start a second `cargo` while one runs; do not run `cargo clean` on a shared target.
- A `target/` is 8-12 GB. Check `df -h` before building; delete `target/` of worktrees you no longer use.
- WPT: `--jobs=3`, add only the directories you need with `git sparse-checkout add`. One `./wpt serve` per machine.
- Kill stray `chromium`, `node` and browser processes you started. Keep logs and scratch output out of the repo.

## Areas
- [shadow-components](lanes/shadow-components.md): Shadow DOM, custom elements, web components
- [layout-css](lanes/layout-css.md): layout engine, CSS, cssom
- [dom-events](lanes/dom-events.md): DOM, parsing, events, editing, selection
- [web-apis](lanes/web-apis.md): platform APIs (storage, workers, streams, ...)
- [network-security](lanes/network-security.md): netstack, TLS, CORS, cookies, CSP
- [graphics-media](lanes/graphics-media.md): painting, images, canvas, media, fonts
- [stability-perf](lanes/stability-perf.md): crashes, fuzzing, performance
- [shell-ui](lanes/shell-ui.md): browser chrome and UI
- [web-compat](lanes/web-compat.md): real-site compatibility (sitediff)
