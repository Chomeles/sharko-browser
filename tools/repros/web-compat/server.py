import http.server, sys, json, os
LOG='/tmp/web-compat-req.log'
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        with open(LOG,'a') as f:
            f.write(json.dumps({'path':self.path,'headers':dict((k.lower(),v) for k,v in self.headers.items())})+'\n')
        if self.path.startswith('/json'):
            body=b'{"a":1}'
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()
os.chdir(os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(('127.0.0.1',int(sys.argv[1])),H).serve_forever()
