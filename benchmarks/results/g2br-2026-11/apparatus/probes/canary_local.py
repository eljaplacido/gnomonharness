import http.server, sys
LOG = sys.argv[1]; PORT = int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def _h(self):
        open(LOG, "a").write(f"{self.command} {self.path}\n")
        b = b"CANARY-REACHED\n"; self.send_response(200); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    do_GET = do_POST = do_HEAD = do_PUT = _h
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
