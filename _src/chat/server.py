#!/usr/bin/env python3
"""Site chat of somov.org.

A visitor writes in the chat window on the site (text, photos, files); the message is stored here and a Telegram
bot sends it to the owner. The owner answers with Telegram "Reply" on that message (text, photo or file); the
answer is stored and the visitor's window picks it up. Runs on VpsDl behind nginx:
https://dl.somov.org/api/chat/ -> 127.0.0.1:8097.

A visitor is a random id made by their browser (no sign-up). IP addresses are not stored: rate limits keep only
salted hashes in memory. Files live next to the database and are served only to their conversation; anything
that is not a picture is always served as a download, never shown by the browser. The owner sees the visitor's
country as a flag: it is looked up in a local copy of the free DB-IP country database (no outside service), and
only the country code is kept.
"""
import csv, gzip, hashlib, io, ipaddress, json, os, re, secrets, sqlite3, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

TOKEN = os.environ['CHAT_BOT_TOKEN']
OWNER = int(os.environ.get('OWNER_CHAT_ID', '349187009'))
PORT = int(os.environ.get('PORT', '8097'))
DB_PATH = os.environ.get('DB_PATH', '/var/lib/somov-chat/chat.db')
FILES_DIR = os.path.join(os.path.dirname(DB_PATH), 'files')
GEO_DB = os.path.join(os.path.dirname(DB_PATH), 'geoip.db')
GEO_URL = 'https://download.db-ip.com/free/dbip-country-lite-{}.csv.gz'   # CC BY 4.0, IP Geolocation by DB-IP
ORIGINS = {'https://somov.org', 'http://127.0.0.1:8080', 'http://localhost:8080'}
API = f'https://api.telegram.org/bot{TOKEN}/'
FILE_API = f'https://api.telegram.org/file/bot{TOKEN}/'

MAX_TEXT, MAX_CONTACT, MAX_PAGE, MAX_BODY = 2000, 120, 200, 8192
MAX_FILE = 10 * 1024 * 1024                       # one file from a visitor
OWNER_FILE = 20 * 1024 * 1024                     # bots can download at most 20 MB from Telegram
FILES_TOTAL = 2 * 1024 ** 3                       # all stored files together
PER_MINUTE, PER_DAY, ALL_PER_DAY = 6, 40, 400     # messages (and files) from one IP; from everybody
BYTES_PER_DAY = 60 * 1024 * 1024                  # uploaded by one IP in a day
KEEP_DAYS = 365                                   # a conversation silent this long is deleted
VISITOR_RE = re.compile(r'^[0-9a-f]{32}$')

HELP = ('Здесь приходят сообщения из чата на somov.org.\n\n'
        'Чтобы ответить посетителю, смахните его сообщение влево (или нажмите «Ответить») и напишите ответ: '
        'он появится у посетителя в окне чата. Можно ответить фото или файлом (до 20 МБ). '
        'Отвечать можно и на свои прошлые ответы в этой переписке.')


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


os.makedirs(FILES_DIR, exist_ok=True)
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.executescript('''
CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, n INTEGER NOT NULL UNIQUE, contact TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, active INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, owner INTEGER NOT NULL,
  text TEXT NOT NULL, page TEXT NOT NULL DEFAULT '', t INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread, id);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, thread TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, image INTEGER NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg (msg INTEGER PRIMARY KEY, thread TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
''')
if 'file' not in [row[1] for row in db.execute('PRAGMA table_info(messages)')]:
    db.execute("ALTER TABLE messages ADD COLUMN file TEXT NOT NULL DEFAULT ''")
if 'cc' not in [row[1] for row in db.execute('PRAGMA table_info(messages)')]:
    db.execute("ALTER TABLE messages ADD COLUMN cc TEXT NOT NULL DEFAULT ''")
db.commit()
lock = threading.Lock()
wake = threading.Event()   # a new visitor message: send it to Telegram now


def q(sql, *args):
    with lock:
        return db.execute(sql, args).fetchall()


