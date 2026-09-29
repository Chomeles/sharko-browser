var n = 0;
onconnect = function (e) { var p = e.ports[0]; n++; p.postMessage('connections:' + n); p.onmessage = function (m) { p.postMessage('echo:' + m.data); }; };
