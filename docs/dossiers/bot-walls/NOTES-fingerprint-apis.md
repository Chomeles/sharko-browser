# Fingerprint APIs lane: findings

## google.com search: `solveSimpleChallenge is not defined` is Google's own block page
Reproduced with the headless binary and with Chromium (Playwright, same sandbox proxy): `/search?q=...` answers with the JS interstitial, which redirects to
`/sorry/index?continue=...` (HTTP 429, "Our systems have detected unusual traffic from your computer network").
Its markup is `<body onload="...if(solveSimpleChallenge) {solveSimpleChallenge(0,0);}">`; no script on that page defines the function (the captcha variant of
the page does), so `if (solveSimpleChallenge)` throws a ReferenceError in every browser: Chromium logs exactly the same
`Uncaught ReferenceError: solveSimpleChallenge is not defined`. Not an engine defect; the cause is the flagged datacenter IP of the sandbox/CI
(rate limited), so the score of the site depends on the egress IP, not on Sharko. Nothing to fix.

## tiktok: `new Request(req)` after `req.clone()`
`Request.clone()` built its copy with `new Request(this, {})`, whose body transfer (Fetch §5.4) marked the original as used, so a later
`new Request(req)`/`fetch(req)` threw "already been used". Fixed in `40_webapi.js` (clone keeps the original usable); Chromium leaves it unused.

## nzz.ch: `<script async src=blob:...>`
Script loads went through the network stack, which cannot resolve `blob:` URLs: every blob script fired `error`. Fixed in
`L.startNativeFetch` (answers `blob:` from the page's object URL registry).
