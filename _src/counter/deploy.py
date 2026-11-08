#!/usr/bin/env python3
"""Adds the counter to the dl3 nginx site. Safe to run again. Runs on the server as root.

- /api/      public endpoints of the counter (magnet clicks, tweak copies and links, stats)
- every file download (images, torrents, tweak files) is mirrored to the counter; the download itself is untouched
"""
import shutil
import subprocess
import time

SITE = '/etc/nginx/sites-available/dl3.somov.org'
ROOT_PLAIN = '    location / {\n        try_files $uri $uri/ =404;'
ROOT_COUNTED = '    location / {\n        mirror /_count_hit;\n        mirror_request_body off;\n        try_files $uri $uri/ =404;'

API = '''    location ^~ /api/ {
        proxy_pass http://127.0.0.1:8095;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 1k;
    }

'''

DOWNLOADS = '''    location ~* \\.(iso|torrent)$ {
        mirror /_count_hit;
        mirror_request_body off;
        try_files $uri =404;
    }

    location = /_count_hit {
        internal;
        proxy_pass http://127.0.0.1:8095/internal/hit;
        proxy_method POST;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_connect_timeout 1s;
        proxy_read_timeout 2s;
    }

'''

text = open(SITE).read()
assert text.count(ROOT_PLAIN) + text.count(ROOT_COUNTED) == 1, 'unexpected nginx config'
changed = text
anchor = ROOT_PLAIN if ROOT_PLAIN in changed else ROOT_COUNTED
if 'location ^~ /api/' not in changed:
    changed = changed.replace(anchor, API + anchor)
if 'location = /_count_hit' not in changed:
    changed = changed.replace(anchor, DOWNLOADS + anchor)
changed = changed.replace(ROOT_PLAIN, ROOT_COUNTED)

if changed == text:
    print('nginx: already configured')
else:
    backup = f'/root/dl3.somov.org.nginx.{time.strftime("%Y%m%d-%H%M%S")}.bak'
    shutil.copy2(SITE, backup)
    with open(SITE, 'w') as f:
        f.write(changed)
    test = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if test.returncode != 0:
        shutil.copy2(backup, SITE)
        raise SystemExit('nginx -t failed, config restored:\n' + test.stderr)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('nginx: configured, backup', backup)
