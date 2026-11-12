#!/usr/bin/env python3
"""Owner-only statistics of somov.org: https://dl3.somov.org/stats/

Reads the nginx access logs of dl3 (they keep a year): every file download and every report the site sends to the
counter (page views with the source and language, Telegram and chat clicks, tweak actions, Share menu, magnets).
Every 5 minutes it turns them into daily numbers in stats.db; on the first start it goes through all the logs.

The rules are those of the counter (somov-counter): a person is counted once a day per thing ("unique"), every
action also goes to "total"; the owner (IPs and device keys from /etc/somov-counter.env, the IPs removed with
somov-forget-ip), dl3 itself and robots are never counted. Robots: the word in the browser name, the name of the
address (Googlebot, Yandex...), and an address that takes more than 10 different files in 10 seconds without coming
from the site. IP addresses are never stored: only daily numbers per page, file, country, source, device.

Countries come from a local copy of the free DB-IP database (refreshed monthly, no outside service is asked).
Day boundaries are Vietnam time, like the rest of the owner's logs.
"""
import csv, gzip, hashlib, html, io, ipaddress, json, os, re, secrets, socket, sqlite3, sys, threading, time
import urllib.error, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

PORT = int(os.environ.get('PORT', '8096'))
STATE = os.environ.get('STATE_DIRECTORY', '/var/lib/somov-stats')
DB_PATH = os.path.join(STATE, 'stats.db')
GEO_DB = os.path.join(STATE, 'geoip.db')
GEO_URL = 'https://download.db-ip.com/free/dbip-country-lite-{}.csv.gz'   # CC BY 4.0, IP Geolocation by DB-IP
HERE = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = '/var/log/nginx'
FILES = '/var/www/html'                      # what exists here is a download
KEYS_URL = 'https://somov.org/counter-keys.json'
COUNTER_CODE = '/opt/somov-counter/server.py'
FORGOTTEN = '/var/lib/somov-forget-ip.json'
TZ = timezone(timedelta(hours=7))            # Vietnam
OWNER_IPS = {x for x in os.environ.get('OWNER_IPS', '').split(',') if x}
OWNER_TOKENS = {x for x in os.environ.get('OWNER_TOKENS', '').split(',') if len(x) >= 16}
SELF_IPS = {'89.110.97.213', '127.0.0.1', '::1', '193.123.38.60'}   # dl3 itself, the owner's uptime monitor
BOT = re.compile(r'bot|crawl|spider|slurp|preview|headless|lighthouse|scanner|facebookexternalhit|dalvik', re.I)
LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) \S+ "([^"]*)" "([^"]*)"')
SESSION_GAP, BURST_FILES, BURST_WINDOW = 1800, 10, 10
# The statistics start when the site counter started (6 Nov 2026, 22:44 Moscow = 7 Nov, 02:44 Vietnam): earlier log
# lines are not counted, so the page and the counter tell the same numbers
COUNT_FROM = datetime(2026, 11, 6, 22, 44, 23, tzinfo=timezone(timedelta(hours=3))).timestamp()
REFRESH = 300


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


os.makedirs(STATE, exist_ok=True)
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.executescript('''
CREATE TABLE IF NOT EXISTS agg (day TEXT NOT NULL, metric TEXT NOT NULL, key TEXT NOT NULL,
  uniq INTEGER NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (day, metric, key));
CREATE TABLE IF NOT EXISTS feed (day TEXT NOT NULL, t INTEGER NOT NULL, cc TEXT NOT NULL, what TEXT NOT NULL,
  key TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS feed_day ON feed (day, t);
CREATE TABLE IF NOT EXISTS done (day TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS hosts (h TEXT PRIMARY KEY, host TEXT NOT NULL, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
''')
db.commit()
lock = threading.Lock()


def q(sql, *args):
    with lock:
        return db.execute(sql, args).fetchall()


def state(key, value=None):
    if value is None:
        row = q('SELECT v FROM state WHERE k = ?', key)
        return row[0][0] if row else None
    with lock:
        db.execute('INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)', (key, str(value)))
        db.commit()


SALT = state('salt') or secrets.token_hex(16)   # for the robot-name cache only: no IP is written anywhere
state('salt', SALT)


def robot_hosts():
    """The list of robot address names, read from the counter so the two never disagree."""
    try:
        source = open(COUNTER_CODE, encoding='utf-8').read()
        return tuple(re.findall(r"'([^']+)'", re.search(r'ROBOT_HOSTS = \((.*?)\)', source, re.S).group(1)))
    except (OSError, AttributeError):
        return ('.spider.yandex.com', '.fbsv.net', '.googlebot.com', '.search.msn.com')


# -- Countries (local DB-IP copy) ---------------------------------------------

geo_lock = threading.Lock()
geo = None


def geo_open():
    global geo
    with geo_lock:
        geo = sqlite3.connect(f'file:{GEO_DB}?mode=ro', uri=True, check_same_thread=False) if os.path.exists(GEO_DB) else None


def geo_update():
    if os.path.exists(GEO_DB) and time.time() - os.path.getmtime(GEO_DB) < 32 * 86400:
        return
    now = time.gmtime()
    months = [f'{now.tm_year}-{now.tm_mon:02d}', f'{now.tm_year - (now.tm_mon == 1)}-{(now.tm_mon - 2) % 12 + 1:02d}']
    for month in months:
        try:
            request = urllib.request.Request(GEO_URL.format(month), headers={'User-Agent': 'somov-stats/1.0'})
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
    v4, v6 = [], []
    for first, last, cc in csv.reader(io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(packed)), 'ascii')):
        a, b = ipaddress.ip_address(first), ipaddress.ip_address(last)
        (v4 if a.version == 4 else v6).append((int(a), int(b), cc) if a.version == 4 else (a.packed, b.packed, cc))
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
    log('geoip', month)


