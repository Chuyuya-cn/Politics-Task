"""Downscale the key screenshots into docs/ for the README.

PNG captures are ~1.2 MB each; the originals under screenshots/ stay gitignored
because they are far too large for a repository. For the few images that do ship
with the repo, JPEG at quality 82 keeps the file small enough for a fast GitHub
render while staying visually clean — these are UI screenshots with large flat
glass panels, which compress well.

Prerequisites:
    pip install Pillow
    # then capture the screenshots first, e.g.:
    #   node test/e2e.mjs          -> screenshots/01-init.png, 04-answer.png
    #   node test/static-e2e.mjs   -> screenshots/static/static-answer-ios.png

Usage:
    python scripts/make-readme-shots.py
"""
import os

from PIL import Image

JOBS = [
    ("screenshots/01-init.png", "docs/screenshot-init.jpg", 1100, 82),
    ("screenshots/04-answer.png", "docs/screenshot-answer.jpg", 1100, 82),
    ("screenshots/static/static-answer-ios.png", "docs/screenshot-mobile.jpg", 660, 80),
]

os.makedirs("docs", exist_ok=True)

for src, dst, max_width, quality in JOBS:
    if not os.path.exists(src):
        print(f"skip (missing): {src}")
        continue
    image = Image.open(src).convert("RGB")
    width, height = image.size
    if width > max_width:
        image = image.resize((max_width, round(height * max_width / width)), Image.LANCZOS)
    image.save(dst, "JPEG", quality=quality, optimize=True)
    print(f"{dst}: {image.size[0]}x{image.size[1]}, {os.path.getsize(dst)/1024:.0f} KB")
