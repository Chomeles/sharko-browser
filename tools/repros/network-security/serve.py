#!/usr/bin/env python3
"""Local test server of the network-security repro pages: three origins, every request is logged.

  python3 tools/repros/network-security/serve.py [BASE_PORT=18941]

  A http://localhost:BASE       pages live here (static files of this directory)
  B http://localhost:BASE+1     same site as A, other origin
  C http://127.0.0.1:BASE+2     cross-site to A and B

Endpoints on every origin: /log (JSON list of the requests so far; ?clear=1 empties it), /json (no CORS headers),
/cors?acao=none|star|reflect|null&acac=1 (JSON echo of the request), /cookie-set?name=n&attrs=SameSite=Strict,
/cookie-echo (JSON {cookie}, ACAO reflect + ACAC), /ref (JSON {referer}, ACAO reflect), /s.js /s.css /i.png (tiny assets),
/local-files (JSON: file: URLs of a JS and a text file this server wrote, for file-scheme.html).
OPTIONS answers 204 with Allow-* for anything and is logged.
"""
import http.server, json, os, pathlib, sys, tempfile, threading, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = int(sys.argv[1]) if len(sys.argv) > 1 else 18941
LOG, LOCK = [], threading.Lock()
TMP = tempfile.mkdtemp(prefix='netsec-')
open(os.path.join(TMP, 'local.js'), 'w').write('window.__fileScript = "executed";\n')
open(os.path.join(TMP, 'local.txt'), 'w').write('secret-local-file-content\n')
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                    '1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082')


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def translate_path(self, path):
        return os.path.join(HERE, urllib.parse.urlparse(path).path.lstrip('/'))

    def send(self, code, body=b'', ctype='application/json', extra=()):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def cors(self, q):
        origin = self.headers.get('Origin')
        mode = (q.get('acao') or ['reflect'])[0]
        h = []
        if mode == 'star':
            h.append(('Access-Control-Allow-Origin', '*'))
        elif mode == 'reflect' and origin:
            h.append(('Access-Control-Allow-Origin', origin))
        elif mode == 'null':
            h.append(('Access-Control-Allow-Origin', 'null'))
        if q.get('acac'):
            h.append(('Access-Control-Allow-Credentials', 'true'))
        return h

    def handle_any(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        entry = {'port': self.server.server_address[1], 'method': self.command, 'path': self.path,
                 'headers': {k.lower(): v for k, v in self.headers.items()}}
        length = int(self.headers.get('Content-Length') or 0)
        if length:
            self.rfile.read(length)
        if u.path == '/log':
            with LOCK:
                out = json.dumps(LOG).encode()
                if q.get('clear'):
                    LOG.clear()
            return self.send(200, out, extra=[('Access-Control-Allow-Origin', '*')])
        with LOCK:
            LOG.append(entry)
        if self.command == 'OPTIONS':
            return self.send(204, b'', extra=self.cors({'acao': ['reflect'], 'acac': ['1']}) + [
                ('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE'), ('Access-Control-Allow-Headers', '*'), ('Access-Control-Max-Age', '5')])
        if u.path == '/json':
            return self.send(200, b'{"a":1}')
        if u.path == '/cors':
            body = json.dumps({'method': self.command, 'origin': entry['headers'].get('origin'), 'headers': entry['headers']}).encode()
            return self.send(200, body, extra=self.cors(q) + [('X-Secret', 'exposed?')])
        if u.path == '/cookie-set':
            cookie = '%s=1; Path=/; %s' % (q['name'][0], (q.get('attrs') or [''])[0])
            return self.send(200, b'{}', extra=self.cors({'acao': ['reflect'], 'acac': ['1']}) + [('Set-Cookie', cookie)])
        if u.path == '/cookie-echo':
            return self.send(200, json.dumps({'cookie': self.headers.get('Cookie', '')}).encode(), extra=self.cors({'acao': ['reflect'], 'acac': ['1']}))
        if u.path == '/ref':
            return self.send(200, json.dumps({'referer': self.headers.get('Referer')}).encode(), extra=self.cors({'acao': ['reflect']}))
        if u.path == '/s.js':
            return self.send(200, b'window.__s = 1;\n', 'text/javascript', extra=[('Access-Control-Allow-Origin', '*')])
        if u.path == '/s.css':
            return self.send(200, b'body{}\n', 'text/css')
        if u.path == '/i.png':
            return self.send(200, PNG, 'image/png')
        if u.path == '/local-files':
            uri = lambda n: pathlib.Path(os.path.join(TMP, n)).as_uri()
            return self.send(200, json.dumps({'js': uri('local.js'), 'txt': uri('local.txt')}).encode(), extra=[('Access-Control-Allow-Origin', '*')])
        if self.command in ('GET', 'HEAD'):
            return http.server.SimpleHTTPRequestHandler.do_GET(self)
        return self.send(404, b'{}')

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_OPTIONS = handle_any


if __name__ == '__main__':
    servers = [(BASE, 'localhost'), (BASE + 1, 'localhost'), (BASE + 2, '127.0.0.1')]
    for port, host in servers:
        s = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print('serving', ', '.join('http://%s:%d' % (h, p) for p, h in servers), flush=True)
    threading.Event().wait()
