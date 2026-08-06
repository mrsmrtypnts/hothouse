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
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
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
# Cutoff samples at various budget thresholds
# ---------------------------------------------------------------------------

# 1-2-5 sequence from 10 MB to 1 TB, in GB (1024-based, matching the rest
# of the codebase).
CUTOFF_THRESHOLDS_GB = [
    0.01, 0.02, 0.05,
    0.1, 0.2, 0.5,
    1, 2, 5,
    10, 20, 50,
    100, 200, 500,
    1024,
]


def _gb_label(gb: float) -> str:
    return "1 TB" if gb >= 1024 else f"{gb:g} GB"


def _cutoff_window(ranked: list[dict], selected: list[dict], n: int = 5) -> list[dict]:
    """
    Return an n-file window of `ranked` straddling the pack cutoff for this
    budget — the point where `selected` (greedy_select's output, in ranked
    order) stops. Centered on the last selected file where possible.
    """
    path_to_idx = {f["path"]: i for i, f in enumerate(ranked)}
    last_idx = path_to_idx[selected[-1]["path"]]
    half = n // 2
    lo = max(0, last_idx - half + 1)
    hi = min(len(ranked), lo + n)
    lo = max(0, hi - n)  # re-clamp lo if hi got capped near the end
    return ranked[lo:hi]


def _make_cutoff_table(title: str, window: list[dict], selected_paths: set,
                       weights: dict, legend: dict) -> Table:
    """
    Like _make_table, but with a leading In/Out column — greedy_select can
    skip an oversized file and pack a smaller one from further down the
    ranking instead, so the cutoff isn't always a clean prefix and it's
    worth showing which of these specific files actually made the cut.
    """
    table = Table(title=title, box=box.SIMPLE, show_lines=False,
                  title_style="bold", expand=True)
    table.add_column("In?", width=4, justify="center")
    table.add_column("Score", style="yellow", width=7, justify="right")
    table.add_column("Size", style="cyan", width=9, justify="right")
    table.add_column("Type", style="cyan", width=5)
    table.add_column("Path", style="white", no_wrap=False)
    table.add_column("Top features", style="dim", no_wrap=False)

    for f in window:
        in_pack = f["path"] in selected_paths
        mark = "[green]✓[/green]" if in_pack else "[red]✗[/red]"
        fvec = f.get("feature_vec", {})
        top = modellib.top_features(fvec, weights, n=3)
        feat_str = "  ".join(
            _feature_display(k, c, legend)
            for k, c in top if abs(c) > 0.0001
        )
        from pathlib import Path
        parts = Path(f["path"]).parts
        display_path = str(Path(*parts[-5:])) if len(parts) >= 5 else f["path"]

        table.add_row(
            mark,
            f"{f.get('score', 0):.3f}",
            _human_size(f.get("size", 0)),
            f.get("ext", "?").upper(),
            display_path,
            feat_str or "—",
        )
    return table


def _print_cutoff_samples(files: list[dict], weights: dict, legend: dict) -> None:
    """
    For each budget threshold in CUTOFF_THRESHOLDS_GB, show the files
    straddling the pack cutoff at that budget. Thresholds where the whole
    library already fits, or where nothing fits yet, collapse to a single
    dim line instead of a full table — so output length tracks the
    library's actual size range rather than always printing all 16.
    """
    ranked = packlib.ranked_candidates(files)
    if not ranked:
        return
    total_size = sum(f["size"] for f in ranked)

    console.rule("[bold]Cutoff samples by budget[/bold]")
    console.print("[dim]What would (barely) make the cut at each budget size[/dim]\n")

    for gb in CUTOFF_THRESHOLDS_GB:
        budget = int(gb * 1024 ** 3)
        label = _gb_label(gb)

        if budget >= total_size:
            console.print(f"  [dim]{label}: entire library fits "
                          f"({len(ranked):,} files, {total_size / 1024**3:.1f} GB)[/dim]")
            continue

        selected = packlib.greedy_select(ranked, budget)
        if not selected:
            smallest = _human_size(ranked[-1]["size"])
            console.print(f"  [dim]{label}: budget too small — nothing fits "
                          f"(smallest file is {smallest})[/dim]")
            continue

        window = _cutoff_window(ranked, selected, n=5)
        selected_paths = {f["path"] for f in selected}
        selected_size_gb = sum(f["size"] for f in selected) / 1024 ** 3
        title = f"~{label} cutoff  ({len(selected):,} files, {selected_size_gb:.1f} GB)"
        console.print(_make_cutoff_table(title, window, selected_paths, weights, legend))

    console.print()


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
    - Top n_sample files by score
    - Bottom n_sample files by score
    - Random sample of n_sample from the middle
    - ASCII histogram of score distribution
    - Projected pack stats at budget_bytes
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
    console.print(f"  Total size:     [bold]{total_size / 1024**3:.1f} GB[/bold]")
    console.print(f"  Budget:         [bold]{budget_bytes / 1024**3:.0f} GB[/bold]")
    console.print(f"  Score range:    {min(scores):.3f} – {max(scores):.3f}")
    console.print()

    # --- Stratified sample ---
    top = sorted_files[:n_sample]

    bottom = sorted_files[-n_sample:]

    mid_start = len(sorted_files) // 2 - n_sample
    mid_end = len(sorted_files) // 2 + n_sample
    mid_pool = sorted_files[max(0, mid_start):mid_end]
    middle = random.sample(mid_pool, min(n_sample, len(mid_pool)))
    middle.sort(key=lambda f: f.get("score", 0), reverse=True)

    console.print(_make_table(f"Top {len(top)} files", top, weights, legend))
    console.print(_make_table(f"Middle sample ({len(middle)} files)", middle, weights, legend))
    console.print(_make_table(f"Bottom {len(bottom)} files", bottom, weights, legend))

    # --- Score histogram ---
    console.rule("[bold]Score distribution[/bold]")
    console.print(_histogram(scores))
    console.print()

    # --- Projected pack ---
    console.rule("[bold]Projected pack[/bold]")
    selected = packlib.greedy_pack(files, budget_bytes)
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
                      f"{ext_sizes[ext]/1024**3:>6.1f} GB")
    console.print()

    # --- Cutoff samples across budget thresholds ---
    _print_cutoff_samples(files, weights, legend)
