#!/usr/bin/env python3
"""Download click counter for somov.org. Standard library only.

POST /api/count?file=<iso name>&kind=download|torrent|magnet  adds one click
GET  /api/stats  returns the counts to the owner's IP, and {"owner": false} to everyone else

Runs behind nginx, which sets X-Real-IP. Visitor IPs are never stored on disk.
"""
import json
import os
import re
import sqlite3
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

FILES_DIR = os.environ.get('FILES_DIR', '/var/www/html')
DB_PATH = os.environ.get('DB_PATH', '/var/lib/somov-counter/counts.db')
PORT = int(os.environ.get('PORT', '8095'))
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', 'https://somov.org')
OWNER_IPS = {ip.strip() for ip in os.environ.get('OWNER_IPS', '').split(',') if ip.strip()}

KINDS = {'download', 'torrent', 'magnet'}
FILE_RE = re.compile(r'^[A-Za-z0-9._()-]{1,200}\.iso$', re.IGNORECASE)
RATE_LIMIT = 30  # clicks per IP per minute, the rest is ignored

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute('CREATE TABLE IF NOT EXISTS counts (file TEXT, kind TEXT, n INTEGER NOT NULL, PRIMARY KEY (file, kind))')
db.commit()
lock = threading.Lock()
recent = defaultdict(deque)


def rate_limited(ip):
    now = time.monotonic()
    with lock:
        if len(recent) > 10000:
            recent.clear()
        clicks = recent[ip]
        while clicks and now - clicks[0] > 60:
            clicks.popleft()
        if len(clicks) >= RATE_LIMIT:
            return True
        clicks.append(now)
        return False


def add_click(file, kind):
    with lock:
        db.execute('INSERT INTO counts VALUES (?, ?, 1) ON CONFLICT (file, kind) DO UPDATE SET n = n + 1', (file, kind))
        db.commit()


def read_counts():
    counts = {}
    with lock:
        for file, kind, n in db.execute('SELECT file, kind, n FROM counts'):
            counts.setdefault(file, {})[kind] = n
    return counts


class Handler(BaseHTTPRequestHandler):
    server_version = 'somov-counter'
    sys_version = ''

    def log_message(self, *args):
        pass

    def respond(self, status, body=None):
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        self.send_header('Cache-Control', 'no-store')
        if body is None:
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != '/api/count':
            return self.respond(404)
        query = parse_qs(url.query)
        file = query.get('file', [''])[0]
        kind = query.get('kind', [''])[0]
        if kind not in KINDS or not FILE_RE.match(file) or not os.path.isfile(os.path.join(FILES_DIR, file)):
            return self.respond(400)
        ip = self.headers.get('X-Real-IP', '')
        if ip and ip not in OWNER_IPS and not rate_limited(ip):
            add_click(file, kind)
        return self.respond(204)

    def do_GET(self):
        if urlsplit(self.path).path != '/api/stats':
            return self.respond(404)
        if self.headers.get('X-Real-IP', '') in OWNER_IPS:
            return self.respond(200, {'owner': True, 'counts': read_counts()})
        return self.respond(200, {'owner': False})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
