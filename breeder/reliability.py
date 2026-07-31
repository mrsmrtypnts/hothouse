import json
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
    return [n for n in names if n.lower() in error_lower]


def record(lora_names: list[str], success: bool, error: Optional[str] = None) -> None:
    if not lora_names:
        return
    if success:
        blamed = lora_names
    else:
        # only count a failure against the lora(s) the API error actually
        # names -- otherwise one genuinely-broken lora would eventually drag
        # down every innocent lora it happens to get randomly paired with
        blamed = _names_blamed_by_error(lora_names, error or "")
        if not blamed:
            return
    now = datetime.now(timezone.utc).isoformat()
    for name in blamed:
        entry = _state.setdefault(
            name, {"attempts": 0, "failures": 0, "last_error": None, "last_seen": None}
        )
        entry["attempts"] += 1
        if not success:
            entry["failures"] += 1
            entry["last_error"] = error
        entry["last_seen"] = now
    _save()


def is_unreliable(name: str) -> bool:
    entry = _state.get(name)
    if not entry or entry["attempts"] < MIN_ATTEMPTS:
        return False
    return entry["failures"] / entry["attempts"] >= FAILURE_RATE_THRESHOLD


def unreliable_names() -> set[str]:
    return {name for name in _state if is_unreliable(name)}


def summary() -> list[dict]:
    rows = [{"name": name, **entry, "unreliable": is_unreliable(name)} for name, entry in _state.items()]
    rows.sort(key=lambda r: (-r["failures"], -r["attempts"]))
    return rows