def country(ip):
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


# -- Robots by the name of the address -----------------------------------------

def host_of(ip, cache):
    h = hashlib.sha256((SALT + ip).encode()).hexdigest()[:24]
    if h in cache:
        return cache[h]
    row = q('SELECT host, t FROM hosts WHERE h = ?', h)
    if row and time.time() - row[0][1] < 30 * 86400:
        cache[h] = row[0][0]
        return row[0][0]
    try:
        name = socket.gethostbyaddr(ip)[0].lower()
    except OSError:
        name = ''
    cache[h] = name
    with lock:
        db.execute('INSERT OR REPLACE INTO hosts (h, host, t) VALUES (?, ?, ?)', (h, name, int(time.time())))
        db.commit()
    return name


# -- Devices ----------------------------------------------------------------------

def device_of(ua):
    if re.search(r'iPhone|iPad|iPod', ua):
        system = 'iOS'
    elif 'Android' in ua:
        system = 'Android'
    elif 'Windows' in ua:
        system = 'Windows'
    elif 'Mac OS X' in ua or 'Macintosh' in ua:
        system = 'macOS'
    elif 'Linux' in ua or 'X11' in ua:
        system = 'Linux'
    else:
        system = 'Другое'
    for pattern, name in ((r'YaBrowser|YaSearchBrowser', 'Яндекс Браузер'), (r'Edg/|EdgA/|EdgiOS/', 'Edge'),
                          (r'OPR/|Opera', 'Opera'), (r'SamsungBrowser', 'Samsung Internet'), (r'Telegram', 'Telegram'),
                          (r'Firefox/|FxiOS/', 'Firefox'), (r'Chrome/|CriOS/', 'Chrome'), (r'Safari/', 'Safari')):
        if re.search(pattern, ua):
            browser = name
            break
    else:
        browser = 'Другой'
    mobile = 'Телефон' if re.search(r'Mobile|Android|iPhone|iPod', ua) and 'iPad' not in ua else 'Компьютер'
    if 'iPad' in ua or ('Android' in ua and 'Mobile' not in ua):
        mobile = 'Планшет'
    return system, browser, mobile


