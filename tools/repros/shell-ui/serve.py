#!/usr/bin/env python3
# Tiny server for shell-ui repros: python3 tools/repros/shell-ui/serve.py  (port 8765)
import http.server, os
class H(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/dl/attachment'):
            body = b'hello download\n' * 1000
            self.send_response(200); self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Disposition', 'attachment; filename="hello world.txt"')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith('/dl/binary'):
            body = os.urandom(5_000_000)
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
        if self.path.startswith('/dl/slow'):
            import time
            self.send_response(200); self.send_header('Content-Type', 'application/zip'); self.end_headers()
            for _ in range(20):
                self.wfile.write(b'x' * 100000); self.wfile.flush(); time.sleep(0.5)
            return
        super().do_GET()
os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(('127.0.0.1', 8765), H).serve_forever()
