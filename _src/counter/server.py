#!/usr/bin/env python3
"""Download counter for somov.org. Standard library only.

POST /internal/hit   nginx reports every GET of an .iso or .torrent file (through `mirror`),
                     whatever page or chat the link was opened from; not reachable from outside
POST /api/count?file=<iso name>&kind=magnet   the site reports magnet clicks, which never reach the server
GET  /api/stats      returns the counts to the owner's IP, and {"owner": false} to everyone else

Each IP is counted once per 24 hours, across all files and kinds.
Runs behind nginx, which sets X-Real-IP. Visitor IPs are kept in memory only, never on disk,
so a restart of the service forgets who has already been counted.
"""
import json
import os
import re
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

FILES_DIR = os.environ.get('FILES_DIR', '/var/www/html')
DB_PATH = os.environ.get('DB_PATH', '/var/lib/somov-counter/counts.db')
PORT = int(os.environ.get('PORT', '8095'))
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', 'https://somov.org')
OWNER_IPS = {ip.strip() for ip in os.environ.get('OWNER_IPS', '').split(',') if ip.strip()}

KINDS = {'download', 'torrent', 'magnet'}
FILE_RE = re.compile(r'^[A-Za-z0-9._()-]{1,200}\.iso$', re.IGNORECASE)
CLICK_WINDOW = int(os.environ.get('CLICK_WINDOW', '86400'))  # seconds between counted clicks from one IP
MAX_TRACKED_IPS = 200000

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute('CREATE TABLE IF NOT EXISTS counts (file TEXT, kind TEXT, n INTEGER NOT NULL, PRIMARY KEY (file, kind))')
db.commit()
lock = threading.Lock()
last_counted = {}


def first_click_today(ip):
    now = time.monotonic()
    with lock:
        last = last_counted.get(ip)
        if last is not None and now - last < CLICK_WINDOW:
            return False
        if len(last_counted) >= MAX_TRACKED_IPS:
            for old_ip in [k for k, t in last_counted.items() if now - t >= CLICK_WINDOW]:
                del last_counted[old_ip]
            if len(last_counted) >= MAX_TRACKED_IPS:
                last_counted.clear()
        last_counted[ip] = now
        return True


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

    def count(self, file, kind):
        if kind not in KINDS or not FILE_RE.match(file) or not os.path.isfile(os.path.join(FILES_DIR, file)):
            return self.respond(400)
        ip = self.headers.get('X-Real-IP', '')
        if ip and ip not in OWNER_IPS and first_click_today(ip):
            add_click(file, kind)
        return self.respond(204)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path == '/internal/hit':
            if self.headers.get('X-Original-Method') != 'GET':
                return self.respond(204)
            name = os.path.basename(unquote(urlsplit(self.headers.get('X-Original-URI', '')).path))
            if name.lower().endswith('.torrent'):
                return self.count(name[:-len('.torrent')], 'torrent')
            return self.count(name, 'download')
        if url.path == '/api/count':
            query = parse_qs(url.query)
            kind = query.get('kind', [''])[0]
            if kind != 'magnet':
                return self.respond(204)  # downloads and torrents are counted by the server itself
            return self.count(query.get('file', [''])[0], kind)
        return self.respond(404)

    def do_GET(self):
        if urlsplit(self.path).path != '/api/stats':
            return self.respond(404)
        if self.headers.get('X-Real-IP', '') in OWNER_IPS:
            return self.respond(200, {'owner': True, 'counts': read_counts()})
        return self.respond(200, {'owner': False})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
