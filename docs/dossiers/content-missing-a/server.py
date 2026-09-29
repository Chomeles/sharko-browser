#!/usr/bin/env python3
"""Tiny repro server: /redirect.css -> 302 -> /real.css ; /direct.css -> 200.
Also /jsession/style.css;jsessionid=ABC -> 302 -> /real.css (dwd.de shape).
Logs every request to stderr."""
import http.server, sys, os

ROOT = os.path.dirname(os.path.abspath(__file__))
CSS = b"body{background:rgb(0,128,0)} h1{color:rgb(255,0,0)} .redirected{color:rgb(1,2,3)}"

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write("REQ %s %s | UA=%s | Accept=%s\n" % (self.command, self.path, self.headers.get('User-Agent','')[:30], self.headers.get('Accept','')))
    def do_GET(self):
        p = self.path
        if p.startswith('/redirect.css') or p.startswith('/jsession/'):
            self.send_response(302)
            self.send_header('Location', '/real.css')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p.startswith('/redirect301.css'):
            self.send_response(301)
            self.send_header('Location', '/real.css')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p.startswith('/real.css') or p.startswith('/direct.css'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/css')
            self.send_header('Content-Length', str(len(CSS)))
            self.end_headers()
            self.wfile.write(CSS)
            return
        if p.startswith('/redirect.js'):
            self.send_response(302)
            self.send_header('Location', '/real.js')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p.startswith('/real.js'):
            body = b"window.__redirectedJsRan = true;"
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p.startswith('/redirect.png'):
            self.send_response(302)
            self.send_header('Location', '/real.png')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if p.startswith('/real.png'):
            import base64
            body = base64.b64decode(b"iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8AAQTAGDvYA/3sO+LBq1lYAAAAASUVORK5CYII=")
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # static files
        f = os.path.join(ROOT, p.lstrip('/').split('?')[0])
        if os.path.isfile(f):
            body = open(f, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if f.endswith('.html') else 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404); self.send_header('Content-Length','0'); self.end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
