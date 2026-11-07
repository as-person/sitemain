#!/usr/bin/env python3
"""Generates QR codes for the donation addresses on /support.
Needs segno (pip install segno). Run from the repo root after an address changes: python _src/qr.py
The addresses must match DONATE in build.mjs."""
import segno

CODES = {
    'images/qr-usdt-ton.svg': 'UQBFhtxcW-nCZ345ZteeNFN-KBAes5Qk0dcmnH9JGiXxuHlI',
}

for path, data in CODES.items():
    segno.make(data, error='m').save(path, kind='svg', scale=4, border=2, dark='#0f1115', light='#ffffff', xmldecl=False, svgns=True)
    print('saved', path)
