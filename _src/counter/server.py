#!/usr/bin/env python3
"""Download counter for somov.org. Standard library only.

POST /internal/hit   nginx reports every GET of a file on dl3 (through `mirror`), whatever page or chat
                     the link was opened from; not reachable from outside
POST /api/count      the site reports what never reaches the server:
                       ?file=<iso name>&kind=magnet       a magnet link was clicked
                       ?tweak=<id>&kind=copy|link         a tweak command was copied / a tweak link was opened
                       ?page=<path>&kind=view             a page was opened (once per IP per page per day)
                       ?tg=<place>&kind=click             a link to the Telegram channel was clicked
GET  /api/stats      returns the counts to the owner (IP in OWNER_IPS or ?owner=<token> from OWNER_TOKENS),
                     and {"owner": false} to everyone else; the owner's own visits and clicks are never counted

Two counts are kept for everything. The unique one (the plain kind: download, view, click...) counts each IP
once per 24 hours per thing; it is what may become public. The total one (kind 'all:<kind>', and for pages
'hits' with daily 'hday:' rows) counts every action, for the owner's fuller picture: a reload is another view.
For files only the start of a download is a total action (no Range header, or a range from byte 0), so a
download made of many partial requests is one, and a resumed download adds nothing; one IP adds at most
TOTAL_CAP total actions per thing per day, so a reload loop cannot inflate it.
Each IP is counted once per 24 hours per thing: per Windows image (its ISO, .torrent and magnet together,
whichever way it was taken), per tweak file, command or link. Someone taking the English and the Russian
image, or three tweaks, counts for each of them.
Runs behind nginx, which sets X-Real-IP. Visitor IPs are never stored: the counter remembers who was
already counted by a salted hash of the IP and the action. On stop (an update, a reboot) it saves these
hashes to SEEN_PATH and on start reads them back and deletes the file, so nobody is counted twice and
nothing about visitors stays on disk while the counter runs.
Tweak downloads are kept per tweak, not per file name (KEYS_URL also maps every tweak file to its tweak),
so a new version of a tool continues the count; builds are counted per file and start anew with a new file. Only real pages, tweaks and Telegram link places are counted: the site publishes them in
/counter-keys.json on every build, and the counter downloads that list every 10 minutes (KEYS_URL).
"""
import hashlib
import hmac
import json
import os
import secrets
import signal
import sys
import re
import sqlite3
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

FILES_DIR = os.environ.get('FILES_DIR', '/var/www/html')
DB_PATH = os.environ.get('DB_PATH', '/var/lib/somov-counter/counts.db')
PORT = int(os.environ.get('PORT', '8095'))
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', 'https://somov.org')
SEEN_PATH = os.environ.get('SEEN_PATH', '')
KEYS_URL = os.environ.get('KEYS_URL', 'https://somov.org/counter-keys.json')
KEYS_CACHE = os.path.join(os.path.dirname(DB_PATH), 'counter-keys.json')  # used until the site answers
KEYS_REFRESH = 600
OWNER_IPS = {ip.strip() for ip in os.environ.get('OWNER_IPS', '').split(',') if ip.strip()}
# A device of the owner on any network (a phone on mobile data): the site sends ?owner=<token> it keeps in localStorage
OWNER_TOKENS = [t.strip() for t in os.environ.get('OWNER_TOKENS', '').split(',') if len(t.strip()) >= 16]

FILE_RE = re.compile(r'^[^/\\\x00-\x1f]{1,200}$')
TWEAK_RE = re.compile(r'^[a-z0-9-]{1,60}$')
TWEAK_KINDS = {'copy', 'link'}
PAGE_RE = re.compile(r'^/[a-z0-9/-]{0,100}$')
PLACE_RE = re.compile(r'^[a-z0-9-]{1,30}$')
CLICK_WINDOW = int(os.environ.get('CLICK_WINDOW', '86400'))  # seconds between counted actions from one IP
MAX_TRACKED = 300000
# Search and SEO robots (Barkrowler, SemrushBot, DotBot, link previews...) are not people: never counted.
# Download tools people use (curl, wget, aria2, download managers) are counted.
BOT_RE = re.compile(r'bot|crawl|spider|slurp|preview|headless|lighthouse|scanner|facebookexternalhit', re.I)
TOTAL_CAP = int(os.environ.get('TOTAL_CAP', '30'))  # total actions counted per IP per thing per day

db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute('CREATE TABLE IF NOT EXISTS counts (file TEXT, kind TEXT, n INTEGER NOT NULL, PRIMARY KEY (file, kind))')
db.commit()
lock = threading.Lock()
last_counted = {}  # hash of (ip, action) -> unix time it was counted
totals_today = {}  # hash of (ip, action) -> [day, total actions counted that day]
salt = secrets.token_hex(16)


allowed = None  # {'pages': set, 'tweaks': set, 'places': set}; None until a list is loaded

