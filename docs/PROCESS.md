# Process: how Sharko is built, checked and released

> Rules: `docs/RULES.md` wins over anything here.

Status: in force from 2026-09-29. Items marked `(P1..P10)` are process work packages that make a rule
machine-enforced; until one lands, the rule still applies and the lead checks it by hand.
Goals and exit criteria: [GOALS.md](GOALS.md). Roster, file ownership, templates: `docs/TEAM.md`.
Reference engines: [REFERENCE-MAP.md](REFERENCE-MAP.md). Release mechanics: [RELEASING.md](RELEASING.md).

## 1. Principles

1. **CI is the judge.** A claim ("fixed", "ready", "releasable") is true only when a machine check says so.
2. **Root cause, never per-site.** Fix spec gaps (WPT, reference engine as recipe); no site names in `crates/`.
   No per-site interventions list. Every fix is evidenced by 2 unrelated sites, or a WPT flip, or a repro page.
3. **Every fix ships a regression test:** WPT flip, JS-layer test, Rust test or `tools/repros/` page.
4. **Windows is the product.** Windows CI is authoritative; container/Linux sweeps run behind a proxy and only rank work.
5. **Nothing valuable lives in scratch space.** Findings are committed the day they are made (section 8).
6. **Decide without asking**, except the list in section 11. Record non-trivial decisions as ADR.

## 2. Roles

| Role | Does | Must not |
|---|---|---|
| Owner | Reads the German summary, dogfoods on the beta channel, decides section 11 items | Review code or PRs |
| Lead / integrator | Cuts work items, merges into `int` (single writer), keeps generated docs current, runs merge freezes | Fix bugs in a lane's area while merging |
| Lane session (9) | Claims and fixes items in its area: shadow-components, layout-css, dom-events, web-apis, network-security, graphics-media, stability-perf, shell-ui, web-compat | Touch another lane's files without a handoff note |
| Verifier | Fresh-context review of M/L items and any `vendor/` or security change; tries to refute the fix | Be the author's session |
| Release workflow | Builds, gates, signs, publishes. Humans and agents never sign by hand | Run on an ungated SHA |

## 3. The loop

1. **Discover:** sitediff, WPT, dogfood report or crash report becomes `docs/compat/issues/<id>.json`. Search there first; never re-diagnose a known cause.
2. **Plan:** lead writes `docs/work/<area>-<nnn>.md` (id, tier S/M/L, evidence, repro with the Chromium value, `done_when`, budget).
3. **Claim:** `git push origin HEAD:refs/heads/claim/<id>` is atomic; the loser picks the next item. Claims idle over 6 h are deleted. Work happens on `lane/<area>/<id>` in a separate worktree.
4. **Fix:** port the algorithm from a reference engine (M/L), mark vendored changes `// PATCH(slug): why`, add the test.
5. **Verify:** CI on the lane branch; for M/L a verifier writes `docs/reviews/<id>.md` (PASS/FAIL, commands, two refutation attempts).
6. **Merge:** lead merges `--no-ff` into `int` only on green CI (and PASS where required), then regenerates generated docs. No pull requests.
7. **Measure:** nightly sweep and WPT on `int` append a history row (section 8); a per-site regression opens an issue automatically.
8. **Release:** gate, beta, soak, stable (section 6).

Status: every lane keeps `docs/status/<area>.md` (max 12 lines: updated, done id+sha+before>after, doing, blocked-needs, tokens/wall, next). Older than 4 h = alarm to lead.
Merge freeze: if `int` is red for over 2 h, only the fix for the red may merge.

## 4. Gates

