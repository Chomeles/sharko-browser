// Top-level dynamic import (what every Vite/Rollup entry chunk does for lazy chunks).
export const x = 1;
import('./b.js').then((ns) => { window.__results && window.__results.push('a: b loaded y=' + ns.y); });
