'use strict';
process.on('uncaughtException', (e) => { try { require('fs').appendFileSync(process.env.LOGDIR + '/traffic.log', 'UNCAUGHT ' + e.message + '\n'); } catch (x) {} });
// Logging/rewriting MITM proxy between Sharko and the sandbox proxy.
// env: PRELUDE=file (JS injected into HTML docs), LOGDIR=dir
const http2 = require('http2'), http = require('http'), https = require('https'), tls = require('tls'), net = require('net'), fs = require('fs'), zlib = require('zlib'), cp = require('child_process'), path = require('path');
const LOGDIR = process.env.LOGDIR || '.'; fs.mkdirSync(LOGDIR, { recursive: true });
const PATCH = process.env.PATCH ? require(process.env.PATCH) : null;
const PRELUDE = process.env.PRELUDE ? fs.readFileSync(process.env.PRELUDE, 'utf8') : '';
const upstream = new URL(process.env.UPSTREAM_PROXY || 'http://127.0.0.1:37601');
const CA = tls.rootCertificates.concat([fs.readFileSync('/root/.ccr/ca-bundle.crt', 'utf8')]);
const certs = {};
function certFor(host) {
  if (certs[host]) return certs[host];
  const d = path.join(__dirname, 'certs'); fs.mkdirSync(d, { recursive: true });
  const base = path.join(d, host.replace(/[^A-Za-z0-9.-]/g, '_'));
  if (!fs.existsSync(base + '.crt')) {
    cp.execSync(`openssl req -newkey rsa:2048 -nodes -keyout ${base}.key -subj "/CN=${host}" -out ${base}.csr 2>/dev/null && printf "subjectAltName=DNS:${host}\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth" > ${base}.ext && openssl x509 -req -in ${base}.csr -CA ${__dirname}/ca.pem -CAkey ${__dirname}/ca.key -CAcreateserial -out ${base}.crt -days 30 -extfile ${base}.ext 2>/dev/null`);
  }
  return (certs[host] = tls.createSecureContext({ key: fs.readFileSync(base + '.key'), cert: fs.readFileSync(base + '.crt') }));
}
let seq = 0;
const log = fs.createWriteStream(path.join(LOGDIR, 'traffic.log'), { flags: 'a' });
function tunnel(host, port, cb) {
  const r = http.request({ host: upstream.hostname, port: upstream.port, method: 'CONNECT', path: `${host}:${port}` });
  r.on('connect', (res, sock) => { if (res.statusCode !== 200) return cb(new Error('CONNECT ' + res.statusCode)); const t = tls.connect({ socket: sock, servername: host, ca: CA, ALPNProtocols: ['h2', 'http/1.1'] }); t.once('secureConnect', () => cb(null, t)); t.once('error', cb); });
  r.on('error', cb); r.end();
}
function handle(host) {
  return (req, res) => {
    const id = ++seq; const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = `https://${host}${req.url}`;
      const fname = path.join(LOGDIR, `${String(id).padStart(3, '0')}`);
      log.write(`#${id} ${req.method} ${url.slice(0, 200)} reqbody=${body.length}\n`);
      if (req.method === 'POST') fs.writeFileSync(fname + '.req', body);
      fs.writeFileSync(fname + '.reqhdr', JSON.stringify(req.headers, null, 1));
      tunnel(host, 443, (err, sock) => {
        if (err) { log.write(`#${id} tunnel error ${err.message}\n`); res.writeHead(502); return res.end(); }
        const hdrs = {};
        for (const [k, v] of Object.entries(req.headers)) { if (/^(connection|keep-alive|transfer-encoding|upgrade|proxy-connection|host)$/i.test(k)) continue; hdrs[k] = v; }
        const finish = (status, h, rb) => {
          h = Object.assign({}, h); for (const k of Object.keys(h)) if (k.startsWith(':')) delete h[k];
          const enc = (h['content-encoding'] || '').toLowerCase();
          try { if (enc === 'gzip') rb = zlib.gunzipSync(rb); else if (enc === 'br') rb = zlib.brotliDecompressSync(rb); else if (enc === 'deflate') rb = zlib.inflateSync(rb); if (enc) delete h['content-encoding']; } catch (e) { log.write(`#${id} decode error ${e.message}\n`); }
          const ct = (h['content-type'] || '');
          let out = rb;
          if (PATCH && /challenges\.cloudflare\.com|leo\.org/.test(host) && /html|javascript/.test(ct)) { const r = PATCH(host, req.url, ct, rb.toString('utf8')); if (r.n || r.m) { rb = Buffer.from(r.text); out = rb; log.write(`#${id} vm-patched gets=${r.n} calls=${r.m}\n`); } }
          if (PRELUDE && /text\/html/.test(ct)) {
            let s = out.toString('utf8');
            const m = s.match(/nonce-([A-Za-z0-9+\/=_-]+)/) || (h['content-security-policy'] || '').match(/nonce-([A-Za-z0-9+\/=_-]+)/);
            const inj = `<script${m ? ` nonce="${m[1]}"` : ''}>${PRELUDE.replace(/__HOST__/g, host)}</script>`;
            if (/<head[^>]*>/i.test(s)) s = s.replace(/<head[^>]*>/i, (x) => x + inj); else s = inj + s;
            out = Buffer.from(s); log.write(`#${id} injected prelude (${inj.length}b, nonce=${m ? m[1] : 'none'})\n`);
          }
          fs.writeFileSync(fname + '.resp', rb);
          log.write(`#${id} -> ${status} ${ct} ${rb.length}b\n`);
          delete h['transfer-encoding']; h['content-length'] = String(out.length);
          try { res.writeHead(status, h); res.end(out); } catch (e) {}
        };
        if (sock.alpnProtocol === 'h2') {
          const c = http2.connect(`https://${host}`, { createConnection: () => sock });
          c.on('error', (e) => { log.write(`#${id} h2 error ${e.message}\n`); try { res.writeHead(502); res.end(); } catch (x) {} });
          const h2h = Object.assign({ ':method': req.method, ':authority': req.headers.host || host, ':scheme': 'https', ':path': req.url }, hdrs);
          const st = c.request(h2h, { endStream: false }); const rc = []; let rh;
          st.on('response', (h) => { rh = h; }); st.on('data', (d) => rc.push(d));
          st.on('end', () => { finish(rh[':status'], rh, Buffer.concat(rc)); c.close(); });
          st.on('error', (e) => { log.write(`#${id} h2 stream error ${e.message}\n`); try { res.writeHead(502); res.end(); } catch (x) {} });
          st.end(body);
        } else {
          const up = https.request({ createConnection: () => sock, host, method: req.method, path: req.url, headers: Object.assign({ host: req.headers.host || host }, hdrs), rejectUnauthorized: false }, (ur) => {
            const rc = []; ur.on('data', (c) => rc.push(c)); ur.on('end', () => finish(ur.statusCode, ur.headers, Buffer.concat(rc)));
          });
          up.on('error', (e) => { log.write(`#${id} upstream error ${e.message}\n`); try { res.writeHead(502); res.end(); } catch (x) {} });
          up.end(body);
        }
      });
    });
  };
}
const server = http.createServer();
server.on('connect', (req, clientSock, head) => {
  const [host, port] = req.url.split(':');
  clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  const tsock = new tls.TLSSocket(clientSock, { isServer: true, SNICallback: (sn, cb) => cb(null, certFor(sn || host)), ALPNProtocols: ['http/1.1'] });
  tsock.on('error', (e) => log.write(`tls error ${host}: ${e.message}\n`));
  const s = http.createServer(handle(host)); s.emit('connection', tsock);
});
server.on('request', (req, res) => { res.writeHead(400); res.end(); });
server.listen(parseInt(process.env.PORT || '38111', 10), '127.0.0.1', () => console.log('listening'));