| Gate | Where | Must hold |
|---|---|---|
| G0 fix | author | repro passes in the real binary (equals Chromium value); WPT directory has no UNEXPECTED; new test; `tools/check.sh` green |
| G1 merge | CI on branch | Windows build + `cargo test`; JS-layer tests (hard fail); `fmt`, `clippy`; WPT quick subset; commit lint; no regression on the sites named in the item |
| G2 beta | release workflow, same SHA | G1 + Windows E2E (section 5) + sitediff on the frozen set: 0 crash/hang, no site worse than baseline by +20 (one retry), median not above the previous release + WPT 0 regressions + notices regenerated |
| G3 stable | release workflow | G2 re-run on the shipped artifact + at least 3 days on beta with no open `crash`/`regression` issue + absolute limits in `tools/gate/thresholds.json` (now: median <= 8, share of sites scoring >= 60 <= 10%; ratcheted down to the GOALS.md Stage 1 values, never up) + at least 10 `Fixes:` trailers since the last stable |

`gate.js` never ends in `|| true`. Thresholds live in one file, are shared by CI and the release workflow, and change only downward.
Sitediff runs on a frozen site set (trend) plus a rotating-seed holdout (overfitting check); bot-wall sites are reported separately;
Playwright, Chromium, Tranco snapshot and WPT revision are pinned and recorded in every result. (P6)

## 5. CI policy (P2, P7)

- `ci.yml` runs on every push to every branch and on PRs; `paths-ignore` for docs-only changes; concurrency cancels superseded runs. `[skip ci]` is used on commits per docs/RULES.md.
- Each push: Windows build + tests, JS-layer tests, fmt, clippy (blocking after the first clean baseline), commit lint (no model identifiers).
- Heavy jobs: sharded sitediff and full WPT run nightly and on `int` only (free plan = 20 concurrent jobs; 9 lanes x 6 shards would queue). `windows-smoke` starts by `workflow_dispatch`, not by a trigger file.
- Windows E2E (`windows-e2e.yml`): install into a temp profile; window alive 20 s + screenshot (`--selftest-window`); scripted flows (type, click, form, scroll, tab crash); update A to B via `file://` manifest with a test key; corrupt-DLL fallback.
- Default branch and CI triggers must name the same branch (`master`).

## 6. Release policy (P4, P5)