# -- Reading the logs -------------------------------------------------------------

def log_files():
    """All nginx access logs, oldest first."""
    found = []
    for name in os.listdir(LOG_DIR):
        m = re.fullmatch(r'access\.log(?:\.(\d+))?(\.gz)?', name)
        if m:
            found.append((int(m.group(1) or 0), os.path.join(LOG_DIR, name)))
    return [path for _, path in sorted(found, reverse=True)]


def read_lines(path):
    opener = gzip.open if path.endswith('.gz') else open
    try:
        with opener(path, 'rt', errors='replace') as f:
            yield from f
    except OSError as error:
        log('read', path, error)


def known_files():
    """Tweak files -> their tweak, from the site (the counter's list), to show tweak names."""
    try:
        with urllib.request.urlopen(urllib.request.Request(KEYS_URL, headers={'User-Agent': 'somov-stats'}), timeout=15) as r:
            return json.loads(r.read(1_000_000)).get('files', {})
    except Exception:
        return json.loads(state('keyfiles') or '{}')


def events_of(lines, days, excluded, robots):
    """Visitor actions of the given days (Vietnam dates), robots and the owner left out."""
    out = defaultdict(list)   # day -> [(t, ip, kind, key, sub, extra)]
    cache = {}
    for line in lines:
        m = LINE.match(line)
        if not m:
            continue
        ip, ts, method, target, status, referer, ua = m.groups()
        try:
            t = datetime.strptime(ts, '%d/%b/%Y:%H:%M:%S %z').astimezone(TZ)
        except ValueError:
            continue
        day = t.strftime('%Y-%m-%d')
        if t.timestamp() < COUNT_FROM or day not in days or ip in excluded or ip.startswith('113.185.'):
            continue
        if BOT.search(ua):
            continue
        url = urlsplit(target)
        status = int(status)
        stamp = int(t.timestamp())
        if method == 'POST' and url.path == '/api/count' and status == 204:
            p = {k: v[0] for k, v in parse_qs(url.query).items()}
            if p.get('owner') in OWNER_TOKENS:
                continue
            kind = p.get('kind', '')
            if p.get('page') and kind == 'view':
                out[day].append((stamp, ip, 'view', p['page'], p.get('src', ''), p.get('lang', ''), ua))
            elif p.get('tg'):
                out[day].append((stamp, ip, 'tg', p['tg'], '', '', ua))
            elif p.get('chat'):
                out[day].append((stamp, ip, 'chat', p['chat'], '', '', ua))
            elif p.get('share'):
                out[day].append((stamp, ip, 'share', p['share'], p.get('on', ''), '', ua))
            elif p.get('tweak'):
                out[day].append((stamp, ip, 'tweak', p['tweak'], kind, '', ua))
            elif kind == 'magnet' and p.get('file'):
                out[day].append((stamp, ip, 'dl', p['file'], 'magnet', 'site', ua))
        elif method == 'GET' and not url.path.startswith('/api/') and status in (200, 206, 304):
            name = os.path.basename(unquote(url.path))
            if not name:
                continue
            torrent = name.lower().endswith('.torrent')
            file = name[:-len('.torrent')] if torrent else name
            if not os.path.isfile(os.path.join(FILES, file)) and not os.path.isfile(os.path.join(FILES, name)):
                continue
            via = 'site' if 'somov.org' in referer else 'link'
            out[day].append((stamp, ip, 'dl', file, 'torrent' if torrent else 'download', via, ua))
    # robots by the name of their address (once per address)
    hosts = robot_hosts()
    ips = {e[1] for evs in out.values() for e in evs}
    with ThreadPoolExecutor(32) as pool:
        names = dict(zip(ips, pool.map(lambda ip: host_of(ip, cache), ips)))
    for day in out:
        out[day] = [e for e in out[day] if not names.get(e[1], '').endswith(hosts) and e[1] not in robots]
    return out


