#!/usr/bin/env python3
"""Generates QR codes (SVG to show, PNG to save) for the donation addresses on /support.
Needs segno (pip install segno). Run from the repo root after an address changes: python _src/qr.py
The addresses must match CRYPTO in build.mjs."""
import segno

CODES = {
    'images/qr-tron.svg': 'TV38U42SqsUZZKhkoqHtqDyzFrZU4eJsoW',
    'images/qr-ton.svg': 'UQBFhtxcW-nCZ345ZteeNFN-KBAes5Qk0dcmnH9JGiXxuHlI',
    'images/qr-evm.svg': '0x2842428a11e5c7e7b990e80adf019d7b40e57b9b',
    'images/qr-btc.svg': 'bitcoin:1Bf7A9JZHuDzu7yTzNqEL9q8KHHfgjMZgu',
    'images/qr-ltc.svg': 'litecoin:LU6zxeQq8atUEDW7Q4rBQZRPofMB64SRMj',
    'images/qr-sol.svg': 'CDiaQtzZmhANXHGUmvg2RJKFtim212jWeey6JKxyQyEM',
    'images/qr-doge.svg': 'dogecoin:D7YJ6E4M7H6pPXWQXJT5ubaw35ZqbmW4dA',
}

for path, data in CODES.items():
    qr = segno.make(data, error='m')
    qr.save(path, kind='svg', scale=4, border=2, dark='#0f1115', light='#ffffff', xmldecl=False, svgns=True)
    # PNG copy for the "save QR code" button: phones keep PNGs in the gallery, SVGs they often do not
    qr.save(path[:-4] + '.png', kind='png', scale=12, border=3, dark='#000000', light='#ffffff')
    print('saved', path, 'and .png')