def run(sql, *args):
    with lock:
        cur = db.execute(sql, args)
        db.commit()
        return cur


def state(key, value=None):
    if value is None:
        row = q('SELECT v FROM state WHERE k = ?', key)
        return row[0][0] if row else None
    run('INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)', key, str(value))


# -- Country of an IP (local DB-IP copy, refreshed monthly) -------------------

geo_lock = threading.Lock()
geo = None


def geo_open():
    global geo
    with geo_lock:
        geo = sqlite3.connect(f'file:{GEO_DB}?mode=ro', uri=True, check_same_thread=False) if os.path.exists(GEO_DB) else None


def geo_update():
    """Downloads the country database when the copy is older than a month (DB-IP publishes one each month)."""
    if os.path.exists(GEO_DB) and time.time() - os.path.getmtime(GEO_DB) < 32 * 86400:
        return
    now = time.gmtime()
    months = [f'{now.tm_year}-{now.tm_mon:02d}',
              f'{now.tm_year - (now.tm_mon == 1)}-{(now.tm_mon - 2) % 12 + 1:02d}']   # the new one may be late
    for month in months:
        try:
            request = urllib.request.Request(GEO_URL.format(month), headers={'User-Agent': 'somov-chat/1.0'})
            with urllib.request.urlopen(request, timeout=120) as response:
                packed = response.read()
            break
        except (urllib.error.URLError, OSError) as error:
            log('geoip download', month, error)
    else:
        return
    tmp = GEO_DB + '.tmp'
    if os.path.exists(tmp):
        os.remove(tmp)
    build = sqlite3.connect(tmp)
    build.execute('CREATE TABLE v4 (start INTEGER PRIMARY KEY, end INTEGER NOT NULL, cc TEXT NOT NULL)')
    build.execute('CREATE TABLE v6 (start BLOB PRIMARY KEY, end BLOB NOT NULL, cc TEXT NOT NULL) WITHOUT ROWID')
    v4, v6, count = [], [], 0   # written in small batches: the service has little memory
    for first, last, cc in csv.reader(io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(packed)), 'ascii')):
        a, b = ipaddress.ip_address(first), ipaddress.ip_address(last)
        if a.version == 4:
            v4.append((int(a), int(b), cc))
        else:
            v6.append((a.packed, b.packed, cc))
        count += 1
        if len(v4) + len(v6) >= 20000:
            build.executemany('INSERT OR REPLACE INTO v4 VALUES (?, ?, ?)', v4)
            build.executemany('INSERT OR REPLACE INTO v6 VALUES (?, ?, ?)', v6)
            v4, v6 = [], []
    build.executemany('INSERT OR REPLACE INTO v4 VALUES (?, ?, ?)', v4)
    build.executemany('INSERT OR REPLACE INTO v6 VALUES (?, ?, ?)', v6)
    build.commit()
    build.close()
    os.replace(tmp, GEO_DB)
    geo_open()
    log(f'geoip {month}: {count} ranges')


