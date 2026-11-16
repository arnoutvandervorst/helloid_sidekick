#!/usr/bin/env python3
"""Static file server for local use: no caching, so an edit is one refresh away.

Serves only what the app itself fetches. The folder also holds helloid-config.json
(every tenant's secrets) and collector output (vaults, directories, SA configs), and
any local process or DNS-rebinding page could otherwise read them from this port."""
import sys, http.server, socketserver, posixpath, urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123

# Folders the app loads from, and single files it fetches or offers for download.
DIRS = ('css/', 'js/', 'assets/', 'demo/', 'published/')
FILES = {
    '', 'index.html', 'docs/ENTRA-CONSENT.md',
    'ReconciliationReport.csv', 'sample-recon.csv',          # app.js SAMPLE_FILES
    'collect-ad.ps1', 'collect-entra.ps1', 'restore-ad.ps1', 'restore-entra.ps1',
    'helloid-audit.py', 'helloid-audit.ps1', 'helloid-export.py', 'helloid-export.ps1',
    'HelloIDCreds.ps1', 'helloid_creds.py', 'helloid-sa-export.py',
}
HOSTS = {'localhost', '127.0.0.1'}


def allowed(url_path):
    p = posixpath.normpath(urllib.parse.unquote(urllib.parse.urlsplit(url_path).path)).lstrip('/')
    if p == '.':
        p = ''
    if '..' in p.split('/'):
        return False
    return p in FILES or (p.startswith(DIRS) and not p.endswith('/'))


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        if host not in HOSTS:
            self.send_error(403, 'Host not allowed')
            return None
        if not allowed(self.path):
            self.send_error(404)
            return None
        return super().send_head()

    def do_POST(self):
        # js/usage.js beacons here; nginx answers 204 in production, so do the same and record nothing
        host = (self.headers.get('Host') or '').rsplit(':', 1)[0]
        if host not in HOSTS:
            self.send_error(403, 'Host not allowed')
        elif urllib.parse.urlsplit(self.path).path == '/u':
            self.send_response(204)
            self.end_headers()
        else:
            self.send_error(501)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    assert allowed('/') and allowed('/index.html') and allowed('/js/app.js?v=1') and allowed('/demo/vault.json')
    assert not allowed('/helloid-config.json') and not allowed('/sa-demo/x.json') and not allowed('/js/../helloid-config.json')
    assert not allowed('/vault-demo.json') and not allowed('/directory-big.json') and not allowed('/js/')
    with socketserver.TCPServer(('127.0.0.1', PORT), Handler) as httpd:
        print('HelloID Sidekick  ->  http://localhost:%d' % PORT)
        httpd.serve_forever()
