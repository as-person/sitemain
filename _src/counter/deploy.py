#!/usr/bin/env python3
"""Adds the counter location to the dl3 nginx site. Safe to run again. Runs on the server as root."""
import os
import shutil
import subprocess
import time

SITE = '/etc/nginx/sites-available/dl3.somov.org'
ANCHOR = '    location / {\n        try_files $uri $uri/ =404;'
BLOCK = '''    location ^~ /api/ {
        proxy_pass http://127.0.0.1:8095;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 1k;
    }

'''

text = open(SITE).read()
if 'location ^~ /api/' in text:
    print('nginx: already configured')
else:
    assert text.count(ANCHOR) == 1, 'unexpected nginx config'
    backup = f'/root/dl3.somov.org.nginx.{time.strftime("%Y%m%d-%H%M%S")}.bak'
    shutil.copy2(SITE, backup)
    with open(SITE, 'w') as f:
        f.write(text.replace(ANCHOR, BLOCK + ANCHOR))
    test = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if test.returncode != 0:
        shutil.copy2(backup, SITE)
        raise SystemExit('nginx -t failed, config restored:\n' + test.stderr)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('nginx: configured, backup', backup)
