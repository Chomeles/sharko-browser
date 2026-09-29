# Diagnosis dossiers

One folder per cause cluster found by `tools/sitediff` (Sharko vs Chromium): `diagnosis.json` holds the root causes with evidence, affected sites and the proposed fix; small repro pages sit beside it. Paths inside the JSON that point to a scratch directory are historical: use the files in the same folder instead.

Re-create evidence with `node tools/sitediff/run.js <url>` (writes `tools/sitediff/out/<slug>/`) and compare with Chromium, which is the behavioural oracle.