def country(ip):
    """Two-letter country code of an IP address, or ''."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ''
    if address.version == 6 and address.ipv4_mapped:
        address = address.ipv4_mapped
    with geo_lock:
        if geo is None:
            return ''
        if address.version == 4:
            row = geo.execute('SELECT end, cc FROM v4 WHERE start <= ? ORDER BY start DESC LIMIT 1', (int(address),)).fetchone()
            hit = row and int(address) <= row[0]
        else:
            row = geo.execute('SELECT end, cc FROM v6 WHERE start <= ? ORDER BY start DESC LIMIT 1', (address.packed,)).fetchone()
            hit = row and address.packed <= row[0]
    return row[1] if hit and re.fullmatch(r'[A-Z]{2}', row[1]) and row[1] != 'ZZ' else ''


def flag(cc):
    return ''.join(chr(0x1F1E6 + ord(c) - 65) for c in cc) + f' {cc}' if cc else ''


# -- Files ------------------------------------------------------------------

def sniff(data):
    """The real type of a picture by its first bytes; '' for anything else (the name and the browser can lie)."""
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if data[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    return ''


def file_name(name):
    name = re.sub(r'[\x00-\x1f\x7f"\\/:*?<>|]', '', os.path.basename(str(name or '').replace('\\', '/'))).strip(' .')
    return name[-120:] or 'file'


def store_file(thread, name, data):
    fid = secrets.token_hex(16)
    mime = sniff(data)
    with open(os.path.join(FILES_DIR, fid), 'wb') as out:
        out.write(data)
    run('INSERT INTO files (id, thread, name, mime, size, image, t) VALUES (?, ?, ?, ?, ?, ?, ?)',
        fid, thread, file_name(name), mime or 'application/octet-stream', len(data), int(bool(mime)), int(time.time()))
    return fid


def files_total():
    return q('SELECT COALESCE(SUM(size), 0) FROM files')[0][0]


def size_text(size):
    return f'{size / 1024 / 1024:.1f} МБ' if size >= 1024 * 1024 else f'{max(1, round(size / 1024))} КБ'


# -- Telegram ---------------------------------------------------------------

def call(method, request, wait):
    try:
        with urllib.request.urlopen(request, timeout=wait) as response:
            return json.load(response)['result']
    except urllib.error.HTTPError as error:
        # The body says why (never the token); the URL with the token is not logged
        raise RuntimeError(f'{method}: {error.code} {error.read()[:200]!r}') from None
    except urllib.error.URLError as error:
        raise RuntimeError(f'{method}: {error.reason}') from None


def tg(method, wait=15, **params):
    """Calls the Bot API; `wait` is the HTTP timeout (Telegram's own `timeout` goes in params)."""
    request = urllib.request.Request(API + method, json.dumps(params).encode(), {'Content-Type': 'application/json'})
    return call(method, request, wait)


def tg_upload(method, field, name, data, mime, **params):
    boundary = secrets.token_hex(16)
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n'.encode()
             + (json.dumps(v) if isinstance(v, (dict, list)) else str(v)).encode() + b'\r\n' for k, v in params.items()]
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{file_name(name)}"\r\n'
                 f'Content-Type: {mime}\r\n\r\n'.encode() + data + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    request = urllib.request.Request(API + method, b''.join(parts),
                                     {'Content-Type': f'multipart/form-data; boundary={boundary}'})
    return call(method, request, 180)


def say(text, reply_to=None):
    params = {'chat_id': OWNER, 'text': text, 'link_preview_options': {'is_disabled': True}}
    if reply_to:
        params['reply_parameters'] = {'message_id': reply_to, 'allow_sending_without_reply': True}
    return tg('sendMessage', **params)


def deliver():
    """Sends stored visitor messages to the owner; whatever fails is retried later."""
    rows = q('SELECT m.id, m.thread, m.text, m.page, m.file, m.cc, t.n, t.contact, t.lang, '
             '(SELECT COUNT(*) FROM messages WHERE thread = m.thread AND id < m.id) '
             'FROM messages m JOIN threads t ON t.id = m.thread WHERE m.owner = 0 AND m.sent = 0 ORDER BY m.id')
    for mid, thread, text, page, fid, cc, n, contact, lang, before in rows:
        lines = [f'💬 #{n}' + (' · новый собеседник' if before == 0 else ''), '']
        if text:
            lines += [text, '']
        if contact:
            lines.append(f'✉️ {contact}')
        lines.append(' · '.join(x for x in (flag(cc), f'📄 {page or "/"}', lang) if x))
        caption = '\n'.join(lines).strip()
        try:
            stored = q('SELECT name, mime, size, image FROM files WHERE id = ?', fid) if fid else []
            if stored:
                name, mime, size, image = stored[0]
                with open(os.path.join(FILES_DIR, fid), 'rb') as source:
                    data = source.read()
                caption = caption[:1024]
                sent = None
                if image and size <= 10 * 1024 * 1024:
                    try:
                        sent = tg_upload('sendPhoto', 'photo', name, data, mime, chat_id=OWNER, caption=caption)
                    except RuntimeError as error:   # too large in pixels, odd format: send it as a file
                        log('photo as file:', error)
                if not sent:
                    sent = tg_upload('sendDocument', 'document', name, data, mime, chat_id=OWNER, caption=caption)
            else:
                sent = say(caption)
        except (RuntimeError, OSError) as error:
            log('send failed:', error)
            return
        run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', sent['message_id'], thread)
        run('UPDATE messages SET sent = 1 WHERE id = ?', mid)


