# Serves Resources/ like the daemon serves /app-files: a request from a page
# on another origin is refused (src/daemon/browser-origin.ts).
import http.server, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        if self.headers.get("Origin") == "null" or site in ("cross-site", "same-site"):
            self.send_error(403)
            return
        super().do_GET()

    def log_message(self, *args):
        pass

handler = lambda *a, **k: Handler(*a, directory=sys.argv[2], **k)
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), handler).serve_forever()
