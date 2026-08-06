"""
Audit / dry-run mode for trove.
Shows a stratified sample of scored files, score distribution histogram,
and projected knapsack stats.
"""

from __future__ import annotations

import random
import math
from rich.console import Console
from rich.table import Table
from rich.text import Text
from rich import box

from trove import model as modellib
from trove import pack as packlib
from trove.features import build_hash_legend

console = Console()


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _human_size(size_bytes: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if size_bytes < 1000:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1000
    return f"{size_bytes:.1f} TB"


def _looks_like_hash(s: str) -> bool:
    """True for a hashed keyword feature key: 'keyword:' + 64 hex chars."""
    prefix = "keyword:"
    if not s.startswith(prefix):
        return False
    digest = s[len(prefix):]
    return len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)


def _feature_display(key: str, contrib: float, legend: dict) -> str:
    name = key if not _looks_like_hash(key) else legend.get(key, key[:12] + "…")
    sign = "+" if contrib >= 0 else ""
    return f"{name} ({sign}{contrib:.3f})"


# ---------------------------------------------------------------------------
# File table
# ---------------------------------------------------------------------------

def _make_table(title: str, files: list[dict], weights: dict,
                legend: dict) -> Table:
    table = Table(title=title, box=box.SIMPLE, show_lines=False,
                  title_style="bold", expand=True)
    table.add_column("Score", style="yellow", width=7, justify="right")
    table.add_column("Size", style="cyan", width=9, justify="right")
    table.add_column("Type", style="cyan", width=5)
    table.add_column("Path", style="white", no_wrap=False)
    table.add_column("Top features", style="dim", no_wrap=False)

    for f in files:
        fvec = f.get("feature_vec", {})
        top = modellib.top_features(fvec, weights, n=3)
        feat_str = "  ".join(
            _feature_display(k, c, legend)
            for k, c in top if abs(c) > 0.0001
        )
        # Show last 5 path components
        from pathlib import Path
        parts = Path(f["path"]).parts
        display_path = str(Path(*parts[-5:])) if len(parts) >= 5 else f["path"]

        table.add_row(
            f"{f.get('score', 0):.3f}",
            _human_size(f.get("size", 0)),
            f.get("ext", "?").upper(),
            display_path,
            feat_str or "—",
        )
    return table


# ---------------------------------------------------------------------------
# ASCII histogram
# ---------------------------------------------------------------------------

