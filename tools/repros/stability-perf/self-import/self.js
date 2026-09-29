export const x = 42;
import(import.meta.url).then((ns) => log('self ok x=' + ns.x), (e) => log('self err ' + e));
