#!/usr/bin/env python3
"""Local test server for the Balda web build.

    ./serve.py [port]          # default 8000

Two things `python3 -m http.server` gets wrong for this job:

  * It never compresses, so words.txt goes over the wire as 1.7 MB instead of
    442 KB — four times the real production payload.
  * It answers conditional requests with 304, so Safari happily keeps serving
    a stale copy of main.js after you've edited it. Every response here is
    `Cache-Control: no-store`, which makes what you see on the phone always
    the file that's on disk.

This is a development server. Firebase Hosting handles compression and cache
headers itself in production — see firebase.json.
"""

import gzip
import io
import os
import re
import socket
import sys
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

COMPRESSIBLE = {'.html', '.js', '.css', '.txt', '.json', '.webmanifest', '.svg'}

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def handle(self):
        # Safari drops idle keep-alive sockets, which otherwise prints a
        # multi-line traceback per closed connection and buries the request log
        # that actually tells you what the phone asked for.
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            pass

    def do_GET(self):
        self._serve(head_only=False)

    def do_HEAD(self):
        self._serve(head_only=True)

    def _serve(self, head_only):
        # Strip the per-launch version segment: /b99799/js/main.js -> /js/main.js
        #
        # Versioning the *path* rather than adding a ?query is what makes this
        # work. A query string only busts the URL it's attached to, so the
        # document reloaded while every stylesheet, module and data file came
        # from cache under its unchanged URL. With the document itself at
        # /b99799/, every relative reference — including the `import` specifiers
        # inside the modules and the fetch() of words.txt — resolves under that
        # prefix too, so the whole app reloads as one unit.
        stripped = re.sub(r'^/b\d+(?=/|$)', '', self.path)
        self.path = stripped or '/'

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')
        if not os.path.isfile(path):
            self.send_error(404, 'Not found')
            return

        try:
            with open(path, 'rb') as fh:
                body = fh.read()
        except OSError:
            self.send_error(404, 'Not found')
            return

        ext = os.path.splitext(path)[1].lower()
        raw_len = len(body)
        encoding = None

        if (ext in COMPRESSIBLE
                and 'gzip' in self.headers.get('Accept-Encoding', '')
                and raw_len > 1024):
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=6) as gz:
                gz.write(body)
            body = buf.getvalue()
            encoding = 'gzip'

        self.send_response(200)
        self.send_header('Content-Type', TYPES.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(body)))
        if encoding:
            self.send_header('Content-Encoding', encoding)
            self.send_header('Vary', 'Accept-Encoding')
        # The whole point: never let the phone reuse a previous build.
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.end_headers()

        if not head_only:
            self.wfile.write(body)

        if encoding:
            self.log_message('"%s" %d bytes -> %d gzipped', self.path, raw_len, len(body))

    def log_message(self, fmt, *args):
        sys.stderr.write('  %s\n' % (fmt % args))


def lan_ip():
    """Local address without sending anything."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.0.2.1', 1))      # TEST-NET-1, never routed
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def copy_to_clipboard(text):
    """Put the phone URL on the Mac clipboard. With Universal Clipboard on, it
    can then be pasted straight into Safari's address bar on the iPhone."""
    try:
        import subprocess
        subprocess.run(['pbcopy'], input=text.encode(), check=True, timeout=5)
        return True
    except Exception:
        return False


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public'))

    ip = lan_ip()
    # A fresh query string each launch. Safari caches by full URL, so this
    # guarantees the phone re-fetches index.html even if it already has a copy
    # from before `no-store` was in place.
    token = int(time.time()) % 100000
    phone_url = f'http://{ip}:{port}/b{token}/' if ip else None

    print()
    print('  ' + '=' * 52)
    if phone_url:
        print(f'   On the iPhone:  {phone_url}')
    else:
        print('   No Wi-Fi address found — is Wi-Fi on?')
    print(f'   On this Mac:    http://localhost:{port}/b{token}/')
    print('  ' + '=' * 52)
    print()

    if phone_url and copy_to_clipboard(phone_url):
        print('  That address is on your clipboard. If Handoff is on, long-press')
        print("  Safari's address bar on the iPhone and choose Paste.")
        print()

    print('  Compression on, caching off — the phone always gets the current build.')
    print('  Leave this window open while you play. Press Ctrl-C to stop.')
    print()

    try:
        # Threading is not optional here. The page pulls index.html, the CSS,
        # five JS modules and three text files, and Safari fetches them over
        # several parallel connections. A single-threaded server with HTTP/1.1
        # keep-alive serves the first and leaves the rest waiting on a
        # connection that never closes — the page hangs on a white screen.
        server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
        server.daemon_threads = True
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  Stopped.\n')
    except OSError as exc:
        print(f'\n  Could not start on port {port}: {exc}')
        print(f'  Something else may be using it — try: ./serve.py {port + 1}\n')


if __name__ == '__main__':
    main()
