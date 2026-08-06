"""
Feature extraction and HMAC hashing for trove.

Feature names are human-readable internally (e.g. "keyword:hawaii", "ext:jpg")
but are stored in the model as HMAC-SHA256 hashes so the repo reveals nothing
about what characteristics define value.
"""

import hmac
import hashlib
import json
import math
import os
import re
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

CONFIG_DIR = Path.home() / ".config" / "trove"
FEATURES_PATH = CONFIG_DIR / "features.json"
SALT_PATH = CONFIG_DIR / "salt"

# ---------------------------------------------------------------------------
# Salt
# ---------------------------------------------------------------------------

def load_salt() -> bytes:
    """Load the HMAC salt from ~/.config/trove/salt."""
    if not SALT_PATH.exists():
        raise FileNotFoundError(
            f"Salt file not found at {SALT_PATH}.\n"
            f"Create it with: mkdir -p {SALT_PATH.parent} && echo 'your-passphrase' > {SALT_PATH}"
        )
    return SALT_PATH.read_text().strip().encode()


# ---------------------------------------------------------------------------
# Feature config
# ---------------------------------------------------------------------------

def load_feature_config() -> dict:
    """Load the feature vocabulary from ~/.config/trove/features.json."""
    if not FEATURES_PATH.exists():
        raise FileNotFoundError(
            f"Feature config not found at {FEATURES_PATH}.\n"
            f"Create it with your keywords — see features.example.json in the repo."
        )
    return json.loads(FEATURES_PATH.read_text())


# ---------------------------------------------------------------------------
# Feature name -> HMAC hash
# ---------------------------------------------------------------------------

def hash_feature(salt: bytes, feature_name: str) -> str:
    """Return the HMAC-SHA256 hex digest for a feature name."""
    return hmac.new(salt, feature_name.encode(), hashlib.sha256).hexdigest()


def build_feature_map(salt: bytes, feature_names: list[str]) -> dict[str, str]:
    """Return {feature_name: hash} for a list of feature names."""
    return {name: hash_feature(salt, name) for name in feature_names}


def keyword_feature_key(salt: bytes, keyword: str) -> str:
    """
    Build the stored key for a keyword feature: the "keyword:" family
    prefix stays in the clear (so features from the same family can still
    be grouped, e.g. for contrastive pair selection) while the keyword
    value itself is HMAC-hashed.
    """
    return f"keyword:{hash_feature(salt, keyword.lower())}"


def build_hash_legend(salt: bytes, config: dict) -> dict[str, str]:
    """
    Return {key: feature_name} for all keyword features in config.
    Used at display time to reverse hashed keys back to readable names.
    Never stored — computed locally from salt + config.
    """
    legend = {}
    for kw in config.get("keywords", []):
        kw_lower = kw.lower()
        legend[keyword_feature_key(salt, kw_lower)] = f"keyword:{kw_lower}"
    return legend


# ---------------------------------------------------------------------------
# Generic (non-sensitive) feature names
# ---------------------------------------------------------------------------

