# Rules (single source of truth)

Rewritten at the owner's request: the earlier rules were set wrongly and are void. If any other file contradicts this one, this one wins and the other file gets corrected.

1. Goal: an own-engine browser that works normally on the market. No WebView2 fallback. Windows only.
2. Method: reproduce against Chromium, read how a reference engine does it (`docs/REFERENCE-MAP.md`), fix the root cause per standard/WPT, never per-site hacks.
3. Speed first: work in parallel (lane sessions with their own machines), small steps, no waiting for permission on decisions inside these rules.
4. Git: one root cause per commit. A lane pushes to its `claude/lane-*` branch and, when a cause is done, merges it itself: `git fetch origin master && git merge origin/master` into the lane branch (resolve conflicts yourself, you know your code), rerun the JS tests and your targeted tests (and the WPT dirs of the area, no UNEXPECTED), then open a pull request to `master` (template in `.github/pull_request_template.md`, German, with the test results) and merge it (merge commit) as soon as CI is not red because of your change. Small PRs, one cause each, never one giant collector PR. The lead watches the nightly Windows trend (report job, `worse than the previous run` lines) and sends regressions back to the lane that caused them. Lanes are cut by cause, not by site: the report job's cause list (`tools/sitediff/causes.js`: error signatures, issue tags, lost stylesheets, slow loads, each with the sites it hits) is the order of work, biggest cluster first. Bot walls (`bot-wall` tag) are counted apart and are not a rendering cause.
5. Releases: the lead releases whenever the Windows smoke build starts and there are no crashes; sitediff numbers are reported with every release but do not block it. Pre-releases (`-beta.N`) are preferred while the sitediff median is above 5.
6. Commit messages end with the trailers from `git log -1 --format=%B`. No model names anywhere in the repo.
7. README (en/de) is kept current when behaviour changes.
8. Reports: short, German, factual, including failures.