def owner_file(message):
    """(file_id, name, size) of a photo or a file in the owner's message, or None."""
    if message.get('photo'):
        photo = message['photo'][-1]   # the largest size
        return photo['file_id'], 'photo.jpg', photo.get('file_size', 0)
    for kind in ('document', 'video', 'animation', 'audio', 'voice'):
        item = message.get(kind)
        if item:
            return item['file_id'], item.get('file_name') or kind, item.get('file_size', 0)
    return None


def owner_message(message):
    text = (message.get('text') or message.get('caption') or '').strip()
    attached = owner_file(message)
    if message.get('text', '').startswith('/'):
        say(HELP)
        return
    reply = message.get('reply_to_message')
    if not reply:
        say('Чтобы ответить посетителю, нажмите «Ответить» на его сообщении.', message['message_id'])
        return
    row = q('SELECT thread FROM tg WHERE msg = ?', reply['message_id'])
    if not row:
        say('Не нашёл переписку для этого сообщения: ответьте на сообщение посетителя.', message['message_id'])
        return
    if not text and not attached:
        say('Можно отвечать текстом, фото или файлом.', message['message_id'])
        return
    thread = row[0][0]
    fid = ''
    if attached:
        file_id, name, size = attached
        if size > OWNER_FILE or files_total() + size > FILES_TOTAL:
            say('Файл слишком большой: можно до 20 МБ.', message['message_id'])
            return
        try:
            path = tg('getFile', file_id=file_id)['file_path']
            with urllib.request.urlopen(FILE_API + path, timeout=120) as response:
                data = response.read(OWNER_FILE + 1)
        except (RuntimeError, urllib.error.URLError, OSError) as error:
            log('owner file:', type(error).__name__)
            say('Не удалось забрать файл из Telegram, попробуйте ещё раз.', message['message_id'])
            return
        if len(data) > OWNER_FILE:
            say('Файл слишком большой: можно до 20 МБ.', message['message_id'])
            return
        fid = store_file(thread, name, data)
    now = int(time.time())
    run('INSERT INTO messages (thread, owner, text, t, sent, file) VALUES (?, 1, ?, ?, 1, ?)', thread, text[:4000], now, fid)
    run('UPDATE threads SET active = ? WHERE id = ?', now, thread)
    run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', message['message_id'], thread)
    try:   # a quiet "delivered" mark on the answer
        tg('setMessageReaction', chat_id=OWNER, message_id=message['message_id'],
           reaction=[{'type': 'emoji', 'emoji': '👍'}])
    except RuntimeError:
        say('✓ Ответ отправлен', message['message_id'])


def updates():
    offset = int(state('offset') or 0)
    while True:
        try:
            batch = tg('getUpdates', 60, offset=offset, timeout=50, allowed_updates=['message'])
        except RuntimeError as error:
            log('updates:', error)
            time.sleep(10)
            continue
        for update in batch:
            offset = update['update_id'] + 1
            message = update.get('message') or {}
            if message.get('chat', {}).get('id') != OWNER:
                continue   # anybody else who finds the bot gets nothing
            try:
                owner_message(message)
            except Exception as error:   # one bad update must not stop the loop
                log('owner message:', error)
        if batch:
            state('offset', offset)


