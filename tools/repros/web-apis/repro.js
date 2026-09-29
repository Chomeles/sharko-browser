// Shared helpers of the web-apis repro pages (contract: window.__repro = {issue, expected, actual, pass}; expected = Chromium's values).
//   c(key, function (done) { ... done(value) })   one async case, 3 s budget (value 'timeout' otherwise), results in R
//   finish(issue, expected)                        after load and every case: sets window.__repro
window.__repro = null;
window.R = {};
(function () {
  var pend = [];
  window.__canon = function (v) { return JSON.stringify(v, function (k, x) { if (x && typeof x === 'object' && !Array.isArray(x)) { var o = {}; Object.keys(x).sort().forEach(function (y) { o[y] = x[y]; }); return o; } return x; }); };
  window.c = function (k, f, ms) { pend.push(new Promise(function (res) {
    var t = setTimeout(function () { R[k] = 'timeout'; res(); }, ms || 3000);
    try { f(function (v) { clearTimeout(t); R[k] = v; res(); }); } catch (e) { clearTimeout(t); R[k] = 'threw ' + (e && e.name); res(); } })); };
  window.finish = function (issue, expected) { Promise.all(pend).then(function () { window.__repro = { issue: 'web-apis/' + issue, expected: expected, actual: R, pass: __canon(expected) === __canon(R) }; }); };
  window.blobURL = function (src, type) { return URL.createObjectURL(new Blob([src], { type: type || 'text/javascript' })); };
})();
