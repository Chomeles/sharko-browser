# Bot walls, lane 2: findings (Windows sweep 36888620502 and 36930988757)

Sites with score 100 split into groups. Sandbox IPs are blocked by every one of these walls (curl and Sharko), so only the Windows smoke can verify.

## Cloudflare managed challenge ("Nur einen Moment…")
mediamarkt, saturn, conrad, ecosia, chat.openai, udemy, medium, canva (also rewe, leo, lufthansa in the second run).
- `NaN` / `Trace: NaN` / `%c%d` console lines are Turnstile's own console probe (it calls every console method), not an error. Chromium prints them too; the sitediff `js-errors` tag counts them as Sharko-only because Chromium's log is not captured the same way.
- Fixed: cross-realm adoption copied nodes (`replaceChild` on the moved node threw). Smoke 36930988757 on the fix: same sites still on the challenge, and the log now shows no exception from the challenge iframe. So the remaining cause is the verdict, not a crash.
- Open (see `docs/dossiers/cf-challenge/diagnosis.json`, fingerprint-api-gaps): WebGL/WebGL2 contexts (canva logs `THREE.WebGLRenderer: Error creating WebGL context`), OffscreenCanvas, AudioContext/OfflineAudioContext, RTCPeerConnection, speechSynthesis. Turnstile fingerprints these and posts the result; a missing WebGL is a strong bot signal.
- linkedin: Cloudflare "Attention Required" (hard block), flipped to a real page (score 5) in the second run: IP/rate dependent.

## Single causes seen in the logs
- google search: `solveSimpleChallenge is not defined` (JS interstitial; not analysed, needs the page).
- nzz: blob `<script async>` fails in `execute-raw-script`.
- tiktok: `new Request(req)` on a used request ("Feature access control initialization").
- microsoft: `setAttribute`/`scrollWidth`/`querySelectorAllDeep` of null/undefined in web components; the sandbox only gets the block page, so no repro.
- canva: no WebGL context.
- ebay "Error Page", kicker (blank), gamepass (CERT_AUTHORITY_INVALID for gamepass.com on Windows, redirect to xbox.com in Chromium).
- Second run adds sites that flipped to 100 with identical code (zalando, aldi, thomann, etsy, mayoclinic, olympics, magnific): per-IP throttling, not engine regressions.