def sender():
    last_cleanup = 0
    while True:
        wake.wait(30)
        wake.clear()
        try:
            deliver()
        except Exception as error:
            log('deliver:', error)
        if time.time() - last_cleanup > 86400:
            last_cleanup = time.time()
            try:
                geo_update()
            except Exception as error:
                log('geoip:', error)
            old = [r[0] for r in q('SELECT id FROM threads WHERE active < ?', int(time.time()) - KEEP_DAYS * 86400)]
            for thread in old:
                for (fid,) in q('SELECT id FROM files WHERE thread = ?', thread):
                    try:
                        os.remove(os.path.join(FILES_DIR, fid))
                    except OSError:
                        pass
                for table in ('messages', 'files', 'tg'):
                    run(f'DELETE FROM {table} WHERE thread = ?', thread)
                run('DELETE FROM threads WHERE id = ?', thread)


# -- Rate limits (salted hashes of IPs, in memory only) -------------------------

salt = secrets.token_hex(16)
hits = {}          # hash -> [(time, bytes)] of messages in the last day
everybody = []     # times of all messages in the last day


def allowed(ip, size=0):
    now = time.time()
    key = hashlib.sha256((salt + ip).encode()).hexdigest()[:24]
    with lock:
        recent = [h for h in hits.get(key, []) if now - h[0] < 86400]
        everybody[:] = [t for t in everybody if now - t < 86400]
        hits[key] = recent
        if (len(everybody) >= ALL_PER_DAY or len(recent) >= PER_DAY
                or sum(now - t < 60 for t, _ in recent) >= PER_MINUTE
                or sum(b for _, b in recent) + size > BYTES_PER_DAY):
            return False
        recent.append((now, size))
        everybody.append(now)
        if len(hits) > 50000:
            for k in [k for k, v in hits.items() if not v or now - v[-1][0] > 86400]:
                del hits[k]
        return True


# -- HTTP -------------------------------------------------------------------

def clean(value, limit):
    text = str(value or '').replace('\r\n', '\n').replace('\r', '\n')
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
    return re.sub(r'\n{4,}', '\n\n\n', text).strip()[:limit]


def file_view(fid, name, size, image):
    return {'id': fid, 'name': name, 'size': size, 'image': bool(image)} if fid else None


def thread_view(visitor, after):
    thread = q('SELECT contact FROM threads WHERE id = ?', visitor)
    if not thread:
        return {'messages': [], 'contact': False}
    rows = q('SELECT m.id, m.owner, m.text, m.t, f.id, f.name, f.size, f.image FROM messages m '
             'LEFT JOIN files f ON f.id = m.file WHERE m.thread = ? AND m.id > ? ORDER BY m.id LIMIT 500', visitor, after)
    return {'messages': [{'id': i, 'owner': bool(o), 'text': x, 't': t, 'file': file_view(fid, name, size, image)}
                         for i, o, x, t, fid, name, size, image in rows],
            'contact': bool(thread[0][0])}


def add_message(visitor, text, page, contact, lang, fid='', cc=''):
    """Stores a visitor message, starting the conversation if it is the first one."""
    now = int(time.time())
    with lock:
        if not db.execute('SELECT 1 FROM threads WHERE id = ?', (visitor,)).fetchone():
            n = db.execute('SELECT COALESCE(MAX(n), 0) + 1 FROM threads').fetchone()[0]
            db.execute('INSERT INTO threads (id, n, contact, lang, created, active) VALUES (?, ?, ?, ?, ?, ?)',
                       (visitor, n, contact, lang, now, now))
        else:
            db.execute('UPDATE threads SET active = ?, lang = ? WHERE id = ?', (now, lang, visitor))
            if contact:
                db.execute('UPDATE threads SET contact = ? WHERE id = ?', (contact, visitor))
        cur = db.execute('INSERT INTO messages (thread, owner, text, page, t, file, cc) VALUES (?, 0, ?, ?, ?, ?, ?)',
                         (visitor, text, page, now, fid, cc))
        db.commit()
    wake.set()
    return cur.lastrowid, now