def burst_robots(events):
    """Addresses that took more than BURST_FILES different files within BURST_WINDOW seconds, not from the site."""
    seen = defaultdict(list)
    robots = set()
    for t, ip, kind, key, sub, extra, ua in events:
        if kind == 'dl' and sub != 'magnet' and extra == 'link':
            seen[ip].append((t, key))
    for ip, items in seen.items():
        items.sort()
        for i, (t, _) in enumerate(items):
            files = {k for tt, k in items[i:] if tt - t <= BURST_WINDOW}
            if len(files) > BURST_FILES:
                robots.add(ip)
                break
    return robots


def aggregate(day, events, tweak_files):
    """Daily numbers of one day: unique (one person once) and total (every action)."""
    rows = defaultdict(lambda: [set(), 0])   # (metric, key) -> [ips, total]
    robots = burst_robots(events)
    events = sorted(e for e in events if e[1] not in robots)
    first_source, person_ua, person_lang = {}, {}, {}
    no_source = set()   # views sent before the site reported sources (12 Nov 2026)
    last_get = {}
    feed = []
    for t, ip, kind, key, sub, extra, ua in events:
        person_ua.setdefault(ip, ua)
        rows[('people', '')][0].add(ip)
        if kind == 'view':
            rows[('views', '')][0].add((ip, key))
            rows[('views', '')][1] += 1
            rows[('page', key)][0].add(ip)
            rows[('page', key)][1] += 1
            if sub and sub != 'site' and ip not in first_source:
                first_source[ip] = sub
            elif not sub:
                no_source.add(ip)
            if extra in ('ru', 'en'):
                person_lang.setdefault(ip, extra)
            feed.append((t, ip, 'view', key))
        elif kind == 'dl':
            start = True
            if sub != 'magnet':
                prev = last_get.get((ip, key, sub))
                last_get[(ip, key, sub)] = t
                start = prev is None or t - prev >= SESSION_GAP
            image = key.lower().endswith('.iso')
            metric = 'dl' if image else 'file'
            name = tweak_files.get(key, key) if not image else key
            rows[(metric, name)][0].add(ip)
            rows[(metric + 'kind', f'{name}|{sub}')][0].add(ip)
            if start:
                rows[(metric, name)][1] += 1
                rows[(metric + 'kind', f'{name}|{sub}')][1] += 1
                feed.append((t, ip, 'dl' if image else 'file', f'{name}|{sub}'))
            if image:
                rows[('downloads', '')][0].add((ip, key))
                if start:
                    rows[('downloads', '')][1] += 1
                rows[('dlvia', extra)][0].add(ip)
                if extra == 'link':
                    first_source.setdefault(ip, 'link')
        elif kind in ('tg', 'chat'):
            rows[(kind, key)][0].add(ip)
            rows[(kind, key)][1] += 1
            rows[(kind + 'all', '')][0].add(ip)
            rows[(kind + 'all', '')][1] += 1
            feed.append((t, ip, kind, key))
        elif kind == 'share':
            rows[('share', key)][0].add(ip)
            rows[('share', key)][1] += 1
        elif kind == 'tweak':
            rows[('tweak', f'tweak:{key}|{sub}')][0].add(ip)
            rows[('tweak', f'tweak:{key}|{sub}')][1] += 1
    # who they are: country, source of the visit, device, site language (each person once a day)
    countries = {}
    for ip in rows[('people', '')][0]:
        countries[ip] = country(ip) or '??'
        rows[('country', countries[ip])][0].add(ip)
        rows[('source', first_source.get(ip) or ('unknown' if ip in no_source else 'none'))][0].add(ip)
        system, browser, kind = device_of(person_ua.get(ip, ''))
        rows[('os', system)][0].add(ip)
        rows[('browser', browser)][0].add(ip)
        rows[('device', kind)][0].add(ip)
        if ip in person_lang:
            rows[('lang', person_lang[ip])][0].add(ip)
    out = [(day, metric, key, len(ips), max(total, len(ips))) for (metric, key), (ips, total) in rows.items() if ips or total]
    feed_rows = [(day, t, countries.get(ip, '??'), what, key) for t, ip, what, key in feed[-300:]]
    return out, feed_rows