# Tweak file name -> tweak:<id>. Every pair ever seen is kept, so a new version of a tool continues the count
# of its tweak and an old file still counts under it. Builds are not mapped: they are counted per file.
db.execute('CREATE TABLE IF NOT EXISTS aliases (file TEXT PRIMARY KEY, key TEXT NOT NULL)')
db.commit()
aliases = dict(db.execute('SELECT file, key FROM aliases'))


def resolve(name):
    return aliases.get(name, name)


def remember_files(files):
    """Stores new file -> key pairs and moves counts recorded under a file name to its key."""
    with lock:
        for file, key in files.items():
            if aliases.get(file) == key:
                continue
            db.execute('INSERT INTO aliases VALUES (?, ?) ON CONFLICT (file) DO UPDATE SET key = excluded.key', (file, key))
            rows = db.execute('SELECT kind, n FROM counts WHERE file = ?', (file,)).fetchall()
            for kind, n in rows:
                db.execute('INSERT INTO counts VALUES (?, ?, ?) ON CONFLICT (file, kind) DO UPDATE SET n = n + ?', (key, kind, n, n))
            db.execute('DELETE FROM counts WHERE file = ?', (file,))
            aliases[file] = key
        db.commit()


def parse_keys(data):
    keys = {name: set(data[name]) for name in ('pages', 'tweaks', 'places')}
    keys['files'] = dict(data.get('files', {}))
    if not all(isinstance(v, str) for values in keys.values() for v in values) or not keys['pages']:
        raise ValueError('bad counter keys')
    if not all(isinstance(v, str) and re.match(r'^tweak:[a-z0-9-]{1,60}$', v) for v in keys['files'].values()):
        raise ValueError('bad file keys')
    return keys


def refresh_keys():
    """Loads the list from the cache, then keeps it up to date from the site."""
    global allowed
    try:
        with open(KEYS_CACHE) as f:
            allowed = parse_keys(json.load(f))
        remember_files(allowed['files'])
    except (OSError, ValueError, KeyError, TypeError):
        pass
    while True:
        try:
            request = urllib.request.Request(KEYS_URL, headers={'User-Agent': 'somov-counter'})
            with urllib.request.urlopen(request, timeout=15) as response:
                raw = response.read(1_000_000)
            keys = parse_keys(json.loads(raw))
            remember_files(keys['files'])
            allowed = keys
            with open(KEYS_CACHE + '.tmp', 'wb') as f:
                f.write(raw)
            os.replace(KEYS_CACHE + '.tmp', KEYS_CACHE)
        except Exception:  # the site is unreachable or the file is broken: keep the previous list
            pass
        time.sleep(KEYS_REFRESH)


def known(group, value):
    # Before the first list is loaded everything that passes the format check is accepted
    return allowed is None or value in allowed[group]


def load_seen():
    global salt
    if not SEEN_PATH:
        return
    try:
        with open(SEEN_PATH) as f:
            data = json.load(f)
        salt = data['salt']
        now = time.time()
        last_counted.update({k: t for k, t in data['seen'].items() if now - t < CLICK_WINDOW})
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    try:
        os.remove(SEEN_PATH)
    except OSError:
        pass


def save_seen(*_):
    if SEEN_PATH:
        with lock:
            data = {'salt': salt, 'seen': dict(last_counted)}
        tmp = SEEN_PATH + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, SEEN_PATH)
    sys.exit(0)


def first_today(key):
    key = hashlib.sha256((salt + repr(key)).encode()).hexdigest()[:24]
    now = time.time()
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


def total_allowed(key):
    """True for up to TOTAL_CAP total actions of one IP on one thing per day."""
    key = hashlib.sha256((salt + 'total' + repr(key)).encode()).hexdigest()[:24]
    today = time.strftime('%Y-%m-%d')
    with lock:
        entry = totals_today.get(key)
        if entry is None or entry[0] != today:
            if len(totals_today) >= MAX_TRACKED:
                for old in [k for k, v in totals_today.items() if v[0] != today]:
                    del totals_today[old]
                if len(totals_today) >= MAX_TRACKED:
                    totals_today.clear()
            entry = totals_today[key] = [today, 0]
        if entry[1] >= TOTAL_CAP:
            return False
        entry[1] += 1
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


def add_hit(key):
    """Every view of a page (total), plus one row per day ('hday:'); rows older than 30 days are dropped."""
    hday = 'h' + day_key()
    with lock:
        db.execute("INSERT INTO counts VALUES (?, 'hits', 1) ON CONFLICT (file, kind) DO UPDATE SET n = n + 1", (key,))
        db.execute('INSERT INTO counts VALUES (?, ?, 1) ON CONFLICT (file, kind) DO UPDATE SET n = n + 1', (key, hday))
        db.execute("DELETE FROM counts WHERE file = ? AND kind LIKE 'hday:%' AND kind < ?", (key, 'h' + day_key(29)))
        db.commit()


