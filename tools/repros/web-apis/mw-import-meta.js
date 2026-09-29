// Module worker as bundlers emit it: no top-level import/export, uses import.meta.
self.postMessage({ meta: typeof import.meta.url, base: new URL('.', import.meta.url).pathname });