def refresh(full=False):
    """Recounts the days that can still change (today and yesterday), or every day in the logs (first start)."""
    tweak_files = known_files()
    if tweak_files:
        state('keyfiles', json.dumps(tweak_files))
    try:
        forgotten = set(json.load(open(FORGOTTEN)))
    except (OSError, ValueError):
        forgotten = set()
    excluded = OWNER_IPS | SELF_IPS | forgotten
    today = datetime.now(TZ).date()
    if full:
        files = log_files()
        days = None
    else:
        files = [p for p in log_files() if re.search(r'access\.log(\.1|\.2\.gz)?$', p)]
        days = {(today - timedelta(days=i)).isoformat() for i in range(2)}
    lines = (line for path in files for line in read_lines(path))
    if days is None:   # first start: every day that is in the logs
        days = set()
        cached = []
        for line in lines:
            m = LINE.match(line)
            if m:
                try:
                    days.add(datetime.strptime(m.group(2), '%d/%b/%Y:%H:%M:%S %z').astimezone(TZ).strftime('%Y-%m-%d'))
                except ValueError:
                    pass
                cached.append(line)
        lines = cached
    by_day = events_of(lines, days, excluded, set())
    for day in sorted(days):
        rows, feed_rows = aggregate(day, by_day.get(day, []), tweak_files)
        with lock:
            db.execute('DELETE FROM agg WHERE day = ?', (day,))
            db.executemany('INSERT INTO agg (day, metric, key, uniq, total) VALUES (?, ?, ?, ?, ?)', rows)
            db.execute('DELETE FROM feed WHERE day = ?', (day,))
            db.executemany('INSERT INTO feed (day, t, cc, what, key) VALUES (?, ?, ?, ?, ?)', feed_rows)
            db.commit()
    with lock:   # the feed is only for the last days
        db.execute('DELETE FROM feed WHERE day < ?', ((today - timedelta(days=7)).isoformat(),))
        db.commit()


def worker():
    geo_open()
    try:
        geo_update()
    except Exception as error:
        log('geoip:', error)
    first = not q('SELECT 1 FROM agg LIMIT 1')
    while True:
        started = time.time()
        try:
            refresh(full=first)
            first = False
            state('updated', int(time.time()))
        except Exception as error:
            log('refresh:', type(error).__name__, error)
        if time.gmtime().tm_mday == 1:
            try:
                geo_update()
            except Exception as error:
                log('geoip:', error)
        log(f'refreshed in {time.time() - started:.1f}s')
        time.sleep(REFRESH)


# -- What the page asks for -------------------------------------------------------

