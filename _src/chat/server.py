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
only the country code is kept. A visitor who allows notifications gets a browser push (Web Push, encrypted
for their browser only) when the owner answers, even with the site closed. A visitor who leaves an email gets one
"we got your question" letter from me@somov.org (Gmail SMTP); it never carries what the visitor typed. Every answer
of the owner is also sent to that email (with the photo or file attached), and the owner's mailbox gets a copy of
every visitor message with Reply-To set to the visitor, one Gmail conversation per chat. Letters to visitors carry
an unsubscribe link (and List-Unsubscribe headers); after it, no more letters go to that conversation.
Mail to me@somov.org is read from Gmail (IMAP, read-only) and brought to Telegram as a conversation; the owner's
Telegram reply goes back as an email in the same thread. Mailing lists, auto-replies and no-reply senders are not
brought to Telegram; they stay in Gmail.
"""
import base64, csv, email, gzip, html, imaplib, smtplib, hashlib, io, ipaddress, json, os, re, secrets, socket, sqlite3, sys, threading, time, urllib.error, urllib.request
from email.message import EmailMessage
from email.policy import default as email_policy
from email.utils import formataddr, make_msgid, parseaddr
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
VAPID_PRIVATE = os.environ.get('VAPID_PRIVATE', '')   # base64url P-256 private number; signs the pushes
VAPID_PUBLIC = os.environ.get('VAPID_PUBLIC', '')     # base64url uncompressed public point; given to browsers
SMTP_USER = os.environ.get('GMAIL_USER', '')           # the Gmail account that has me@somov.org as "Send mail as"
SMTP_PASSWORD = os.environ.get('GMAIL_APP_PASSWORD', '').replace(' ', '')   # Google shows it in groups of four
MAIL_FROM = os.environ.get('MAIL_FROM', 'me@somov.org')
MAIL_PER_IP, MAIL_PER_DAY = 3, 50   # letters: anyone can type somebody else's address, so they are few
EMAIL_RE = re.compile(r'^[^@\s<>"]+@[^@\s<>"]+\.[A-Za-z]{2,}$')

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
if 'src' not in [row[1] for row in db.execute('PRAGMA table_info(messages)')]:   # 'mail': came by email
    db.execute("ALTER TABLE messages ADD COLUMN src TEXT NOT NULL DEFAULT ''")
if 'cc' not in [row[1] for row in db.execute('PRAGMA table_info(messages)')]:
    db.execute("ALTER TABLE messages ADD COLUMN cc TEXT NOT NULL DEFAULT ''")
thread_columns = [row[1] for row in db.execute('PRAGMA table_info(threads)')]
if 'mailed' not in thread_columns:
    db.execute("ALTER TABLE threads ADD COLUMN mailed TEXT NOT NULL DEFAULT ''")
if 'nomail' not in thread_columns:   # the visitor unsubscribed from letters
    db.execute('ALTER TABLE threads ADD COLUMN nomail INTEGER NOT NULL DEFAULT 0')
if 'unsub' not in thread_columns:    # random token of the unsubscribe link (the visitor id must stay secret)
    db.execute("ALTER TABLE threads ADD COLUMN unsub TEXT NOT NULL DEFAULT ''")
db.execute('CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, thread TEXT NOT NULL, p256dh TEXT NOT NULL, '
           'auth TEXT NOT NULL, t INTEGER NOT NULL)')
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
    threading.Thread(target=push, args=(thread, text, fid), daemon=True).start()
    threading.Thread(target=reply_letter, args=(thread, text, fid), daemon=True).start()
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
                for table in ('messages', 'files', 'tg', 'push'):
                    run(f'DELETE FROM {table} WHERE thread = ?', thread)
                run('DELETE FROM threads WHERE id = ?', thread)


# -- Browser notifications (Web Push: RFC 8291 encryption, RFC 8292 VAPID) -----

def b64d(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def b64e(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def push_ready():
    return bool(VAPID_PRIVATE and VAPID_PUBLIC)


def push_endpoint_ok(endpoint):
    """Only an https push service on the internet: the server must not be made to post into private networks."""
    url = urlsplit(endpoint)
    if url.scheme != 'https' or not url.hostname or url.port not in (None, 443) or len(endpoint) > 1000:
        return False
    try:
        ipaddress.ip_address(url.hostname)
        return False   # push services always have a name
    except ValueError:
        pass
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(url.hostname, 443, proto=socket.IPPROTO_TCP)}
    except OSError:
        return False
    return all(ipaddress.ip_address(a.split('%')[0]).is_global for a in addresses)


def push_encrypt(p256dh, auth, plaintext):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    def hkdf(salt, ikm, info, length):
        return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)

    browser_public = b64d(p256dh)
    own = ec.generate_private_key(ec.SECP256R1())
    own_public = own.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = own.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), browser_public))
    ikm = hkdf(b64d(auth), shared, b'WebPush: info\x00' + browser_public + own_public, 32)
    salt = os.urandom(16)
    key = hkdf(salt, ikm, b'Content-Encoding: aes128gcm\x00', 16)
    nonce = hkdf(salt, ikm, b'Content-Encoding: nonce\x00', 12)
    sealed = AESGCM(key).encrypt(nonce, plaintext + b'\x02', None)
    return salt + (4096).to_bytes(4, 'big') + bytes([len(own_public)]) + own_public + sealed


def vapid(endpoint):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    url = urlsplit(endpoint)
    head = b64e(json.dumps({'typ': 'JWT', 'alg': 'ES256'}).encode())
    claims = b64e(json.dumps({'aud': f'{url.scheme}://{url.netloc}', 'exp': int(time.time()) + 12 * 3600,
                              'sub': 'https://somov.org'}).encode())
    key = ec.derive_private_key(int.from_bytes(b64d(VAPID_PRIVATE), 'big'), ec.SECP256R1())
    r, s = decode_dss_signature(key.sign(f'{head}.{claims}'.encode(), ec.ECDSA(hashes.SHA256())))
    return f'vapid t={head}.{claims}.{b64e(r.to_bytes(32, "big") + s.to_bytes(32, "big"))}, k={VAPID_PUBLIC}'


def push(thread, text, fid):
    """Tells the visitor's browsers that the owner answered. Gone subscriptions are forgotten."""
    if not push_ready():
        return
    subscriptions = q('SELECT endpoint, p256dh, auth FROM push WHERE thread = ?', thread)
    if not subscriptions:
        return
    lang = (q('SELECT lang FROM threads WHERE id = ?', thread) or [('en',)])[0][0]
    photo = bool(fid) and bool(q('SELECT 1 FROM files WHERE id = ? AND image = 1', fid))
    if not text:
        text = ('📷 Фото' if photo else '📎 Файл') if lang == 'ru' else ('📷 Photo' if photo else '📎 File')
    body = json.dumps({'title': 'somov', 'body': text[:180] + ('…' if len(text) > 180 else '')},
                      ensure_ascii=False).encode()
    for endpoint, p256dh, auth in subscriptions:
        try:
            request = urllib.request.Request(endpoint, push_encrypt(p256dh, auth, body), {
                'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
                'TTL': '86400', 'Urgency': 'high', 'Authorization': vapid(endpoint)})
            urllib.request.urlopen(request, timeout=20).close()
        except urllib.error.HTTPError as error:
            if error.code in (404, 410):
                run('DELETE FROM push WHERE endpoint = ?', endpoint)
            else:
                log('push:', error.code, urlsplit(endpoint).hostname)
        except Exception as error:
            log('push:', type(error).__name__, urlsplit(endpoint).hostname)