def read_counts():
    """Totals per file; pages also get today, week (last 7 days) and month (last 30 days), unique and hits_*."""
    counts = {}
    today, week, month = day_key(), day_key(6), day_key(29)
    with lock:
        for file, kind, n in db.execute('SELECT file, kind, n FROM counts'):
            entry = counts.setdefault(file, {})
            if kind.startswith('day:') or kind.startswith('hday:'):
                prefix = 'hits_' if kind.startswith('h') else ''
                for name, since in (('today', today), ('week', week), ('month', month)):
                    if kind.lstrip('h') >= since:
                        entry[prefix + name] = entry.get(prefix + name, 0) + n
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

    def owner_via(self):
        """'ip', 'token' or '' — how the owner was recognized ('token' at home means the home IP changed)."""
        if self.headers.get('X-Real-IP', '') in OWNER_IPS:
            return 'ip'
        token = parse_qs(urlsplit(self.path).query).get('owner', [''])[0]
        return 'token' if token and any(hmac.compare_digest(token, t) for t in OWNER_TOKENS) else ''

    def is_owner(self):
        return bool(self.owner_via())

    def ignored(self):
        """The owner or a robot: nothing is counted. Downloads come through nginx with the visitor's User-Agent."""
        ua = self.headers.get('X-Original-UA') or self.headers.get('User-Agent', '')
        return self.is_owner() or bool(BOT_RE.search(ua))

    def count(self, key, kind, dedupe, start=True):
        """Unique count (once per IP per day) and total count (every action; `start` False for the middle of a download)."""
        ip = self.headers.get('X-Real-IP', '')
        if ip and not self.ignored():
            if first_today((ip,) + dedupe):
                add(key, kind)
            if start and total_allowed((ip, key, kind)):
                add(key, 'all:' + kind)
        return self.respond(204)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path == '/internal/hit':
            if self.headers.get('X-Original-Method') != 'GET':
                return self.respond(204)
            name = os.path.basename(unquote(urlsplit(self.headers.get('X-Original-URI', '')).path))
            # A download starts with no Range or a range from byte 0; later parts and resumes are not new downloads
            byte_range = self.headers.get('X-Original-Range', '').replace(' ', '')
            start = not byte_range or byte_range.startswith('bytes=0-')
            if name.lower().endswith('.torrent') and is_image(name[:-len('.torrent')]):
                image = name[:-len('.torrent')]
                if not file_exists(image):
                    return self.respond(400)
                key = resolve(image)
                return self.count(key, 'torrent', ('image', key))
            if not file_exists(name):
                return self.respond(400)
            key = resolve(name)
            if is_image(name):
                return self.count(key, 'download', ('image', key), start)
            return self.count(key, 'download', ('file', name), start)
        if url.path == '/api/count':
            query = parse_qs(url.query)
            kind = query.get('kind', [''])[0]
            page = query.get('page', [''])[0]
            if page:
                if kind != 'view' or not PAGE_RE.match(page) or not known('pages', page):
                    return self.respond(400)
                ip = self.headers.get('X-Real-IP', '')
                if ip and not self.ignored():
                    if first_today((ip, 'page', page)):
                        add_view('page:' + page)
                    if total_allowed((ip, 'page', page)):
                        add_hit('page:' + page)
                return self.respond(204)
            place = query.get('tg', [''])[0]
            if place:
                if kind != 'click' or not PLACE_RE.match(place) or not known('places', place):
                    return self.respond(400)
                ip = self.headers.get('X-Real-IP', '')
                if ip and not self.ignored():
                    # 'tg' is the site-wide total (one per IP per day), 'tg:<place>' the clicks from one place
                    if first_today((ip, 'tg')):
                        add('tg', 'click')
                    if first_today((ip, 'tg', place)):
                        add('tg:' + place, 'click')
                    if total_allowed((ip, 'tg', place)):
                        add('tg', 'all:click')
                        add('tg:' + place, 'all:click')
                return self.respond(204)
            tweak = query.get('tweak', [''])[0]
            if tweak:
                if kind not in TWEAK_KINDS or not TWEAK_RE.match(tweak) or not known('tweaks', tweak):
                    return self.respond(400)
                return self.count('tweak:' + tweak, kind, ('tweak', tweak, kind))
            if kind != 'magnet':
                return self.respond(204)  # file downloads are counted by the server itself
            file = query.get('file', [''])[0]
            if not is_image(file) or not file_exists(file):
                return self.respond(400)
            key = resolve(file)
            return self.count(key, 'magnet', ('image', key))
        return self.respond(404)

    def do_GET(self):
        if urlsplit(self.path).path != '/api/stats':
            return self.respond(404)
        via = self.owner_via()
        if via:
            return self.respond(200, {'owner': True, 'via': via, 'counts': read_counts()})
        return self.respond(200, {'owner': False})


if __name__ == '__main__':
    load_seen()
    signal.signal(signal.SIGTERM, save_seen)
    threading.Thread(target=refresh_keys, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