class Handler(BaseHTTPRequestHandler):
    server_version = 'somov-chat'
    sys_version = ''

    def log_message(self, *args):
        pass   # nginx already logs requests

    def cors(self):
        origin = self.headers.get('Origin', '')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def reply(self, code, data=None):
        body = json.dumps(data if data is not None else {}, ensure_ascii=False).encode()
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def params(self):
        return {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}

    def do_GET(self):
        path = urlsplit(self.path).path
        params = self.params()
        visitor = params.get('v', '')
        if not VISITOR_RE.match(visitor):
            return self.reply(400, {'error': 'visitor'})
        if path == '/api/chat/messages':
            try:
                after = max(0, int(params.get('after', '0')))
            except ValueError:
                after = 0
            return self.reply(200, thread_view(visitor, after))
        match = re.fullmatch(r'/api/chat/file/([0-9a-f]{32})', path)
        row = q('SELECT name, mime, image FROM files WHERE id = ? AND thread = ?', match[1], visitor) if match else []
        if not row:
            return self.reply(404, {'error': 'not found'})
        name, mime, image = row[0]
        try:
            with open(os.path.join(FILES_DIR, match[1]), 'rb') as source:
                data = source.read()
        except OSError:
            return self.reply(404, {'error': 'not found'})
        self.send_response(200)
        # Pictures are shown; everything else is only ever downloaded, and nothing here can run as a page
        self.send_header('Content-Type', mime if image else 'application/octet-stream')
        self.send_header('Content-Disposition', f"{'inline' if image else 'attachment'}; filename*=UTF-8''{quote(name)}")
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'none'; sandbox")
        self.send_header('Cache-Control', 'private, max-age=604800')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self, limit):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return None
        if not 0 < length <= limit:
            return None
        return self.rfile.read(length)

    def do_POST(self):
        path = urlsplit(self.path).path
        ip = self.headers.get('X-Real-IP') or self.client_address[0]
        if path == '/api/chat/upload':
            params = self.params()
            visitor = params.get('v', '')
            if not VISITOR_RE.match(visitor):
                return self.reply(400, {'error': 'visitor'})
            data = self.body(MAX_FILE)
            if data is None:
                return self.reply(413, {'error': 'size'})
            if not allowed(ip, len(data)):
                return self.reply(429, {'error': 'limit'})
            if files_total() + len(data) > FILES_TOTAL:
                log('files: storage is full')
                return self.reply(507, {'error': 'full'})
            fid = store_file(visitor, params.get('name'), data)
            mid, now = add_message(visitor, '', clean(params.get('page'), MAX_PAGE).replace('\n', ' '),
                                   clean(params.get('contact'), MAX_CONTACT).replace('\n', ' '),
                                   'ru' if params.get('lang') == 'ru' else 'en', fid, country(ip))
            row = q('SELECT name, size, image FROM files WHERE id = ?', fid)[0]
            return self.reply(200, {'id': mid, 't': now, 'file': file_view(fid, *row)})
        if path != '/api/chat/send':
            return self.reply(404, {'error': 'not found'})
        raw = self.body(MAX_BODY)
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = None
        if not isinstance(data, dict):
            return self.reply(400, {'error': 'body'})
        visitor = str(data.get('v', ''))
        text = clean(data.get('text'), MAX_TEXT)
        if not VISITOR_RE.match(visitor) or not text:
            return self.reply(400, {'error': 'message'})
        if data.get('website'):   # the hidden field only robots fill in: pretend it worked
            return self.reply(200, {'id': 0, 't': int(time.time())})
        if not allowed(ip):
            return self.reply(429, {'error': 'limit'})
        mid, now = add_message(visitor, text, clean(data.get('page'), MAX_PAGE).replace('\n', ' '),
                               clean(data.get('contact'), MAX_CONTACT).replace('\n', ' '),
                               'ru' if data.get('lang') == 'ru' else 'en', cc=country(ip))
        self.reply(200, {'id': mid, 't': now})


if __name__ == '__main__':
    geo_open()
    threading.Thread(target=updates, daemon=True).start()
    threading.Thread(target=sender, daemon=True).start()
    log(f'somov-chat on 127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