def summary(period):
    today = datetime.now(TZ).date()
    first_day = (q('SELECT MIN(day) FROM agg')[0][0] or today.isoformat())
    if period == 'all':
        start = datetime.strptime(first_day, '%Y-%m-%d').date()
    else:
        start = today - timedelta(days={'today': 0, '7': 6, '30': 29, '90': 89}.get(period, 6))
    length = (today - start).days + 1
    prev_start, prev_end = start - timedelta(days=length), start - timedelta(days=1)

    def totals(a, b):
        rows = q("SELECT metric, SUM(uniq), SUM(total) FROM agg WHERE day BETWEEN ? AND ? AND key = '' "
                 "AND metric IN ('people', 'views', 'downloads', 'tgall', 'chatall') GROUP BY metric", a.isoformat(), b.isoformat())
        return {m: {'uniq': u, 'total': t} for m, u, t in rows}

    def table(metric, a=start, b=today, limit=50):
        rows = q('SELECT key, SUM(uniq) u, SUM(total) FROM agg WHERE day BETWEEN ? AND ? AND metric = ? '
                 'GROUP BY key ORDER BY u DESC LIMIT ?', a.isoformat(), b.isoformat(), metric, limit)
        return [{'key': k, 'uniq': u, 'total': t} for k, u, t in rows]

    series = defaultdict(dict)
    chart_start = start if length > 1 else today - timedelta(days=13)
    for day, metric, u, t in q("SELECT day, metric, uniq, total FROM agg WHERE day BETWEEN ? AND ? AND key = '' "
                               "AND metric IN ('people', 'views', 'downloads')", chart_start.isoformat(), today.isoformat()):
        series[day][metric] = u
    days = [(chart_start + timedelta(days=i)).isoformat() for i in range((today - chart_start).days + 1)]
    feed = q('SELECT t, cc, what, key FROM feed ORDER BY t DESC LIMIT 60')
    return {
        'period': period, 'start': start.isoformat(), 'end': today.isoformat(), 'days': length, 'since': first_day,
        'now': totals(start, today), 'before': totals(prev_start, prev_end) if period != 'all' else {},
        'series': [{'day': d, **series.get(d, {})} for d in days],
        'countries': table('country'), 'sources': table('source'), 'pages': table('page', limit=30),
        'builds': table('dl', limit=40), 'buildkinds': table('dlkind', limit=200), 'dlvia': table('dlvia'),
        'files': table('file', limit=30), 'tweaks': table('tweak', limit=40),
        'os': table('os'), 'browsers': table('browser'), 'devices': table('device'), 'langs': table('lang'),
        'tg': table('tg'), 'chat': table('chat'), 'share': table('share'),
        'feed': [{'t': t, 'cc': cc, 'what': w, 'key': k} for t, cc, w, k in feed],
        'updated': state('updated'),
    }


# -- HTTP: the page, its data, the owner check -----------------------------------------

COOKIE = 'somov_stats'


class Handler(BaseHTTPRequestHandler):
    server_version = 'somov-stats'
    sys_version = ''

    def log_message(self, *args):
        pass

    def owner(self):
        ip = self.headers.get('X-Real-IP', '')
        if ip in OWNER_IPS:
            return True
        for part in self.headers.get('Cookie', '').split(';'):
            name, _, value = part.strip().partition('=')
            if name == COOKIE and value in OWNER_TOKENS:
                return True
        return False

    def send(self, code, body, kind='text/html; charset=utf-8', extra=()):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Cache-Control', 'no-store' if 'html' in kind or 'json' in kind else 'public, max-age=2592000')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        self.send_header('Referrer-Policy', 'no-referrer')
        for name, value in extra:
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == '/stats/flags.woff2':   # the flags font (Windows cannot draw flag emoji)
            try:
                return self.send(200, open(os.path.join(HERE, 'flags.woff2'), 'rb').read(), 'font/woff2')
            except OSError:
                return self.send(404, '')
        key = params.get('key', '')
        if key in OWNER_TOKENS:   # the device key: remember it on this device, and drop it from the address
            cookie = f'{COOKIE}={key}; Path=/stats; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict'
            return self.send(302, '', extra=(('Location', '/stats/'), ('Set-Cookie', cookie)))
        if not self.owner():
            return self.send(404, NO_ACCESS)
        if url.path == '/stats/data':
            period = params.get('period', '7')
            if period not in ('today', '7', '30', '90', 'all'):
                period = '7'
            return self.send(200, json.dumps(summary(period), ensure_ascii=False), 'application/json; charset=utf-8')
        if url.path in ('/stats', '/stats/'):
            nonce = secrets.token_urlsafe(12)
            page = open(os.path.join(HERE, 'page.html'), encoding='utf-8').read().replace('{{nonce}}', nonce)
            csp = (f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; "
                   "font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'")
            return self.send(200, page, extra=(('Content-Security-Policy', csp),))
        return self.send(404, NO_ACCESS)


NO_ACCESS = ('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>404</title>'
             '<body style="background:#0f1115;color:#a9b0bc;font:16px system-ui;display:grid;place-items:center;'
             'min-height:100vh;margin:0">Страница не найдена</body>')


if __name__ == '__main__':
    threading.Thread(target=worker, daemon=True).start()
    log(f'somov-stats on 127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
