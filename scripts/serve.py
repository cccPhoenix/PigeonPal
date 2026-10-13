"""Local dev server for web/: like `python3 -m http.server`, but never cached."""
import functools, http.server, os, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 4174))
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
handler = functools.partial(NoCache, directory=root)
with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
    print(f"PigeonPal: http://127.0.0.1:{port}", flush=True)
    httpd.serve_forever()
