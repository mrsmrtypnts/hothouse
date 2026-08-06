"""
Directory scanning and file metadata cache for trove.

The scan cache is a JSONL file stored at ~/.cache/trove/cache.jsonl.
Each line is a JSON object with file metadata. The cache can be refreshed
incrementally or fully rebuilt.
"""

import json
import os
import time
from pathlib import Path

CACHE_PATH = Path.home() / ".cache" / "trove" / "cache.jsonl"

MEDIA_EXTENSIONS = {
    # photos
    "jpg", "jpeg", "png", "heic", "heif", "tiff", "tif", "bmp", "webp", "gif",
    # raw
    "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef",
    # video
    "mp4", "mov", "avi", "mkv", "m4v", "wmv", "flv", "webm", "mts", "m2ts",
}


def _file_info(path: str, stat) -> dict:
    p = Path(path)
    return {
        "path": path,
        "ext": p.suffix.lower().lstrip("."),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


def scan_dirs(source_dirs: list[str], progress=None) -> list[dict]:
    """
    Walk source_dirs and return a list of file_info dicts for all media files.
    Optionally calls progress(path) for each file found.
    """
    files = []
    for source_dir in source_dirs:
        for dirpath, _dirnames, filenames in os.walk(source_dir):
            for fname in filenames:
                ext = Path(fname).suffix.lower().lstrip(".")
                if ext not in MEDIA_EXTENSIONS:
                    continue
                full_path = os.path.abspath(os.path.join(dirpath, fname))
                try:
                    stat = os.stat(full_path)
                except OSError:
                    continue
                info = _file_info(full_path, stat)
                files.append(info)
                if progress:
                    progress(full_path)
    return files


def save_cache(files: list[dict]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_PATH, "w") as f:
        for info in files:
            f.write(json.dumps(info) + "\n")


def load_cache() -> list[dict]:
    if not CACHE_PATH.exists():
        return []
    files = []
    with open(CACHE_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                files.append(json.loads(line))
    return files


def cache_info() -> dict:
    """Return metadata about the current cache."""
    if not CACHE_PATH.exists():
        return {"exists": False}
    stat = CACHE_PATH.stat()
    files = load_cache()
    total_size = sum(f.get("size", 0) for f in files)
    return {
        "exists": True,
        "file_count": len(files),
        "total_size_gb": total_size / (1000 ** 3),
        "cache_mtime": stat.st_mtime,
        "cache_age_hours": (time.time() - stat.st_mtime) / 3600,
    }
