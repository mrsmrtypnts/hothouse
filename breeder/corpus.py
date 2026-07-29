import json
from datetime import datetime, timezone
from pathlib import Path

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
}

_state = dict(_EMPTY)


def _load() -> None:
    global _state
    if config.CORPUS_PATH.exists():
        _state = json.loads(config.CORPUS_PATH.read_text())


def _save() -> None:
    config.CORPUS_PATH.write_text(json.dumps(_state, indent=2))


_load()


def _tally_field(text: str, keyword_bucket: dict, lora_bucket: dict | None) -> None:
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


def scan(paths: list[str]) -> dict:
    keywords = {"prompt": {}, "negative_prompt": {}}
    loras = {}
    file_count = 0
    for p in paths:
        root = Path(p).expanduser()
        if not root.is_dir():
            continue
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

    global _state
    _state = {
        "paths": paths,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "file_count": file_count,
        "keywords": keywords,
        "loras": loras,
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
