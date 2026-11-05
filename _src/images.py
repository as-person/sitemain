#!/usr/bin/env python3
"""Generate responsive WebP screenshots next to the PNG originals.
Run from the repo root after adding new screenshots: python _src/images.py"""
import glob, os
from PIL import Image

WIDTHS = (480, 960, 1600)
for png in sorted(glob.glob('images/windows-*/*.png')):
    stem = png[:-4]
    img = Image.open(png).convert('RGB')
    for w in WIDTHS:
        out = f'{stem}-{w}.webp'
        if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(png):
            continue
        h = round(img.height * w / img.width)
        img.resize((w, h), Image.LANCZOS).save(out, 'WEBP', quality=80, method=6)