def subscribe(visitor, data):
    if not push_ready() or not isinstance(data, dict) or not q('SELECT 1 FROM threads WHERE id = ?', visitor):
        return False
    endpoint, keys = str(data.get('endpoint', '')), data.get('keys') or {}
    try:
        p256dh, auth = str(keys['p256dh']), str(keys['auth'])
        if len(b64d(p256dh)) != 65 or len(b64d(auth)) != 16:
            return False
    except (KeyError, TypeError, ValueError):
        return False
    if not push_endpoint_ok(endpoint):
        return False
    with lock:
        db.execute('INSERT OR REPLACE INTO push (endpoint, thread, p256dh, auth, t) VALUES (?, ?, ?, ?, ?)',
                   (endpoint, visitor, p256dh, auth, int(time.time())))
        # at most 5 browsers per conversation: the oldest go
        db.execute('DELETE FROM push WHERE thread = ? AND endpoint NOT IN '
                   '(SELECT endpoint FROM push WHERE thread = ? ORDER BY t DESC LIMIT 5)', (visitor, visitor))
        db.commit()
    return True


# -- "We got your question" letter -------------------------------------------

LETTER = {
    'ru': ('Мы получили ваш вопрос — somov.org',
           'Здравствуйте!\n\n'
           'Спасибо, что написали в чат на somov.org. Мы получили ваш вопрос и ответим в ближайшее время: '
           'ответ придёт в чат на сайте и на эту почту.\n\n'
           'Чат на сайте (в том же браузере): https://somov.org/#chat\n\n'
           'Если вы ничего не писали на somov.org, просто не обращайте внимания на это письмо.\n\n'
           '— somov\nhttps://somov.org\n'),
    'en': ('We got your question — somov.org',
           'Hello!\n\n'
           'Thank you for writing in the chat on somov.org. We got your question and will answer soon: '
           'the answer will come to the chat on the site and to this email.\n\n'
           'The chat on the site (in the same browser): https://somov.org/#chat\n\n'
           'If you did not write anything on somov.org, please ignore this email.\n\n'
           '— somov\nhttps://somov.org\n'),
}
CONFIRM_BUBBLES = {
    'ru': ('Здравствуйте! Спасибо, что написали в чат на somov.org.<br><br>'
           'Мы получили ваш вопрос и ответим в ближайшее время — ответ придёт в чат на сайте и на эту почту.',
           'Если вы ничего не писали на somov.org, просто не обращайте внимания на это письмо.'),
    'en': ('Hello! Thank you for writing in the chat on somov.org.<br><br>'
           'We got your question and will answer soon — the answer will come to the chat on the site and to this email.',
           'If you did not write anything on somov.org, please ignore this email.'),
}
mail_hits = {}     # hash of IP -> [times]
mail_all = []      # times of all letters


