"""
Greedy knapsack packing for trove.

Given a list of scored files and a size budget, select files greedily
by score/size ratio until the budget is filled.
"""

from __future__ import annotations

import shutil
from pathlib import Path


def greedy_pack(files: list[dict], budget_bytes: int,
                min_score: float | None = None) -> list[dict]:
    """
    Select files greedily by score/size ratio.

    files: list of file_info dicts with 'score' and 'size' keys
    budget_bytes: max total size
    min_score: if set, exclude files below this score threshold

    Returns the selected subset.
    """
    candidates = [f for f in files if f.get("size", 0) > 0]
    if min_score is not None:
        candidates = [f for f in candidates if f.get("score", 0) >= min_score]

    # Sort by score/size ratio descending
    candidates.sort(key=lambda f: f.get("score", 0) / f["size"], reverse=True)

    selected = []
    total = 0
    for f in candidates:
        if total + f["size"] <= budget_bytes:
            selected.append(f)
            total += f["size"]

    return selected


def pack_stats(selected: list[dict], budget_bytes: int) -> dict:
    total = sum(f["size"] for f in selected)
    return {
        "file_count": len(selected),
        "total_size_bytes": total,
        "total_size_gb": total / (1024 ** 3),
        "budget_gb": budget_bytes / (1024 ** 3),
        "utilization_pct": 100 * total / budget_bytes if budget_bytes else 0,
    }


def copy_files(selected: list[dict], dest_dir: str,
               progress=None) -> dict:
    """
    Copy selected files to dest_dir, preserving relative path structure.
    Returns stats dict.

    Callers wanting a dry run should skip calling this entirely (see
    cmd_pack in bin/trove, which prints the projected selection and
    returns before ever reaching copy_files).
    """
    dest = Path(dest_dir)
    copied = 0
    skipped = 0
    errors = []

    for f in selected:
        src = Path(f["path"])
        # Preserve full absolute path under dest to avoid collisions
        rel = src.relative_to(src.anchor)
        dst = dest / rel
        if progress:
            progress(str(src))
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                skipped += 1
            else:
                shutil.copy2(src, dst)
                copied += 1
        except Exception as e:
            errors.append({"path": str(src), "error": str(e)})

    return {"copied": copied, "skipped": skipped, "errors": errors}
