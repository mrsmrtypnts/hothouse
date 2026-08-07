import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

import config

_lock = asyncio.Lock()
_nodes: dict[str, dict] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _backfill_batch_ids() -> bool:
    # nodes created before batch_id existed have no way to group by batch;
    # cluster same-parent siblings by creation-time proximity as a best-effort fix.
    by_parent: dict[str, list[dict]] = {}
    for n in _nodes.values():
        if n["parent_id"] and n.get("batch_id") is None:
            by_parent.setdefault(n["parent_id"], []).append(n)

    changed = False
    for siblings in by_parent.values():
        siblings.sort(key=lambda n: n["created_at"])
        batch_id = None
        prev_ts = None
        for n in siblings:
            ts = datetime.fromisoformat(n["created_at"])
            if prev_ts is None or (ts - prev_ts).total_seconds() > 2:
                batch_id = uuid.uuid4().hex
            n["batch_id"] = batch_id
            prev_ts = ts
            changed = True
    return changed


def _load() -> None:
    if config.TREE_PATH.exists():
        raw = json.loads(config.TREE_PATH.read_text())
        _nodes.update({n["id"]: n for n in raw})
        # any node still "pending" from a previous process (whether or not it
        # got as far as having a task_id) is picked up and automatically
        # resumed by server.py's startup recovery pass -- see
        # recover_orphaned_renders / _resume_interrupted_node. Left alone
        # here; nothing to do at load time.
        changed = _backfill_batch_ids()
        # nodes written before "viewed" existed (server-side, replacing the
        # old per-browser-origin localStorage tracking) -- treat them as
        # already seen rather than unread, so this migration doesn't dump a
        # wall of new unread dots on an existing library
        for n in _nodes.values():
            if "viewed" not in n:
                n["viewed"] = True
                changed = True
        if changed:
            _save()


def _save() -> None:
    config.TREE_PATH.write_text(json.dumps(list(_nodes.values()), indent=2))


_load()


async def create_node(
    spec: dict,
    parent_id: Optional[str],
    label: Optional[str] = None,
    batch_id: Optional[str] = None,
    render_mode: str = "txt2img",
    # the breed-controls dial values (reroll_probability, keyword/lora/
    # other_intensity) actually used to mutate this node's spec out of its
    # parent's -- None for nodes that weren't the product of a mutation at
    # all (a plain "+ New" root, or an imported image). Previously this data
    # existed nowhere durable once the request that created the node
    # returned; now it rides along with the node record itself, and gets
    # mirrored into the saved image's own metadata too (see server.py's
    # _tag_lineage) so it survives the image leaving the app entirely.
    breed_params: Optional[dict] = None,
) -> dict:
    node = {
        "id": uuid.uuid4().hex,
        "parent_id": parent_id,
        "spec": spec,
        "label": label,
        "batch_id": batch_id,
        "render_mode": render_mode,
        "breed_params": breed_params,
        "task_id": None,
        "status": "pending",
        "image_file": None,
        "error": None,
        "viewed": False,
        "created_at": _now(),
    }
    async with _lock:
        _nodes[node["id"]] = node
        _save()
    return node


async def set_task_id(node_id: str, task_id: str) -> None:
    async with _lock:
        if node_id not in _nodes:
            return
        _nodes[node_id]["task_id"] = task_id
        _save()


def pending() -> list[dict]:
    return [n for n in _nodes.values() if n["status"] == "pending"]


async def mark_done(node_id: str, image_file: str) -> None:
    async with _lock:
        if node_id not in _nodes:
            return
        _nodes[node_id]["status"] = "done"
        _nodes[node_id]["image_file"] = image_file
        _save()


async def mark_error(node_id: str, message: str) -> None:
    async with _lock:
        if node_id not in _nodes:
            return
        _nodes[node_id]["status"] = "error"
        _nodes[node_id]["error"] = message
        _save()


async def mark_pending(node_id: str) -> None:
    async with _lock:
        if node_id not in _nodes:
            return
        _nodes[node_id]["status"] = "pending"
        _nodes[node_id]["image_file"] = None
        _nodes[node_id]["error"] = None
        _nodes[node_id]["task_id"] = None
        # retrying replaces what this node will render as -- having looked at
        # the old (failed) result shouldn't count as having seen the new one
        _nodes[node_id]["viewed"] = False
        _save()


async def mark_viewed(node_id: str) -> None:
    async with _lock:
        if node_id not in _nodes or _nodes[node_id].get("viewed"):
            return
        _nodes[node_id]["viewed"] = True
        _save()


async def delete_subtree(node_id: str) -> list[dict]:
    async with _lock:
        removed = []
        stack = [node_id]
        while stack:
            nid = stack.pop()
            n = _nodes.get(nid)
            if n is None:
                continue
            removed.append(n)
            stack.extend(c["id"] for c in _nodes.values() if c["parent_id"] == nid)
        for n in removed:
            _nodes.pop(n["id"], None)
        _save()
        return removed


def get(node_id: str) -> Optional[dict]:
    return _nodes.get(node_id)


def children(node_id: str) -> list[dict]:
    return sorted(
        (n for n in _nodes.values() if n["parent_id"] == node_id),
        key=lambda n: n["created_at"],
    )


def ancestors(node_id: str) -> list[dict]:
    chain = []
    cur = _nodes.get(node_id)
    while cur is not None:
        chain.append(cur)
        cur = _nodes.get(cur["parent_id"]) if cur["parent_id"] else None
    return list(reversed(chain))


def roots() -> list[dict]:
    return sorted(
        (n for n in _nodes.values() if n["parent_id"] is None),
        key=lambda n: n["created_at"],
        reverse=True,
    )


def distinct_models() -> list[tuple[str, str, int]]:
    counts: dict[str, int] = {}
    for n in _nodes.values():
        name = (n["spec"].get("model_name") or "").strip()
        if not name:
            continue
        key = f"{name}|{(n['spec'].get('model_hash') or '').strip()}"
        counts[key] = counts.get(key, 0) + 1
    rows = []
    for key, count in counts.items():
        name, _, model_hash = key.partition("|")
        rows.append((name, model_hash, count))
    rows.sort(key=lambda r: -r[2])
    return rows


def all_nodes() -> list[dict]:
    return sorted(_nodes.values(), key=lambda n: n["created_at"], reverse=True)