EXT_CATEGORIES = {
    "photo": {"jpg", "jpeg", "png", "heic", "heif", "tiff", "tif", "bmp", "webp", "gif"},
    "raw":   {"raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "pef"},
    "video": {"mp4", "mov", "avi", "mkv", "m4v", "wmv", "flv", "webm", "mts", "m2ts"},
}

def _ext_category(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    for cat, exts in EXT_CATEGORIES.items():
        if ext in exts:
            return cat
    return "other"

_SIZE_BUCKETS = [
    (1024 ** 3,      "size:1GB"),
    (100 * 1024 ** 2, "size:100MB"),
    (10 * 1024 ** 2,  "size:10MB"),
    (1024 ** 2,       "size:1MB"),
    (100 * 1024,      "size:100KB"),
    (10 * 1024,       "size:10KB"),
    (1024,            "size:1KB"),
]

def _size_bucket(size_bytes: int) -> str:
    """Log-scale size bucket, labeled by lower bound."""
    for threshold, label in _SIZE_BUCKETS:
        if size_bytes >= threshold:
            return label
    return "size:tiny"

def _year_from_path(path: str) -> str | None:
    """
    Extract a plausible 4-digit year from path, if present.

    Restricted to a sane range (1990 - this year + 1) rather than accepting
    any 19xx/20xx-shaped number: an unrestricted match also catches
    incidental 4-digit numbers that happen to fall in that shape — image
    resolutions, IDs, etc. embedded in a filename — and mislabels them as
    years. Takes the first in-range candidate, scanning left to right.
    """
    current_year = time.localtime().tm_year
    for m in re.finditer(r'\b(19|20)\d{2}\b', path):
        year = int(m.group())
        if 1990 <= year <= current_year + 1:
            return f"year:{year}"
    return None

def _path_depth(path: str) -> str:
    depth = len(Path(path).parts)
    bucket = min(depth // 2, 6)  # 0-2, 2-4, 4-6, 6+
    return f"depth:{bucket}"

def _recency_bucket(mtime: float) -> str:
    age_days = (time.time() - mtime) / 86400
    if age_days < 30:
        return "recency:recent"
    elif age_days < 365:
        return "recency:this_year"
    elif age_days < 3 * 365:
        return "recency:few_years"
    else:
        return "recency:old"


def _max_consecutive_exclamations(path: str) -> str | None:
    """Return a bucketed feature for max consecutive '!' in the filename."""
    filename = Path(path).name
    max_run = 0
    run = 0
    for ch in filename:
        if ch == "!":
            run += 1
            max_run = max(max_run, run)
        else:
            run = 0
    if max_run == 0:
        return None
    bucket = str(max_run) if max_run <= 6 else "7+"
    return f"exclamations:{bucket}"


_EXT_ALIASES = {
    "jpeg": "jpg",
    "tif":  "tiff",
    "m2ts": "mts",
}


def generic_features(file_info: dict) -> list[str]:
    """
    Return a list of generic (non-sensitive) feature names for a file.
    file_info: dict with keys: path, size, mtime, ext
    """
    ext = _EXT_ALIASES.get(
        file_info.get("ext", "").lower().lstrip("."),
        file_info.get("ext", "").lower().lstrip(".")
    )
    path = file_info.get("path", "")
    size = file_info.get("size", 0)
    mtime = file_info.get("mtime", 0.0)

    features = []
    features.append(f"extcat:{_ext_category(ext)}")
    features.append(f"ext:{ext}" if ext else "ext:none")
    features.append(_size_bucket(size))
    features.append(_path_depth(path))
    features.append(_recency_bucket(mtime))
    year = _year_from_path(path)
    if year:
        features.append(year)
    exclamations = _max_consecutive_exclamations(path)
    if exclamations:
        features.append(exclamations)
    return features


# ---------------------------------------------------------------------------
# Keyword features (sensitive — from features.json)
# ---------------------------------------------------------------------------

def keyword_features(file_info: dict, config: dict) -> list[str]:
    """
    Return the (unprefixed, lowercased) keyword values that match this file.
    Callers combine these with keyword_feature_key() to get the stored,
    HMAC-hashed key.
    """
    path_lower = file_info.get("path", "").lower()

    matches = []
    for kw in config.get("keywords", []):
        kw_lower = kw.lower()
        if kw_lower in path_lower:
            matches.append(kw_lower)

    return matches


# ---------------------------------------------------------------------------
# Full feature vector for a file
# ---------------------------------------------------------------------------

def extract_features(file_info: dict, config: dict, salt: bytes) -> dict[str, float]:
    """
    Return {feature_hash: 1.0} for all active features of a file.
    Generic features use their name directly as key (not sensitive).
    Keyword features are HMAC-hashed.
    """
    vec = {}

    for name in generic_features(file_info):
        vec[name] = 1.0

    for kw in keyword_features(file_info, config):
        vec[keyword_feature_key(salt, kw)] = 1.0

    return vec
