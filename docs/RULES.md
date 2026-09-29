# Rules (single source of truth)

If any other file in the repo contradicts this one, this one wins, and the other file is to be corrected.

1. Goal: an own-engine browser that works normally on the market. No WebView2 fallback. Windows is the target and the only release platform.
2. Method: reproduce against Chromium, read how a reference engine does it (`docs/REFERENCE-MAP.md`), fix the root cause per standard/WPT. Never per-site hacks.
3. Git: work on your outcome branch, one root cause per commit, push it. Pushing is the end state.
4. No pull requests, no tags, no force-push, no history rewriting, no skipped/weakened tests. Never mention PRs in reports.
5. Commit messages end with `[skip ci]` (except a deliberate CI trigger) and the trailers from `git log -1 --format=%B`. No model names anywhere in the repo.
6. Releases: only the lead, only through the gate in `docs/RELEASING.md`.
7. README (en/de) is kept current when behaviour changes.
8. Reports: short, German, factual, including failures.
