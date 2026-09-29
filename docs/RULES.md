# Rules (single source of truth)

Rewritten at the owner's request: the earlier rules were set wrongly and are void. If any other file contradicts this one, this one wins and the other file gets corrected.

1. Goal: an own-engine browser that works normally on the market. No WebView2 fallback. Windows only.
2. Method: reproduce against Chromium, read how a reference engine does it (`docs/REFERENCE-MAP.md`), fix the root cause per standard/WPT, never per-site hacks.
3. Speed first: work in parallel (lane sessions with their own machines), small steps, no waiting for permission on decisions inside these rules.
4. Git: one root cause per commit. Lanes push to their `claude/lane-*` branch. The lead opens a pull request per merged lane or milestone (never one giant collector PR) and merges it.
5. Releases: the lead releases whenever the Windows smoke build starts and there are no crashes; sitediff numbers are reported with every release but do not block it. Pre-releases (`-beta.N`) are preferred while the sitediff median is above 5.
6. Commit messages end with the trailers from `git log -1 --format=%B`. No model names anywhere in the repo.
7. README (en/de) is kept current when behaviour changes.
8. Reports: short, German, factual, including failures.
