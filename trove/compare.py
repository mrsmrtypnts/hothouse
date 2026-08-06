"""
Terminal UI for pairwise file comparisons (trove compare).
Uses the `rich` library for display.
"""

import json
import sys
import termios
import time
import tty
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from trove import model as modellib
from trove import features as featlib

console = Console()


# ---------------------------------------------------------------------------
# Raw keypress (no Enter required)
# ---------------------------------------------------------------------------

def _read_key() -> str:
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
    return ch


# ---------------------------------------------------------------------------
# File card rendering
# ---------------------------------------------------------------------------

def _human_size(size_bytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} TB"


def _display_key(feat_key: str, legend: dict) -> str:
    return feat_key if not _looks_like_hash(feat_key) else legend.get(feat_key, feat_key[:12] + "…")


def _file_card(f: dict, other: dict, label: str, weights: dict, legend: dict) -> Panel:
    path = Path(f["path"])
    parts = path.parts

    # Show last 4 path components to give context without being overwhelming
    display_path = str(Path(*parts[-4:])) if len(parts) >= 4 else str(path)

    lines = Text()
    lines.append(f"{display_path}\n", style="bold white")
    lines.append(f"Size:  {_human_size(f['size'])}\n", style="cyan")
    lines.append(f"Type:  {f.get('ext','?').upper()}\n", style="cyan")
    lines.append(f"Score: {f.get('score', 0.0):.3f}\n", style="yellow")

    fvec = f.get("feature_vec", {})
    other_fvec = other.get("feature_vec", {})

    # All features with nonzero weight contribution
    weighted = [(k, weights.get(k, 0.0) * v) for k, v in fvec.items()
                if abs(weights.get(k, 0.0)) > 1e-6]
    weighted.sort(key=lambda x: abs(x[1]), reverse=True)

    if weighted:
        lines.append("\nFeatures:\n", style="dim")
        for feat_key, contrib in weighted:
            sign = "+" if contrib >= 0 else ""
            lines.append(f"  {_display_key(feat_key, legend)}  {sign}{contrib:.3f}\n",
                         style="green" if contrib >= 0 else "red")

    # Features that differ from the other file but have zero weight (dimmed)
    my_keys = set(fvec)
    other_keys = set(other_fvec)
    zero_weight_unique = [k for k in (my_keys - other_keys)
                          if abs(weights.get(k, 0.0)) <= 1e-6]
    zero_weight_unique.sort(key=lambda k: _display_key(k, legend))

    if zero_weight_unique:
        lines.append("\nUnlearned (differs from other):\n", style="dim")
        for feat_key in zero_weight_unique:
            lines.append(f"  {_display_key(feat_key, legend)}\n", style="dim")

    color = "blue" if label == "1" else "magenta"
    return Panel(lines, title=f"[bold {color}][ {label} ][/bold {color}]",
                 border_style=color, padding=(0, 1))


def _looks_like_hash(s: str) -> bool:
    """True for a hashed keyword feature key: 'keyword:' + 64 hex chars."""
    prefix = "keyword:"
    if not s.startswith(prefix):
        return False
    digest = s[len(prefix):]
    return len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)


# ---------------------------------------------------------------------------
# Comparison logging
# ---------------------------------------------------------------------------

def _log_comparison(comparisons_path: Path, winner: dict, loser: dict,
                    outcome: str) -> None:
    comparisons_path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": time.time(),
        "outcome": outcome,   # "1", "2", or "tie"
        "a": winner["path"],
        "b": loser["path"],
    }
    with open(comparisons_path, "a") as fh:
        fh.write(json.dumps(record) + "\n")


# ---------------------------------------------------------------------------
# Main session loop
# ---------------------------------------------------------------------------

def run_compare_session(files, weights, config, salt, comparisons_path,
                        n_comparisons=None):
    """
    Interactive pairwise comparison session.

    Picks pairs via active learning, displays them side-by-side, records
    the user's choice, updates weights, and saves the model after each step.

    Keys: 1 = left wins, 2 = right wins, = = tie, q = quit
    """
    if len(files) < 2:
        console.print("[red]Need at least 2 files in cache to compare.[/red]")
        return weights

    done = 0
    score_cache = {}
    legend = featlib.build_hash_legend(salt, config)

    console.print("\n[bold]trove compare[/bold] — pick the higher-value file\n"
                  "Keys: [bold blue]1[/bold blue] = left  "
                  "[bold magenta]2[/bold magenta] = right  "
                  "[bold yellow]=[/bold yellow] = tie  "
                  "[bold red]q[/bold red] = quit\n")

    while True:
        if n_comparisons is not None and done >= n_comparisons:
            break

        # Active learning: pick next pair
        try:
            a, b, reason = modellib.select_pair(files, weights, scored_cache=score_cache)
        except ValueError as e:
            console.print(f"[red]{e}[/red]")
            break

        # Refresh displayed scores
        a["score"] = modellib.score(a["feature_vec"], weights)
        b["score"] = modellib.score(b["feature_vec"], weights)

        # Render
        console.clear()
        console.print(f"[dim]Comparison {done + 1}"
                      + (f" / {n_comparisons}" if n_comparisons else "")
                      + f"  |  {len(files):,} files in pool"
                      + f"  |  {reason}[/dim]\n")
        console.print(_file_card(a, b, "1", weights, legend))
        console.print(_file_card(b, a, "2", weights, legend))
        console.print("\nYour choice: ", end="")

        key = _read_key()
        console.print(key)  # echo

        if key == "q":
            break
        elif key == "1":
            winner, loser, outcome = a, b, "1"
        elif key == "2":
            winner, loser, outcome = b, a, "2"
        elif key == "=":
            # Tie: do two updates in opposite directions (net ~zero but reduces uncertainty)
            weights = modellib.update_weights(weights, a["feature_vec"], b["feature_vec"], lr=0.05)
            weights = modellib.update_weights(weights, b["feature_vec"], a["feature_vec"], lr=0.05)
            _log_comparison(comparisons_path, a, b, "tie")
            modellib.save_weights(weights)
            # Weights changed, so every cached score is now stale, not just
            # this pair's — recompute from scratch on next lookup.
            score_cache.clear()
            done += 1
            continue
        else:
            console.print("[dim]Press 1, 2, =, or q[/dim]")
            continue

        weights = modellib.update_weights(weights, winner["feature_vec"], loser["feature_vec"])
        _log_comparison(comparisons_path, winner, loser, outcome)
        modellib.save_weights(weights)
        # Weights changed, so every cached score is now stale, not just
        # this pair's — recompute from scratch on next lookup.
        score_cache.clear()
        done += 1

    console.print(f"\n[green]Done. {done} comparison(s) recorded. Model saved.[/green]")
    return weights