def mail_allowed(ip):
    now = time.time()
    key = hashlib.sha256((salt + 'mail' + ip).encode()).hexdigest()[:24]
    with lock:
        mine = [t for t in mail_hits.get(key, []) if now - t < 86400]
        mail_all[:] = [t for t in mail_all if now - t < 86400]
        if len(mine) >= MAIL_PER_IP or len(mail_all) >= MAIL_PER_DAY:
            mail_hits[key] = mine
            return False
        mine.append(now)
        mail_all.append(now)
        mail_hits[key] = mine
        return True


UNSUB_URL = 'https://dl.somov.org/api/chat/unsubscribe?t='
UNSUB_TEXT = {'ru': 'Больше не присылать письма об этой переписке: ', 'en': 'Stop emails about this conversation: '}


def unsub_link(thread):
    token = (q('SELECT unsub FROM threads WHERE id = ?', thread) or [('',)])[0][0]
    if not token:
        token = secrets.token_urlsafe(18)
        run('UPDATE threads SET unsub = ? WHERE id = ?', token, thread)
    return UNSUB_URL + token


FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
HTML_TEXT = {
    'ru': {'open': 'Открыть чат', 'reply': 'Ответить можно прямо на это письмо', 'unsub': 'Больше не присылать письма'},
    'en': {'open': 'Open the chat', 'reply': 'You can reply right to this email', 'unsub': 'Stop these emails'},
}


def html_text(text):
    """Escaped text with line breaks and clickable links."""
    out = html.escape(text).replace('\n', '<br>')
    return re.sub(r'(https?://[^\s<]+[^\s<.,;:!?)])',
                  r'<a href="\1" style="color:#2563eb;text-decoration:none">\1</a>', out)


def bubble(inner, note=False):
    """One message from somov on the left, like in the chat window; note=True: a quiet line under it."""
    if note:
        return (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td '
                f'style="padding:10px 4px 0;color:#8b919a;font:13px/1.5 {FONT}">{inner}</td></tr></table>')
    return (f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px"><tr>'
            f'<td bgcolor="#eef1f5" style="background:#eef1f5;border-radius:18px 18px 18px 6px;padding:10px 14px;'
            f'color:#14171c;font:15px/1.55 {FONT};max-width:400px">{inner}</td></tr></table>')


def letter_html(lang, subject, bubbles, unsub, chat=True):
    """The whole letter: a white card with the chat header, the bubbles, a button to the chat and a quiet footer.
    Light, like the letters of messengers: on Gmail's white page a dark block looks heavy, and mail apps darken
    a light letter themselves in their dark mode. Tables and inline styles only: all mail apps show them the same."""
    t = HTML_TEXT['ru' if lang == 'ru' else 'en']
    sub = {'ru': 'чат на сайте', 'en': 'chat on the site'}['ru' if lang == 'ru' else 'en']
    button = (f'<a href="https://somov.org/#chat" style="display:inline-block;padding:12px 28px;border-radius:999px;'
              f'background:#2563eb;color:#ffffff;font:600 14px/1 {FONT};text-decoration:none">{t["open"]}</a>'
              f'<div style="padding-top:12px;color:#8b919a;font:13px/1.4 {FONT}">{t["reply"]}</div>'
              if chat else f'<div style="color:#8b919a;font:13px/1.4 {FONT}">{t["reply"]}</div>')
    # The site name is a link styled grey on purpose: as plain text Gmail turns it into a blue underlined link itself
    site = '<a href="https://somov.org" style="color:#9aa0a6;text-decoration:none">somov.org</a>'
    unsub_line = (f' &nbsp;·&nbsp; <a href="{unsub}" style="color:#9aa0a6;text-decoration:underline">{t["unsub"]}</a>'
                  if unsub else '')
    return f"""<!doctype html>
<html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>{html.escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7" bgcolor="#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f5f7" style="background:#f4f5f7"><tr>
<td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff"
 style="max-width:460px;background:#ffffff;border:1px solid #e6e8eb;border-radius:20px;border-collapse:separate">
<tr><td style="padding:20px 22px 16px;border-bottom:1px solid #f0f1f3">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td width="38" height="38" align="center" valign="middle" bgcolor="#6d6cf2"
 style="width:38px;height:38px;border-radius:19px;background:#6d6cf2;background-image:linear-gradient(135deg,#3a8dff,#a855f7);color:#ffffff;font:700 16px/38px {FONT}">S</td>
<td style="padding-left:12px"><div style="color:#14171c;font:600 15px/1.3 {FONT}">somov</div>
<div style="color:#8b919a;font:13px/1.3 {FONT}">{sub}</div></td>
</tr></table></td></tr>
<tr><td style="padding:22px 22px 8px">{''.join(bubbles)}</td></tr>
<tr><td align="center" style="padding:18px 22px 26px">{button}</td></tr>
</table>
<div style="padding-top:18px;color:#9aa0a6;font:12px/1.5 {FONT}">{site}{unsub_line}</div>
</td></tr></table></body></html>"""


