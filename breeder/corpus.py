import glob
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from PIL import Image

import config
import extract
import promptsyntax

_EMPTY = {
    "paths": [],
    "scanned_at": None,
    "file_count": 0,
    "keywords": {"prompt": {}, "negative_prompt": {}},
    "loras": {},
    "models": {},
}

_state = dict(_EMPTY)


def _load() -> None:
    global _state
    if config.CORPUS_PATH.exists():
        # merge onto _EMPTY so a corpus.json saved before a new bucket was
        # introduced (e.g. "models") doesn't KeyError on the missing key
        _state = {**_EMPTY, **json.loads(config.CORPUS_PATH.read_text())}


def _save() -> None:
    config.CORPUS_PATH.write_text(json.dumps(_state, indent=2))


_load()


def _tally_field(text: str, keyword_bucket: dict, lora_bucket: Optional[dict]) -> None:
    for seg in text.split(","):
        seg = seg.strip()
        if not seg:
            continue
        name, weight, kind = promptsyntax.parse_segment(seg)
        if not name:
            continue
        bucket = lora_bucket if kind == "lora" else keyword_bucket
        if bucket is None:
            continue
        entry = bucket.setdefault(name, {"count": 0, "weight_sum": 0.0})
        entry["count"] += 1
        entry["weight_sum"] += weight


def _tally_model(model_name: str, model_hash: str, bucket: dict) -> None:
    name = model_name.strip()
    if not name:
        return
    key = f"{name}|{model_hash.strip()}"
    entry = bucket.setdefault(key, {"count": 0})
    entry["count"] += 1


def _expand_dirs(patterns: list[str]) -> list[Path]:
    """Each pattern may be a plain directory or a glob (e.g. a permanent
    collection organized as "/Volumes/Archive/keepers/*/final") -- expanded
    fresh on every scan so newly-matching sibling folders (a new quarter, a
    new shoot) are picked up without touching config."""
    dirs: set[Path] = set()
    for pattern in patterns:
        expanded = str(Path(pattern).expanduser())
        for match in glob.glob(expanded, recursive=True):
            p = Path(match)
            if p.is_dir():
                dirs.add(p)
    return sorted(dirs)


def current_paths() -> list[str]:
    """The patterns to (re)scan with -- whatever was last scanned (manually
    or via a prior auto-scan), falling back to BREEDER_CORPUS_DIRS if nothing
    has ever been scanned. Lets a manually-entered set of paths (via the
    classic UI) survive periodic rescans too, not just the env-var default."""
    return _state.get("paths") or config.CORPUS_DIRS


def scan(paths: list[str]) -> dict:
    keywords = {"prompt": {}, "negative_prompt": {}}
    loras = {}
    models = {}
    file_count = 0
    for root in _expand_dirs(paths):
        for f in root.rglob("*.png"):
            try:
                im = Image.open(f)
                text = im.info.get("parameters")
                if not text:
                    continue
                spec = extract.parse_parameters_text(text)
            except Exception:
                continue
            file_count += 1
            _tally_field(spec.get("prompt", ""), keywords["prompt"], loras)
            _tally_field(spec.get("negative_prompt", ""), keywords["negative_prompt"], None)
            _tally_model(spec.get("model_name", ""), spec.get("model_hash", ""), models)

    global _state
    if file_count == 0 and _state.get("file_count", 0) > 0:
        # zero matches usually means the source (e.g. an external drive) is
        # temporarily unreachable, not that the corpus is actually empty --
        # keep the last good corpus rather than silently wiping it out from
        # under every add-mutator that depends on it
        return summary()
    _state = {
        "paths": paths,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "file_count": file_count,
        "keywords": keywords,
        "loras": loras,
        "models": models,
    }
    _save()
    return summary()


def top_keywords(field: str, exclude: set[str]) -> list[tuple[str, int, float]]:
    bucket = _state["keywords"].get(field, {})
    return [
        (name, e["count"], e["weight_sum"] / e["count"])
        for name, e in bucket.items()
        if name not in exclude
    ]


def top_loras(exclude: set[str]) -> list[tuple[str, int, float]]:
    return [
        (name, e["count"], e["weight_sum"] / e["count"])
        for name, e in _state["loras"].items()
        if name not in exclude
    ]


def top_models() -> list[tuple[str, str, int]]:
    rows = []
    for key, e in _state["models"].items():
        name, _, model_hash = key.partition("|")
        rows.append((name, model_hash, e["count"]))
    rows.sort(key=lambda r: -r[2])
    return rows


def summary(limit: int = 25) -> dict:
    def top_n(bucket: dict) -> list[dict]:
        rows = [
            {"name": k, "count": v["count"], "avg_weight": round(v["weight_sum"] / v["count"], 2)}
            for k, v in bucket.items()
        ]
        rows.sort(key=lambda r: -r["count"])
        return rows[:limit]

    return {
        "paths": _state["paths"],
        "scanned_at": _state["scanned_at"],
        "file_count": _state["file_count"],
        "top_prompt_keywords": top_n(_state["keywords"]["prompt"]),
        "top_negative_keywords": top_n(_state["keywords"]["negative_prompt"]),
        "top_loras": top_n(_state["loras"]),
    }
