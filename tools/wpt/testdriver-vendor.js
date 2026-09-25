/* Sharko's testdriver backend for web-platform-tests.
 *
 * tools/wpt/run.js copies this file over `resources/testdriver-vendor.js` in the WPT
 * checkout. A test's `test_driver.click(el)` / `send_keys` / `Actions` request is sent
 * to the headless driver as a console line (`__sharko_testdriver {...}`); the driver
 * performs the input natively (real hit-testing, focus, key handling) and resolves the
 * request by calling `__sharko_testdriver_done(id, error)` in the page.
 */
(function () {
  if (typeof window === 'undefined' || !window.test_driver_internal) return;
  var seq = 0;
  var pending = new Map();
  window.__sharko_testdriver_done = function (id, err) {
    var p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (err) p.reject(new Error(err)); else p.resolve();
  };
  function request(cmd, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      console.log('__sharko_testdriver ' + JSON.stringify({ id: id, cmd: cmd, args: args }));
    });
  }
  var pointer = { x: 0, y: 0 };
  function originPoint(origin, x, y) {
    if (origin === undefined || origin === null || origin === 'viewport') return [x, y];
    if (origin === 'pointer') return [pointer.x + x, pointer.y + y];
    if (typeof origin === 'object' && typeof origin.getBoundingClientRect === 'function') {
      var r = origin.getBoundingClientRect();
      return [r.x + r.width / 2 + x, r.y + r.height / 2 + y];
    }
    return [x, y];
  }
  var TDI = window.test_driver_internal;
  TDI.in_automation = true;
  TDI.click = function (element, coords) {
    pointer = { x: coords.x, y: coords.y };
    return request('click', { x: coords.x, y: coords.y });
  };
  TDI.send_keys = function (element, keys) {
    element.focus();
    return request('keys', { keys: String(keys) });
  };
  // WebDriver action sequences: sources tick in lockstep; flatten them into one list of
  // steps with viewport coordinates (element origins are resolved here).
  TDI.action_sequence = function (sources) {
    var steps = [];
    var ticks = 0;
    for (var i = 0; i < sources.length; i++) ticks = Math.max(ticks, sources[i].actions.length);
    for (var t = 0; t < ticks; t++) {
      var pause = 0;
      for (var s = 0; s < sources.length; s++) {
        var a = sources[s].actions[t];
        if (!a) continue;
        var p;
        switch (a.type) {
          case 'pause': pause = Math.max(pause, a.duration || 0); break;
          case 'pointerMove':
            p = originPoint(a.origin, a.x, a.y);
            pointer = { x: p[0], y: p[1] };
            steps.push({ t: 'move', x: p[0], y: p[1] });
            break;
          case 'pointerDown': steps.push({ t: 'down', button: a.button || 0 }); break;
          case 'pointerUp': steps.push({ t: 'up', button: a.button || 0 }); break;
          case 'keyDown': steps.push({ t: 'keydown', key: a.value }); break;
          case 'keyUp': steps.push({ t: 'keyup', key: a.value }); break;
          case 'scroll':
            p = originPoint(a.origin, a.x, a.y);
            steps.push({ t: 'wheel', x: p[0], y: p[1], dx: a.deltaX || 0, dy: a.deltaY || 0 });
            break;
        }
      }
      if (pause) steps.push({ t: 'pause', ms: pause });
    }
    return request('actions', steps);
  };
  TDI.set_permission = function () { return Promise.resolve(); };
  TDI.delete_all_cookies = function () {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i].split('=')[0].trim();
      if (name) document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
    }
    return Promise.resolve();
  };
  TDI.get_all_cookies = function () {
    var out = [];
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i].trim();
      if (!c) continue;
      var eq = c.indexOf('=');
      out.push({ name: c.slice(0, eq), value: c.slice(eq + 1) });
    }
    return Promise.resolve(out);
  };
  TDI.get_named_cookie = function (name) {
    return TDI.get_all_cookies().then(function (all) {
      for (var i = 0; i < all.length; i++) if (all[i].name === name) return all[i];
      return null;
    });
  };
})();