- Tags are pushed autonomously, only through the workflow gate. A tag cannot bypass the `verify` job; the workflow refuses to modify an existing release. A wrong release is fixed by a new version, never by replacing assets.
- Channels: `beta` (tags `vX.Y.Z-beta.N`, GitHub prerelease, own manifest; the owner's copy follows it) and `stable` (`releases/latest`). Stable is promoted from a soaked beta; the promotion job needs the `release` environment.
- Manifest carries `channel`, `rollout` (0-100 by client-id hash), `blocked[]`, `rollback_to`, `next_key` (rotation), German release notes from `Changelog:` trailers. Prerelease versions compare correctly.
- Launcher writes `starting`/`good` markers; two failed starts select the previous version, record it in `bad-versions`, and the updater skips it.
- Bootstrap: v0.2.1 is the last release through `latest` (old clients only read `latest`); it carries rollback and channels. v0.2.0 stays, marked superseded.
- Signing key: one key in the `release` environment, offline backup held by the owner, agents never see it. Package contains `LICENSES/` from `xtask notices`. Authenticode is an owner decision (section 11).
- Stable reaches people beyond the owner and known testers only after the owner says so; until then `latest` is treated as owner-only.

## 7. Feedback loop (P8)

- **Report page:** F9 / toolbar button / crash page writes `%LOCALAPPDATA%\browser\reports\<ts>\` (report.json, screenshot, console, log tail) and puts a short text on the clipboard. No network. Query strings stripped; DOM snapshot off; screenshot warning shown. Public GitHub issue only after an explicit click.
- **Crashes:** panic hook + minidump to `crashes\`; next start offers the report bundle; PDBs of every release kept 90 days as private artifacts.
- **Triage:** issues labelled `broken-page` run sitediff on one validated URL (URL passed via `env`, `https?` only, no private/metadata IPs) and get a comment with score and top tags; the web-compat lane pulls open ones daily.
- **Dogfood:** `docs/DOGFOOD.md` is a 15-minute checklist (typing with a German keyboard, search, login, shop, PDF, video as known-fail, zoom/DPI, tabs, 30 min open). The owner answers "ok" or "not ok + F9".
- **Dashboard** (`about:sharko` and generated page): must-have pass rate x/25, crashes per 10 h active, first-frame p50, open `broken-page` issues with median age.

## 8. Knowledge persistence (P1, P10)

| What | Where | Rule |
|---|---|---|
| Root causes | `docs/compat/issues/<id>.json` (one file per issue) + generated `ISSUES.md` | fields: mechanism, evidence, repro, sites, fixSketch, status, lane, fixedBy |
| Repro pages | `tools/repros/<area>/`, contract `window.__repro={issue,expected,actual,pass}`, `xfail.txt` for open ones | expectations verified in real Chromium; run by `check.sh` and CI |
| Measurements | `docs/compat/history/<ts>-<sha>.json`, one file per run, single writer (nightly job); generated `HISTORY.md` | record sha, OS, Chromium version, Tranco id, seed, per-site scores, WPT per area |
| Decisions | `docs/adr/ADR-nnn.md` | realm, shadow DOM, TLS/bot walls, release + gate, root-cause rule, vendoring, lanes |
| Vendor patches | frozen `vendor/PATCHES-001-080.md`; new ones only as `// PATCH(slug): why`, generated `vendor/PATCHES.md` | per-crate `UPSTREAM.md` base commit; monthly upstream bugfix review |
| WPT baseline | `tools/wpt/expected/<dir>.json` (split per directory), `WPT_REV` | improvement updates it, regression fails |
| Commits | trailers `Fixes: <issue-id>`, `Changelog: <German sentence>` (user-visible only) | body explains why |

Scratch space (`/tmp`, scratchpads) is ephemeral: durable results are committed the same day; prompts never hard-code such paths.
The repo is public: never commit cookies, auth headers or raw header captures; secret-scan before committing dossiers.
Docs: READMEs stay short and stable; volatile numbers live in generated `docs/STATUS.md`; `README.de.md` sections carry `<!-- en:<sha8> -->` markers and CI fails on drift.

## 9. Cost guard (P9)

- The binding limit is the shared weekly model quota, not dollars. CI minutes are free (public repo); the limit there is 20 concurrent jobs.
- Tiers: **S** (small fix): economy model, no reference-reading step, 60 min / 300k tokens. **M**: economy model + reference reading, 2 h. **L / security**: strongest model, design note in the work item first. At most 2 concurrent L sessions.
- `docs/ledger.csv`: one row per fix (id, tier, tokens, wall time, sha). `tools/quota.sh` refuses new spawns above the daily allotment.
- Workflows go through `tools/wf/run.js`: per-item status, retry with backoff on quota errors, abort above 10% failures, results written to the repo. A run is "completed" only if every item has a result; nulls are never filtered silently.
- Discovery runs only over items missing from `docs/compat/issues/`.

## 10. Commit and documentation rules

- Commits and docs in English; owner-facing messages in concise German.
- Trailers: `Co-Authored-By: Claude <noreply@anthropic.com>` and `Claude-Session: <url>`. No model identifiers in files or commit text; history is not rewritten. `tools/hooks/commit-msg` normalises the trailer and adds nothing else; CI lint rejects new violations.
- No pull requests to or for the owner; upstream PRs (Blitz, Taffy, Parley) only with owner approval.
- README.md and README.de.md are updated together at release time.

## 11. Escalation

Only the owner decides: public or irreversible acts (deleting releases, license, announcements, upstream contributions in the project's name);
money (certificates, servers); signing keys and repository-admin settings; data-protection lines (telemetry, public reports);
legal questions beyond the documented fingerprint policy (consistent, browser-like identity; no CAPTCHA solving).
Everything else is decided by the lead and reported in the next German summary.
To the lead: idle claim over 6 h, blocked item, verifier FAIL twice, quota alarm, `int` red over 2 h.
