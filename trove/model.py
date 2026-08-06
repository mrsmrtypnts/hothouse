"""
Scoring model for trove.

Weights are stored as {feature_key: weight} where feature_key is either
a plain generic feature name or an HMAC hash for sensitive keyword features.

The model is trained from pairwise comparisons using logistic regression:
given (winner_vec, loser_vec), we want score(winner) > score(loser).
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path

MODEL_PATH = Path(__file__).parent / "model.json"


# ---------------------------------------------------------------------------
# Load / save
# ---------------------------------------------------------------------------

def load_weights() -> dict[str, float]:
    if MODEL_PATH.exists():
        return json.loads(MODEL_PATH.read_text())
    return {}


def save_weights(weights: dict[str, float]) -> None:
    MODEL_PATH.write_text(json.dumps(weights, indent=2, sort_keys=True))


# ---------------------------------------------------------------------------
# Pruning
# ---------------------------------------------------------------------------

def prune_weights(weights: dict[str, float], files: list[dict]) -> tuple[dict[str, float], list[str]]:
    """
    Remove weights for features that don't appear in any file in the cache.
    Returns (pruned_weights, list_of_removed_keys).
    """
    live_keys: set[str] = set()
    for f in files:
        live_keys.update(f.get("feature_vec", {}).keys())

    removed = [k for k in weights if k not in live_keys]
    pruned = {k: v for k, v in weights.items() if k in live_keys}
    return pruned, removed


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score(feature_vec: dict[str, float], weights: dict[str, float]) -> float:
    """Dot product of feature vector and weights."""
    return sum(weights.get(k, 0.0) * v for k, v in feature_vec.items())


def top_features(feature_vec: dict[str, float], weights: dict[str, float],
                 n: int = 5) -> list[tuple[str, float]]:
    """Return the top n features by absolute weighted contribution."""
    contribs = [(k, weights.get(k, 0.0) * v) for k, v in feature_vec.items()]
    contribs.sort(key=lambda x: abs(x[1]), reverse=True)
    return contribs[:n]


# ---------------------------------------------------------------------------
# Training (logistic regression on pairs)
# ---------------------------------------------------------------------------

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def update_weights(weights: dict[str, float],
                   winner_vec: dict[str, float],
                   loser_vec: dict[str, float],
                   lr: float = 0.1) -> dict[str, float]:
    """
    One logistic regression gradient step for a single comparison.
    We want score(winner) - score(loser) to be positive.
    Loss = -log(sigmoid(score(winner) - score(loser)))
    """
    weights = dict(weights)  # don't mutate in place

    s_winner = score(winner_vec, weights)
    s_loser = score(loser_vec, weights)
    diff = s_winner - s_loser
    grad_factor = _sigmoid(diff) - 1.0  # negative, drives weights to increase diff

    all_keys = set(winner_vec) | set(loser_vec)
    for k in all_keys:
        delta = winner_vec.get(k, 0.0) - loser_vec.get(k, 0.0)
        weights[k] = weights.get(k, 0.0) - lr * grad_factor * delta

    return weights


# ---------------------------------------------------------------------------
# Active learning: pair selection
# ---------------------------------------------------------------------------

POOL_SIZE = 200
TOP_FRACTION = 0.3       # "near the top of the distribution"
TOP_BIAS_PROB = 0.85     # how often we restrict to that top slice


def _biased_pool(candidates: list[dict], weights: dict[str, float],
                 scored_cache: dict, top_fraction: float = TOP_FRACTION,
                 top_bias_prob: float = TOP_BIAS_PROB,
                 pool_size: int = POOL_SIZE) -> list[dict]:
    """
    Build the working pool for pair selection, biased toward high-scoring
    files.

    Low-scoring files are, by construction, never going to make it into a
    size-budgeted pack — spending comparisons refining their exact order
    is mostly wasted effort. Most of the time we restrict the pool to the
    top `top_fraction` of candidates by current score; the rest of the
    time we draw from the full population, so the model still gets
    occasional signal about (and from) the long tail rather than going
    completely blind to it.
    """
    def get_score(f):
        fid = f["path"]
        if fid not in scored_cache:
            scored_cache[fid] = score(f["feature_vec"], weights)
        return scored_cache[fid]

    if len(candidates) <= pool_size:
        return candidates

    if weights and random.random() < top_bias_prob:
        # Floor at 2 (not pool_size) so the restriction stays a genuine
        # top_fraction even for pools not much bigger than pool_size — the
        # len(source) <= pool_size check below already handles returning a
        # smaller-than-pool_size source safely.
        n_top = max(2, int(len(candidates) * top_fraction))
        n_top = min(n_top, len(candidates))
        source = sorted(candidates, key=get_score, reverse=True)[:n_top]
    else:
        source = candidates

    if len(source) <= pool_size:
        return source
    return random.sample(source, pool_size)


def _select_pair_uncertainty(candidates: list[dict], weights: dict[str, float],
                             scored_cache: dict) -> tuple[dict, dict, str] | None:
    """
    Uncertainty sampling: prefer pairs with similar predicted scores.
    Skips pairs with identical feature vectors (zero gradient).
    Returns (a, b, reason) or None.
    """
    def get_score(f):
        fid = f["path"]
        if fid not in scored_cache:
            scored_cache[fid] = score(f["feature_vec"], weights)
        return scored_cache[fid]

    pool = candidates if len(candidates) <= 200 else random.sample(candidates, 200)
    pool_sorted = sorted(pool, key=get_score)

    best_pair = None
    best_gap = float("inf")
    for i in range(len(pool_sorted) - 1):
        a, b = pool_sorted[i], pool_sorted[i+1]
        if a["feature_vec"] == b["feature_vec"]:
            continue
        gap = abs(get_score(b) - get_score(a))
        # If scores are tied, only include if some differing feature has nonzero
        # weight — otherwise contrastive sampling is better suited to this pair
        if gap < 1e-6:
            differing = set(a["feature_vec"]) ^ set(b["feature_vec"])
            if not any(abs(weights.get(k, 0.0)) > 1e-6 for k in differing):
                continue
        if gap < best_gap:
            best_gap = gap
            best_pair = (a, b)

    if best_pair is None:
        return None
    a, b = best_pair
    reason = f"uncertainty — scores are close ({get_score(a):.3f} vs {get_score(b):.3f})"
    return a, b, reason


def _select_pair_contrastive(candidates: list[dict],
                              weights: dict[str, float]) -> tuple[dict, dict, str] | None:
    """
    Contrastive pair selection: find two files that differ on a single
    interesting feature pair while being otherwise as similar as possible.

    Targets the feature group (same prefix) with the most uniform weights.
    Within that group, picks the two members with the most similar weights
    and finds files that each have one but not the other — so we can
    distinguish e.g. exclamations:2 vs exclamations:3, not just
    exclamations:2 vs no-exclamations.
    """
    from collections import defaultdict

    # Group weights by feature prefix (e.g. "exclamations", "size", "year")
    groups: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for key, w in weights.items():
        prefix = key.split(":")[0]
        groups[prefix].append((key, w))

    # Find the group with lowest weight variance = most undertrained
    best_group = None
    best_interest = -1.0
    for prefix, members in groups.items():
        if len(members) < 2:
            continue
        ws = [w for _, w in members]
        mean = sum(ws) / len(ws)
        variance = sum((w - mean) ** 2 for w in ws) / len(ws)
        interest = 1.0 / (variance + 1e-6)
        if interest > best_interest:
            best_interest = interest
            best_group = members

    if best_group is None:
        return None

    # Within the group, pick the two members with the most similar weights
    # — these are the ones most in need of being distinguished
    best_feat_a, best_feat_b = None, None
    best_w_gap = float("inf")
    for i in range(len(best_group)):
        for j in range(i + 1, len(best_group)):
            gap = abs(best_group[i][1] - best_group[j][1])
            if gap < best_w_gap:
                best_w_gap = gap
                best_feat_a = best_group[i][0]
                best_feat_b = best_group[j][0]

    # Find files where one has feat_a (not feat_b) and vice versa
    has_a = [f for f in candidates
             if best_feat_a in f.get("feature_vec", {})
             and best_feat_b not in f.get("feature_vec", {})]
    has_b = [f for f in candidates
             if best_feat_b in f.get("feature_vec", {})
             and best_feat_a not in f.get("feature_vec", {})]

    if not has_a or not has_b:
        # Fall back: one feature vs. neither
        has_a = [f for f in candidates if best_feat_a in f.get("feature_vec", {})]
        has_b = [f for f in candidates if best_feat_a not in f.get("feature_vec", {})]
        if not has_a or not has_b:
            return None

    # Sample for efficiency, then find the most similar cross-split pair
    # by Jaccard similarity excluding both target features
    exclude = {best_feat_a, best_feat_b}
    a_sample = random.sample(has_a, min(50, len(has_a)))
    b_sample = random.sample(has_b, min(50, len(has_b)))

    best_pair = None
    best_sim = -1.0
    for a in a_sample:
        va = set(a["feature_vec"]) - exclude
        for b in b_sample:
            if a["feature_vec"] == b["feature_vec"]:
                continue
            vb = set(b["feature_vec"]) - exclude
            union = len(va | vb)
            sim = len(va & vb) / union if union > 0 else 0.0
            if sim > best_sim:
                best_sim = sim
                best_pair = (a, b)

    if best_pair is None:
        return None
    a, b = best_pair
    reason = f"contrastive — \"{best_feat_a}\" vs \"{best_feat_b}\""
    return a, b, reason


def select_pair(candidates: list[dict], weights: dict[str, float],
                scored_cache: dict | None = None,
                contrastive_prob: float = 0.5,
                top_fraction: float = TOP_FRACTION,
                top_bias_prob: float = TOP_BIAS_PROB) -> tuple[dict, dict, str]:
    """
    Select a pair of files for comparison.

    First narrows the field to a working pool biased toward high-scoring
    files (see _biased_pool) — comparisons among low-scoring files rarely
    change what ends up in the pack. Within that pool, alternates between
    two strategies:
    - Uncertainty sampling: pick the pair with the most similar predicted
      scores — maximises information about overall ranking.
    - Contrastive sampling: pick a pair that differs on a single undertrained
      feature — helps distinguish similar feature values.

    contrastive_prob: probability of using contrastive strategy each round.
    Falls back to uncertainty sampling if contrastive finds nothing.
    Returns (file_a, file_b, reason_string).
    """
    if len(candidates) < 2:
        raise ValueError("Need at least 2 candidates")

    if scored_cache is None:
        scored_cache = {}

    pool = _biased_pool(candidates, weights, scored_cache, top_fraction, top_bias_prob)
    if len(pool) < 2:
        pool = candidates

    result = None
    if weights and random.random() < contrastive_prob:
        result = _select_pair_contrastive(pool, weights)

    if result is None:
        result = _select_pair_uncertainty(pool, weights, scored_cache)

    if result is None:
        raise ValueError("No informative pairs found — all candidates have identical feature vectors. "
                         "Try adding more keywords to ~/.config/trove/features.json.")

    return result
