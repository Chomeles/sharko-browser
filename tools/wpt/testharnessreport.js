/* Sharko's vendor hook for web-platform-tests.
 *
 * tools/wpt/run.js copies this file over `resources/testharnessreport.js` in the
 * WPT checkout. When a testharness.js test file finishes, the results are published
 * on `window.__wpt_done`, which the headless runner polls for with
 * `--wait-for="window.__wpt_done"` and reads back with `--eval`.
 */
/* global add_completion_callback */
(function () {
  var STATUS = ['PASS', 'FAIL', 'TIMEOUT', 'NOTRUN', 'PRECONDITION_FAILED'];
  var HARNESS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED'];
  function text(v) {
    if (v === undefined || v === null) return null;
    var s = String(v);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  }
  add_completion_callback(function (tests, harnessStatus) {
    var out = {
      status: HARNESS[harnessStatus.status] || String(harnessStatus.status),
      message: text(harnessStatus.message),
      subtests: [],
    };
    for (var i = 0; i < tests.length; i++) {
      out.subtests.push({
        name: String(tests[i].name),
        status: STATUS[tests[i].status] || String(tests[i].status),
        message: text(tests[i].message),
      });
    }
    window.__wpt_done = out;
  });
})();