def _histogram(scores: list[float], n_bins: int = 20, width: int = 40) -> str:
    if not scores:
        return "(no scores)"
    lo, hi = min(scores), max(scores)
    if lo == hi:
        return f"(all scores = {lo:.3f})"

    bins = [0] * n_bins
    for s in scores:
        idx = min(int((s - lo) / (hi - lo) * n_bins), n_bins - 1)
        bins[idx] += 1

    max_count = max(bins)
    lines = []
    bin_width = (hi - lo) / n_bins
    # High scores first (top of the printed histogram), low scores last.
    for i in reversed(range(n_bins)):
        count = bins[i]
        label = f"{lo + i * bin_width:+.2f}"
        bar = "█" * int(count / max_count * width)
        lines.append(f"  {label}  {bar}  {count}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main audit function
# ---------------------------------------------------------------------------

def run_audit(files: list[dict], weights: dict, budget_bytes: int,
              n_sample: int = 20, salt: bytes = b"", config: dict = None):
    """
    Print audit report:
    - Top/middle/bottom n_sample files by score, *within the projected
      pack at budget_bytes* (not the whole library — see below)
    - ASCII histogram of the whole library's score distribution
    - Projected pack stats at budget_bytes

    The stratified sample is scoped to the pack, not the full scanned
    population: with a large library, "bottom of everything" is almost
    always junk that was never in contention for any realistic budget,
    and "middle of everything" doesn't correspond to anything you'd
    actually get. Scoping to the pack means "bottom" shows the weakest
    files that still made the cut — a genuinely useful sanity check —
    and "top"/"middle" show the best/typical picks. The histogram stays
    library-wide, since seeing the full distribution (not just the sliver
    that got packed) is what makes it useful as context.
    """
    if config is None:
        config = {}
    legend = build_hash_legend(salt, config)

    if not files:
        console.print("[red]No files in cache. Run: trove scan <dir>...[/red]")
        return

    sorted_files = sorted(files, key=lambda f: f.get("score", 0), reverse=True)
    scores = [f.get("score", 0) for f in sorted_files]
    total_size = sum(f.get("size", 0) for f in files)

    selected = packlib.greedy_pack(files, budget_bytes)
    packed_sorted = sorted(selected, key=lambda f: f.get("score", 0), reverse=True)

    # --- Feature weights summary ---
    console.print()
    console.rule("[bold]trove audit[/bold]")
    if weights:
        table = Table(box=box.SIMPLE, show_header=True, title="Learned feature weights",
                      title_style="bold", expand=False)
        table.add_column("Feature", style="white")
        table.add_column("Weight", justify="right", width=8)
        sorted_weights = sorted(weights.items(), key=lambda x: x[1], reverse=True)
        for key, w in sorted_weights:
            display = key if not _looks_like_hash(key) else legend.get(key, key[:12] + "…")
            style = "green" if w >= 0 else "red"
            table.add_row(display, f"[{style}]{w:+.3f}[/{style}]")
        console.print(table)
        console.print()

    # --- Summary header ---
    console.print(f"  Files in pool:  [bold]{len(files):,}[/bold]")
    console.print(f"  Total size:     [bold]{total_size / 1000**3:.1f} GB[/bold]")
    console.print(f"  Budget:         [bold]{budget_bytes / 1000**3:.0f} GB[/bold]")
    console.print(f"  Score range:    {min(scores):.3f} – {max(scores):.3f}")
    console.print()

    # --- Stratified sample (within the projected pack, not the whole library) ---
    if not packed_sorted:
        console.print("[red]Budget too small — no files would be packed. "
                      "Skipping stratified sample.[/red]\n")
    else:
        top = packed_sorted[:n_sample]

        bottom = packed_sorted[-n_sample:]

        mid_start = len(packed_sorted) // 2 - n_sample
        mid_end = len(packed_sorted) // 2 + n_sample
        mid_pool = packed_sorted[max(0, mid_start):mid_end]
        middle = random.sample(mid_pool, min(n_sample, len(mid_pool)))
        middle.sort(key=lambda f: f.get("score", 0), reverse=True)

        console.print(_make_table(f"Top {len(top)} files (in pack)", top, weights, legend))
        console.print(_make_table(f"Middle sample ({len(middle)} files, in pack)", middle, weights, legend))
        console.print(_make_table(f"Bottom {len(bottom)} files (in pack — weakest that still made the cut)", bottom, weights, legend))

    # --- Score histogram ---
    console.rule("[bold]Score distribution[/bold] [dim](whole library)[/dim]")
    console.print(_histogram(scores))
    console.print()

    # --- Projected pack ---
    console.rule("[bold]Projected pack[/bold]")
    stats = packlib.pack_stats(selected, budget_bytes)
    console.print(f"  Files selected:   [bold]{stats['file_count']:,}[/bold]")
    console.print(f"  Total size:       [bold]{stats['total_size_gb']:.1f} GB[/bold] "
                  f"/ {stats['budget_gb']:.0f} GB  "
                  f"([yellow]{stats['utilization_pct']:.1f}%[/yellow] utilized)")

    # Break down by type
    ext_counts: dict[str, int] = {}
    ext_sizes: dict[str, int] = {}
    for f in selected:
        ext = f.get("ext", "?").upper()
        ext_counts[ext] = ext_counts.get(ext, 0) + 1
        ext_sizes[ext] = ext_sizes.get(ext, 0) + f.get("size", 0)
    console.print()
    console.print("  By type:")
    for ext in sorted(ext_counts, key=lambda e: ext_sizes[e], reverse=True):
        console.print(f"    {ext:<8} {ext_counts[ext]:>6,} files   "
                      f"{ext_sizes[ext]/1000**3:>6.1f} GB")
    console.print()