def visitor_letter(thread, lang, contact, subject, body, unsub=True):
    """A letter to the visitor, with the unsubscribe line and the headers mail apps show as their own button."""
    letter = EmailMessage()
    if not unsub:   # a plain answer to someone who wrote to me@somov.org
        letter['From'] = formataddr(('somov', MAIL_FROM))
        letter['To'] = contact
        letter['Subject'] = subject
        letter['Message-ID'] = make_msgid(domain='somov.org')
        letter.set_content(f'{body}\n\n—\nsomov\nhttps://somov.org\n')
        return letter
    link = unsub_link(thread)
    letter['From'] = formataddr(('somov', MAIL_FROM))
    letter['To'] = contact
    letter['Subject'] = subject
    letter['Reply-To'] = MAIL_FROM
    letter['Message-ID'] = make_msgid(domain='somov.org')
    letter['List-Unsubscribe'] = f'<{link}>'
    letter['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
    letter.set_content(f'{body}\n\n{UNSUB_TEXT["ru" if lang == "ru" else "en"]}{link}\n')
    return letter


def unsubscribe(token, really):
    """(language, state) of an unsubscribe link: 'bad', 'ready' (GET) or 'done'."""
    if not re.fullmatch(r'[A-Za-z0-9_-]{20,40}', token or ''):
        return 'en', 'bad'
    row = q('SELECT id, n, lang, nomail, contact FROM threads WHERE unsub = ?', token)
    if not row:
        return 'en', 'bad'
    thread, n, lang, nomail, contact = row[0]
    if not really:
        return lang, 'done' if nomail else 'ready'
    if not nomail:
        run('UPDATE threads SET nomail = 1 WHERE id = ?', thread)

        def tell():
            try:
                who = f' {contact}' if contact else ''
                sent = say(f'📭 #{n}: посетитель{who} отписался от писем (чат на сайте работает)')
                run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', sent['message_id'], thread)
            except RuntimeError as error:
                log('unsubscribe note:', error)
        threading.Thread(target=tell, daemon=True).start()
    return lang, 'done'


UNSUB_PAGE = {
    'ru': {'title': 'Письма от somov.org', 'ready': 'Больше не присылать письма об этой переписке?',
           'button': 'Не присылать', 'done': 'Готово: писем больше не будет. Чат на сайте работает как прежде.',
           'bad': 'Ссылка устарела или неверна.'},
    'en': {'title': 'Emails from somov.org', 'ready': 'Stop emails about this conversation?',
           'button': 'Stop emails', 'done': 'Done: no more emails. The chat on the site works as before.',
           'bad': 'The link is old or wrong.'},
}


def unsub_page(lang, stage):
    t = UNSUB_PAGE['ru' if lang == 'ru' else 'en']
    action = ('<form method="post"><button type="submit">' + t['button'] + '</button></form>') if stage == 'ready' else ''
    return f"""<!doctype html><html lang="{lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>{t['title']}</title><style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#f0f2f5;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{max-width:360px;padding:28px 24px;margin:16px;border:1px solid rgb(255 255 255/.11);border-radius:16px;
background:#171a21;text-align:center}}p{{margin:0 0 18px}}a{{color:#8fb4ff}}
button{{padding:10px 22px;border:0;border-radius:999px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer}}
</style></head><body><main><p>{t[stage]}</p>{action}<p style="margin:18px 0 0;font-size:14px">
<a href="https://somov.org/">somov.org</a></p></main></body></html>"""


def send_letter(letter):
    try:
        with smtplib.SMTP('smtp.gmail.com', 587, timeout=60) as smtp:
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(letter)
        return True
    except (smtplib.SMTPException, OSError) as error:
        log('mail:', type(error).__name__, str(error)[:160])
        return False


REPLY = {
    'ru': ('Ответ на ваш вопрос — somov.org',
           'Ответить можно прямо на это письмо или в чате на сайте (в том же браузере): https://somov.org/#chat'),
    'en': ('Answer to your question — somov.org',
           'You can reply to this email or in the chat on the site (in the same browser): https://somov.org/#chat'),
}


def reply_letter(thread, text, fid):
    """The owner's answer, also by email when the visitor left one (the answer is the owner's, so no limits)."""
    if not (SMTP_USER and SMTP_PASSWORD):
        return
    row = q('SELECT n, contact, lang, nomail FROM threads WHERE id = ?', thread)
    if not row or not EMAIL_RE.match(row[0][1]):
        return
    n, contact, lang, nomail = row[0]
    if nomail:   # say where the answer went, or the owner would think it went by email
        on_site = q("SELECT 1 FROM messages WHERE thread = ? AND owner = 0 AND src = '' LIMIT 1", thread)
        say(f'📭 #{n}: {contact} отписался от писем — ' + (
            'ответ виден только в чате на сайте' if on_site else
            'ответ никуда не ушёл (он писал только на почту). Ответить можно из Gmail'))
        return
    subject, footer = REPLY['ru' if lang == 'ru' else 'en']
    origin = state(f'mailmsgid:{thread}')
    if origin:   # they wrote by email: answer in that email thread, like a person does
        theirs = state(f'mailsubj:{thread}') or ''
        subject = theirs if re.match(r'(?i)(re|ответ)\s*:', theirs) else (f'Re: {theirs}' if theirs else 'Re: somov.org')
        letter = visitor_letter(thread, lang, contact, subject, f'{text}\n\n—\nsomov\nhttps://somov.org')
        letter['In-Reply-To'] = origin
        letter['References'] = ((state(f'mailrefs:{thread}') or '') + ' ' + origin).strip()
    else:
        letter = visitor_letter(thread, lang, contact, subject, f'{text}\n\n—\n{footer}' if text else footer)
    stored = q('SELECT name, mime, size, image FROM files WHERE id = ?', fid) if fid else []
    data = b''
    if stored:
        try:
            with open(os.path.join(FILES_DIR, fid), 'rb') as source:
                data = source.read()
        except OSError as error:
            log('mail file:', error)
            stored = []
    bubbles, cid = [], ''
    if stored:
        name, mime, size, image = stored[0]
        if image:
            cid = make_msgid(domain='somov.org')
            bubbles.append(bubble(f'<img src="cid:{cid[1:-1]}" alt="{html.escape(name)}" width="300" '
                                  f'style="display:block;width:100%;max-width:300px;height:auto;border-radius:11px">'))
        else:
            bubbles.append(bubble(f'📎 <b>{html.escape(name)}</b> <span style="color:#8a96a3">· {size_text(size)}</span>'))
    if text:
        bubbles.append(bubble(html_text(text)))
    letter.add_alternative(letter_html(lang, subject, bubbles, unsub_link(thread)), subtype="html")   # the chat button always
    if stored:
        name, mime, size, image = stored[0]
        main, _, sub = mime.partition('/')
        if cid:   # the picture lives inside the HTML part
            letter.get_body(('html',)).add_related(data, maintype=main, subtype=sub, cid=cid, filename=name)
        else:
            letter.add_attachment(data, maintype=main, subtype=sub or 'octet-stream', filename=name)
    if not send_letter(letter):
        say(f'⚠️ #{n}: не удалось отправить ответ на почту {contact}')
        return
    if not origin and not state(f'mailnote:{thread}'):   # said once per conversation, then quietly
        state(f'mailnote:{thread}', 1)
        sent = say(f'📧 #{n}: ваши ответы в этой переписке дублируются на почту {contact}')
        run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', sent['message_id'], thread)


copy_lock = threading.Lock()


def copy_to_owner(thread):
    """Visitor messages not yet copied, in one letter to the owner's mailbox (only for a visitor with an email).
    Header To is me@somov.org, so Gmail answers from that address; the letter itself goes straight to the Gmail
    account (a letter to oneself through the me@somov.org forwarding would be swallowed by Gmail)."""
    if not (SMTP_USER and SMTP_PASSWORD):
        return
    with copy_lock:
        row = q('SELECT n, contact, cc FROM threads t LEFT JOIN (SELECT thread, cc FROM messages WHERE thread = ? '
                'AND owner = 0 ORDER BY id DESC LIMIT 1) m ON m.thread = t.id WHERE t.id = ?', thread, thread)
        if not row or not EMAIL_RE.match(row[0][1]):
            return
        n, contact, cc = row[0]
        done = int(state(f'copied:{thread}') or 0)
        rows = q('SELECT m.id, m.text, m.page, m.t, f.id, f.name, f.mime FROM messages m LEFT JOIN files f ON f.id = m.file '
                 'WHERE m.thread = ? AND m.owner = 0 AND m.src = \'\' AND m.id > ? ORDER BY m.id', thread, done)
        if not rows:
            return
        # Only the visitor's own words: when the owner answers from Gmail, Gmail quotes this letter to the visitor,
        # so nothing meant for the owner (numbers, hints, country) may be in it. All of that is in Telegram.
        parts, files = [], []
        for mid, text, page, t, fid, name, mime in rows:
            if text:
                parts.append(text)
            if fid:
                files.append((fid, name, mime))
        root = state(f'mailroot:{thread}')
        letter = EmailMessage()
        letter['From'] = formataddr((contact, MAIL_FROM))
        letter['To'] = MAIL_FROM
        letter['Reply-To'] = contact
        letter['Subject'] = 'Сообщение с somov.org' if (q('SELECT lang FROM threads WHERE id = ?', thread)
                                                         or [('ru',)])[0][0] == 'ru' else 'Message from somov.org'
        letter['Message-ID'] = make_msgid(domain='somov.org')
        if root:
            letter['In-Reply-To'] = root
            letter['References'] = root
        letter.set_content('\n\n'.join(parts) + '\n' if parts else '\n')
        for fid, name, mime in files:
            try:
                with open(os.path.join(FILES_DIR, fid), 'rb') as source:
                    main, _, sub = mime.partition('/')
                    letter.add_attachment(source.read(), maintype=main, subtype=sub or 'octet-stream', filename=name)
            except OSError as error:
                log('copy file:', error)
        try:
            with smtplib.SMTP('smtp.gmail.com', 587, timeout=60) as smtp:
                smtp.starttls()
                smtp.login(SMTP_USER, SMTP_PASSWORD)
                smtp.send_message(letter, to_addrs=[SMTP_USER])
        except (smtplib.SMTPException, OSError) as error:
            log('copy:', type(error).__name__, str(error)[:160])
            return
        if not root:
            state(f'mailroot:{thread}', letter['Message-ID'])
        state(f'copied:{thread}', rows[-1][0])


def confirm_letter(thread, ip):
    """Sends the letter once to an email the visitor left; tells the owner it went out."""
    if not (SMTP_USER and SMTP_PASSWORD):
        return
    row = q('SELECT n, contact, lang, mailed, nomail FROM threads WHERE id = ?', thread)
    if not row:
        return
    n, contact, lang, mailed, nomail = row[0]
    if nomail or not EMAIL_RE.match(contact) or contact.lower() == mailed.lower():
        return
    if not mail_allowed(ip):
        log('mail: limit')
        return
    subject, body = LETTER['ru' if lang == 'ru' else 'en']
    letter = visitor_letter(thread, lang, contact, subject, body.rstrip('\n'))
    hello, ignore = CONFIRM_BUBBLES['ru' if lang == 'ru' else 'en']
    letter.add_alternative(letter_html(lang, subject, [bubble(hello), bubble(ignore, note=True)],
                                       unsub_link(thread)), subtype='html')
    letter['Auto-Submitted'] = 'auto-replied'
    if not send_letter(letter):
        return
    run('UPDATE threads SET mailed = ? WHERE id = ?', contact, thread)
    try:
        sent = say(f'📧 #{n}: письмо «мы получили ваш вопрос» отправлено на {contact}')
        run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', sent['message_id'], thread)
    except RuntimeError as error:
        log('mail note:', error)


def letter_later(thread, ip):
    def both():
        confirm_letter(thread, ip)
        copy_to_owner(thread)
    threading.Thread(target=both, daemon=True).start()


# -- Mail to me@somov.org -> Telegram (Gmail IMAP, read-only) ----------------

NOT_PERSON = re.compile(r'^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|'
                        r'newsletters?|news|digest|marketing|promo)([+._-].*)?$', re.I)
QUOTE_START = re.compile(r'^(On .{5,200} wrote:|.{0,80}\d{4}.{0,80}<[^>\s]+@[^>\s]+>.{0,20}:|'
                         r'-{2,} ?(Original Message|Исходное сообщение|Пересылаемое сообщение|Forwarded message) ?-{2,})\s*$',
                         re.I)


def not_person(letter, sender):
    """Why a letter is not from a person ('' when it is). Only sure signs: better to bring one ad than lose a person."""
    if letter.get('List-Unsubscribe') or letter.get('List-Id') or letter.get('List-Post'):
        return 'рассылка'
    if (letter.get('Precedence') or '').strip().lower() in ('bulk', 'list', 'junk'):
        return 'рассылка'
    if (letter.get('Auto-Submitted') or 'no').strip().lower() != 'no':
        return 'автоответ'
    if NOT_PERSON.match(sender.split('@')[0]):
        return 'служебный адрес'
    return ''


def letter_text(letter):
    """Plain text of a letter, without the quoted earlier letters."""
    part = letter.get_body(preferencelist=('plain', 'html'))
    if part is None:
        return ''
    try:
        text = part.get_content()
    except (LookupError, ValueError):
        text = part.get_payload(decode=True).decode('utf-8', 'replace')
    if part.get_content_type() == 'text/html':
        text = re.sub(r'(?is)<(script|style|head)\b.*?</\1>', '', text)
        text = re.sub(r'(?is)<blockquote.*', '', text)   # the quoted earlier letters
        text = re.sub(r'(?i)<br\s*/?>|</(p|div|li|tr|h\d)>', '\n', text)
        text = html.unescape(re.sub(r'<[^>]+>', '', text)).replace('\xa0', ' ')
    lines = []
    for line in text.replace('\r\n', '\n').split('\n'):
        if line.startswith('>') or QUOTE_START.match(line.strip()):
            break
        lines.append(line.rstrip())
    return re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()


def mail_thread(sender, text):
    """The conversation of this address: a chat visitor who left it, or a new one."""
    row = q('SELECT id, n FROM threads WHERE lower(contact) = ? ORDER BY active DESC LIMIT 1', sender.lower())
    if row:
        return row[0][0], row[0][1], False
    thread, now = secrets.token_hex(16), int(time.time())
    lang = 'ru' if re.search('[а-яё]', text, re.I) else 'en'
    with lock:
        n = db.execute('SELECT COALESCE(MAX(n), 0) + 1 FROM threads').fetchone()[0]
        db.execute('INSERT INTO threads (id, n, contact, lang, created, active) VALUES (?, ?, ?, ?, ?, ?)',
                   (thread, n, sender, lang, now, now))
        db.commit()
    return thread, n, True


def bring_letter(raw):
    letter = email.message_from_bytes(raw, policy=email_policy)
    name, sender = parseaddr(str(letter.get('From', '')))
    sender = sender.strip()
    own = str(letter.get('Message-ID', '')).strip().endswith('@somov.org>') or MAIL_FROM.lower() in str(letter.get('From', '')).lower()
    if not sender or own or sender.lower() in (MAIL_FROM.lower(), SMTP_USER.lower()):
        return   # our own letters (all made here carry @somov.org Message-IDs): copies of the chat, answers
    if not_person(letter, sender):
        return   # stays in Gmail; the owner asked for no summaries in Telegram
    subject = str(letter.get('Subject', '') or '').strip()
    text = letter_text(letter)
    thread, n, new = mail_thread(sender, f'{subject} {text}')
    msgid = str(letter.get('Message-ID', '') or '').strip()
    if msgid:
        state(f'mailmsgid:{thread}', msgid)
        state(f'mailrefs:{thread}', str(letter.get('References', '') or '').strip()[-900:])
    state(f'mailsubj:{thread}', subject[:200])
    now = int(time.time())
    who = f'{name} <{sender}>' if name else sender
    head = f'📨 #{n} · письмо' + (' · новый собеседник' if new else '')
    body = '\n'.join(x for x in (head, f'От: {who}', f'Тема: {subject}' if subject else '', '', text) if x is not None)
    ids = []
    try:
        ids.append(say(body.strip()[:4000])['message_id'])
    except RuntimeError as error:
        log('mail to telegram:', error)
        return False
    run('INSERT INTO messages (thread, owner, text, page, t, sent, src) VALUES (?, 0, ?, ?, ?, 1, ?)',
        thread, (f'{subject}\n\n{text}' if subject else text)[:MAX_TEXT * 2], 'email', now, 'mail')
    for part in letter.iter_attachments():
        data = part.get_payload(decode=True) or b''
        if not data or len(data) > OWNER_FILE or files_total() + len(data) > FILES_TOTAL:
            continue
        fname = part.get_filename() or 'file'
        fid = store_file(thread, fname, data)
        stored = q('SELECT name, mime, image FROM files WHERE id = ?', fid)[0]
        run('INSERT INTO messages (thread, owner, text, page, t, sent, src, file) VALUES (?, 0, ?, ?, ?, 1, ?, ?)',
            thread, '', 'email', now, 'mail', fid)
        try:
            if stored[2]:
                sent = tg_upload('sendPhoto', 'photo', stored[0], data, stored[1], chat_id=OWNER, caption=f'📎 #{n}')
            else:
                sent = tg_upload('sendDocument', 'document', stored[0], data, stored[1], chat_id=OWNER, caption=f'📎 #{n}')
            ids.append(sent['message_id'])
        except RuntimeError as error:
            log('mail file to telegram:', error)
    for mid in ids:
        run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', mid, thread)
    run('UPDATE threads SET active = ?, nomail = 0 WHERE id = ?', now, thread)
    return True


def mailbox():
    """Every minute: new letters to me@somov.org in the Gmail inbox. Gmail marks nothing: the box is opened read-only
    and bodies are read with PEEK. The first run only remembers where the inbox is, so old mail is not brought."""
    while True:
        time.sleep(60)
        if not (SMTP_USER and SMTP_PASSWORD):
            continue
        try:
            box = imaplib.IMAP4_SSL('imap.gmail.com', 993, timeout=60)
            try:
                box.login(SMTP_USER, SMTP_PASSWORD)
                box.select('INBOX', readonly=True)
                validity = box.response('UIDVALIDITY')[1][0].decode()
                last = int(state('mailuid') or 0) if state('mailvalidity') == validity else 0
                found = box.uid('SEARCH', None, 'X-GM-RAW', f'"to:{MAIL_FROM}"')[1][0].split()
                uids = sorted(int(u) for u in found)
                if not last:   # first look (or Gmail renumbered the box): start from now on
                    state('mailvalidity', validity)
                    state('mailuid', uids[-1] if uids else 1)
                    continue
                for uid in [u for u in uids if u > last][:20]:
                    raw = box.uid('FETCH', str(uid), '(BODY.PEEK[])')[1][0][1]
                    if bring_letter(raw) is False:
                        break   # Telegram is unreachable: try this letter again next minute
                    state('mailuid', uid)
            finally:
                try:
                    box.logout()
                except Exception:
                    pass
        except Exception as error:
            log('mailbox:', type(error).__name__, str(error)[:160])


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


def set_contact(visitor, contact):
    """A visitor left (or changed, or removed) a contact after the conversation started: tell the owner."""
    row = q('SELECT n, contact FROM threads WHERE id = ?', visitor)
    if not row:
        return False
    n, old = row[0]
    if contact == old:
        return True
    run('UPDATE threads SET contact = ?, nomail = 0 WHERE id = ?', contact, visitor)

    def tell():
        try:
            sent = say(f'✉️ #{n}: контакт — {contact}' if contact else f'✉️ #{n}: контакт удалён')
            run('INSERT OR REPLACE INTO tg (msg, thread) VALUES (?, ?)', sent['message_id'], visitor)
        except RuntimeError as error:
            log('contact:', error)
    threading.Thread(target=tell, daemon=True).start()
    return True


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

    def page(self, code, html):
        body = html.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
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
        if path == '/api/chat/unsubscribe':
            lang, stage = unsubscribe(params.get('t', ''), False)
            return self.page(200 if stage != 'bad' else 404, unsub_page(lang, stage))
        if path == '/api/chat/push-key':
            return self.reply(200, {'key': VAPID_PUBLIC if push_ready() else ''})
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
        if path == '/api/chat/unsubscribe':
            self.body(MAX_BODY)   # Gmail's one-click sends "List-Unsubscribe=One-Click"
            lang, stage = unsubscribe(self.params().get('t', ''), True)
            return self.page(200 if stage != 'bad' else 404, unsub_page(lang, stage))
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
            letter_later(visitor, ip)
            return self.reply(200, {'id': mid, 't': now, 'file': file_view(fid, *row)})
        if path == '/api/chat/subscribe':
            visitor = self.params().get('v', '')
            raw = self.body(MAX_BODY)
            try:
                data = json.loads(raw) if raw else None
            except ValueError:
                data = None
            if not VISITOR_RE.match(visitor) or not allowed(ip):
                return self.reply(400, {'error': 'visitor'})
            return self.reply(200 if subscribe(visitor, data) else 400, {})
        if path == '/api/chat/contact':
            visitor = self.params().get('v', '')
            raw = self.body(MAX_BODY)
            try:
                data = json.loads(raw) if raw else None
            except ValueError:
                data = None
            if not VISITOR_RE.match(visitor) or not isinstance(data, dict):
                return self.reply(400, {'error': 'body'})
            if not allowed(ip):
                return self.reply(429, {'error': 'limit'})
            if not set_contact(visitor, clean(data.get('contact'), MAX_CONTACT).replace('\n', ' ')):
                return self.reply(404, {})
            letter_later(visitor, ip)
            return self.reply(200, {})
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
        letter_later(visitor, ip)
        self.reply(200, {'id': mid, 't': now})


if __name__ == '__main__':
    geo_open()
    threading.Thread(target=updates, daemon=True).start()
    threading.Thread(target=sender, daemon=True).start()
    threading.Thread(target=mailbox, daemon=True).start()
    log(f'somov-chat on 127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
