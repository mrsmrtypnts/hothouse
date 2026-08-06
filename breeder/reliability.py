import json
import os
from datetime import datetime, timezone
from typing import Optional

import config

# Kept separate from corpus.json: that file is a rebuildable cache of what's
# in your image library and gets wholesale-overwritten by corpus.scan(), which
# would otherwise silently erase everything learned here from live renders.
_state: dict[str, dict] = {}

MIN_ATTEMPTS = 3
FAILURE_RATE_THRESHOLD = 0.5


def _load() -> None:
    global _state
    if config.LORA_HEALTH_PATH.exists():
        _state = json.loads(config.LORA_HEALTH_PATH.read_text())


def _save() -> None:
    config.LORA_HEALTH_PATH.write_text(json.dumps(_state, indent=2))


_load()


def _names_blamed_by_error(names: list[str], error: str) -> list[str]:
    error_lower = error.lower()
    blamed = []
    for n in names:
        # model_name is stored with its file extension (e.g.
        # "foo.safetensors"), but Diffus's "CHECKPOINT model 'foo' not
        # found" error echoes back the bare name -- an exact-substring check
        # against the full name never matches, so a checkpoint-not-found
        # failure was silently never recorded against anything. Try the
        # extension-stripped stem too (a no-op for names with no extension,
        # e.g. loras).
        stem = os.path.splitext(n)[0]
        if n.lower() in error_lower or (stem and stem.lower() in error_lower):
            blamed.append(n)
    return blamed


def _key(kind: str, name: str) -> str:
    return f"{kind}:{name}"


def record(kind: str, names: list[str], success: bool, error: Optional[str] = None) -> None:
    """kind is "lora" or "model" -- tracked in the same store (kept separate
    from corpus.json, see above) but namespaced so a lora and a model can
    never collide on the same name."""
    if not names:
        return
    if success:
        blamed = names
    else:
        # only count a failure against the asset(s) the API error actually
        # names -- otherwise one genuinely-broken lora/model would eventually
        # drag down every innocent one it happens to get randomly paired with
        blamed = _names_blamed_by_error(names, error or "")
        if not blamed:
            return
    now = datetime.now(timezone.utc).isoformat()
    for name in blamed:
        entry = _state.setdefault(
            _key(kind, name),
            {"kind": kind, "name": name, "attempts": 0, "failures": 0, "last_error": None, "last_seen": None},
        )
        entry["attempts"] += 1
        if not success:
            entry["failures"] += 1
            entry["last_error"] = error
        entry["last_seen"] = now
    _save()


def _is_unreliable_entry(entry: dict) -> bool:
    return entry["attempts"] >= MIN_ATTEMPTS and entry["failures"] / entry["attempts"] >= FAILURE_RATE_THRESHOLD


def is_unreliable(kind: str, name: str) -> bool:
    entry = _state.get(_key(kind, name))
    return bool(entry) and _is_unreliable_entry(entry)


def unreliable_names(kind: str) -> set[str]:
    return {entry["name"] for entry in _state.values() if entry.get("kind") == kind and _is_unreliable_entry(entry)}


def summary() -> list[dict]:
    rows = [{**entry, "unreliable": _is_unreliable_entry(entry)} for entry in _state.values()]
    rows.sort(key=lambda r: (-r["failures"], -r["attempts"]))
    return rows
