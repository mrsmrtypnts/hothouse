"""Thumbnail generation and caching for hoard."""

import hashlib
from pathlib import Path

from PIL import Image

THUMB_DIR = Path.home() / ".cache" / "hoard" / "thumbs"
THUMB_SIZE = (320, 320)


def thumb_path(image_path: str) -> Path:
    digest = hashlib.sha1(image_path.encode()).hexdigest()
    return THUMB_DIR / f"{digest}.jpg"


def ensure_thumb(image_path: str) -> Path:
    """Return the cached thumbnail path, generating it if missing or stale."""
    dest = thumb_path(image_path)
    src = Path(image_path)
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return dest

    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.chmod(0o700)
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail(THUMB_SIZE)
        im.save(dest, "JPEG", quality=85)
    return dest
