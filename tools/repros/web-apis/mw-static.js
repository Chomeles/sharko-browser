import { dep, ident } from './mw-dep.js';
const late = await import('./mw-dep.js');
let scriptsErr = 'no throw';
try { importScripts('mw-dep.js'); } catch (e) { scriptsErr = e.name; }
self.postMessage({ dep, sameModule: late.dep === dep, importScripts: ident(), scriptsErr, name: self.name, top: typeof this });
