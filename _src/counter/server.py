#!/usr/bin/env python3
"""Download counter for somov.org. Standard library only.

POST /internal/hit   nginx reports every GET of a file on dl3 (through `mirror`), whatever page or chat
                     the link was opened from; not reachable from outside
POST /api/count      the site reports what never reaches the server:
                       ?file=<iso name>&kind=magnet       a magnet link was clicked
                       ?tweak=<id>&kind=copy|link         a tweak command was copied / a tweak link was opened
                       ?page=<path>&kind=view             a page was opened (once per IP per page per day)
                       ?tg=<place>&kind=click             a link to the Telegram channel was clicked
GET  /api/stats      returns the counts to the owner's IP, and {"owner": false} to everyone else

Windows images (.iso and their .torrent): each IP is counted once per 24 hours across all images.
Everything else (tweak files, commands, links): each IP is counted once per 24 hours per file or tweak,
so someone taking three tweaks counts for all three.
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

FILE_RE = re.compile(r'^[^/\\\x00-\x1f]{1,200}$')
TWEAK_RE = re.compile(r'^[a-z0-9-]{1,60}$')
TWEAK_KINDS = {'copy', 'link'}
PAGE_RE = re.compile(r'^/[a-z0-9/-]{0,100}$')
PLACE_RE = re.compile(r'^[a-z0-9-]{1,30}$')
CLICK_WINDOW = int(os.environ.get('CLICK_WINDOW', '86400'))  # seconds between counted actions from one IP
MAX_TRACKED = 300000

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute('CREATE TABLE IF NOT EXISTS counts (file TEXT, kind TEXT, n INTEGER NOT NULL, PRIMARY KEY (file, kind))')
db.commit()
lock = threading.Lock()
last_counted = {}


def first_today(key):
    now = time.monotonic()
    with lock:
        last = last_counted.get(key)
        if last is not None and now - last < CLICK_WINDOW:
            return False
        if len(last_counted) >= MAX_TRACKED:
            for old in [k for k, t in last_counted.items() if now - t >= CLICK_WINDOW]:
                del last_counted[old]
            if len(last_counted) >= MAX_TRACKED:
                last_counted.clear()
        last_counted[key] = now
        return True


def add(file, kind):
    with lock:
        db.execute('INSERT INTO counts VALUES (?, ?, 1) ON CONFLICT (file, kind) DO UPDATE SET n = n + 1', (file, kind))
        db.commit()


def day_key(days_ago=0):
    return 'day:' + time.strftime('%Y-%m-%d', time.localtime(time.time() - days_ago * 86400))


def add_view(key):
    """Total views of a page plus one row per day; rows older than 30 days are dropped."""
    with lock:
        db.execute("INSERT INTO counts VALUES (?, 'view', 1) ON CONFLICT (file, kind) DO UPDATE SET n = n + 1", (key,))
        db.execute('INSERT INTO counts VALUES (?, ?, 1) ON CONFLICT (file, kind) DO UPDATE SET n = n + 1', (key, day_key()))
        db.execute("DELETE FROM counts WHERE file = ? AND kind LIKE 'day:%' AND kind < ?", (key, day_key(29)))
        db.commit()


def read_counts():
    """Totals per file; pages also get today, week (last 7 days) and month (last 30 days)."""
    counts = {}
    today, week, month = day_key(), day_key(6), day_key(29)
    with lock:
        for file, kind, n in db.execute('SELECT file, kind, n FROM counts'):
            entry = counts.setdefault(file, {})
            if kind.startswith('day:'):
                for name, since in (('today', today), ('week', week), ('month', month)):
                    if kind >= since:
                        entry[name] = entry.get(name, 0) + n
                continue
            entry[kind] = n
    return counts


def is_image(name):
    return name.lower().endswith('.iso')


def file_exists(name):
    return bool(FILE_RE.match(name)) and not name.startswith('.') and os.path.isfile(os.path.join(FILES_DIR, name))


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

    def count(self, key, kind, dedupe):
        ip = self.headers.get('X-Real-IP', '')
        if ip and ip not in OWNER_IPS and first_today((ip,) + dedupe):
            add(key, kind)
        return self.respond(204)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path == '/internal/hit':
            if self.headers.get('X-Original-Method') != 'GET':
                return self.respond(204)
            name = os.path.basename(unquote(urlsplit(self.headers.get('X-Original-URI', '')).path))
            if name.lower().endswith('.torrent') and is_image(name[:-len('.torrent')]):
                image = name[:-len('.torrent')]
                if not file_exists(image):
                    return self.respond(400)
                return self.count(image, 'torrent', ('images',))
            if not file_exists(name):
                return self.respond(400)
            if is_image(name):
                return self.count(name, 'download', ('images',))
            return self.count(name, 'download', ('file', name))
        if url.path == '/api/count':
            query = parse_qs(url.query)
            kind = query.get('kind', [''])[0]
            page = query.get('page', [''])[0]
            if page:
                if kind != 'view' or not PAGE_RE.match(page):
                    return self.respond(400)
                ip = self.headers.get('X-Real-IP', '')
                if ip and ip not in OWNER_IPS and first_today((ip, 'page', page)):
                    add_view('page:' + page)
                return self.respond(204)
            place = query.get('tg', [''])[0]
            if place:
                if kind != 'click' or not PLACE_RE.match(place):
                    return self.respond(400)
                ip = self.headers.get('X-Real-IP', '')
                if ip and ip not in OWNER_IPS:
                    # 'tg' is the site-wide total (one per IP per day), 'tg:<place>' the clicks from one place
                    if first_today((ip, 'tg')):
                        add('tg', 'click')
                    if first_today((ip, 'tg', place)):
                        add('tg:' + place, 'click')
                return self.respond(204)
            tweak = query.get('tweak', [''])[0]
            if tweak:
                if kind not in TWEAK_KINDS or not TWEAK_RE.match(tweak):
                    return self.respond(400)
                return self.count('tweak:' + tweak, kind, ('tweak', tweak, kind))
            if kind != 'magnet':
                return self.respond(204)  # file downloads are counted by the server itself
            file = query.get('file', [''])[0]
            if not is_image(file) or not file_exists(file):
                return self.respond(400)
            return self.count(file, 'magnet', ('images',))
        return self.respond(404)

    def do_GET(self):
        if urlsplit(self.path).path != '/api/stats':
            return self.respond(404)
        if self.headers.get('X-Real-IP', '') in OWNER_IPS:
            return self.respond(200, {'owner': True, 'counts': read_counts()})
        return self.respond(200, {'owner': False})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
