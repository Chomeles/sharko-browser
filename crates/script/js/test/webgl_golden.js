'use strict';
// Records Chromium's answers for the cases in webgl_cases.js into webgl_golden.json:
//   NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/webgl_golden.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cases = Object.assign({}, require('./webgl_cases'), require('./offscreen_cases'));
const prelude = require('./webgl_prelude');
(async () => {
  const b = await chromium.launch({ channel: 'chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage();
  const out = {};
  for (const [name, fn] of Object.entries(cases)) {
    try { out[name] = await p.evaluate(`(async () => { ${prelude}\n return (${fn.toString().replace(/^(async\s+)?(\w+)\s*\(/, (m, a) => (a || '') + 'function (')})(); })()`); } catch (e) { out[name] = { error: String(e.message).split('\n')[0] }; }
  }
  fs.writeFileSync(path.join(__dirname, 'webgl_golden.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(Object.entries(out).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 150)}`).join('\n'));
  await b.close();
})();
