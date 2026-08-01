import re

KEYWORD_WEIGHT_RE = re.compile(r"\(([^():]+):([0-9.]+)\)")
LORA_RE = re.compile(r"<lora:([^:>]+):([0-9.]+)>")
PONY_TAG_RE = re.compile(r"^(score_\d+(_up)?|source_\w+)$", re.IGNORECASE)
# A1111-style emphasis shorthand: (foo) = 1.1, ((foo)) = 1.2, and so on --
# one balanced layer of bare parens per +0.1. Only ever read, never written
# (the app always writes the explicit name:weight form -- see
# build_weighted_segment) -- so a user's own "((foo))" is understood but
# never gets rewritten just because the app touched some *other* segment.
NESTED_WEIGHT_RE = re.compile(r"^(\(+)([^()]+)(\)+)$")

_SEGMENT_SPLIT_RE = re.compile(r"[,\n]+")

# how close a nudged/looked-up weight has to be to 1.0 to be considered
# "no weight at all" and rendered as a bare name instead of "(name:1.0)"
_UNWEIGHTED_TOLERANCE = 0.05


def parse_segment(seg: str) -> tuple[str, float, str]:
    """Returns (name, weight, kind) where kind is 'lora', 'weighted', or 'plain'."""
    seg = seg.strip()
    m = LORA_RE.fullmatch(seg)
    if m:
        return m.group(1).strip(), float(m.group(2)), "lora"
    m = KEYWORD_WEIGHT_RE.fullmatch(seg)
    if m:
        return m.group(1).strip(), float(m.group(2)), "weighted"
    m = NESTED_WEIGHT_RE.fullmatch(seg)
    if m and len(m.group(1)) == len(m.group(3)):
        depth = len(m.group(1))
        return m.group(2).strip(), round(1.0 + 0.1 * depth, 2), "weighted"
    return seg, 1.0, "plain"


def build_weighted_segment(name: str, weight: float) -> str:
    """Canonical text for a (possibly-)weighted keyword -- collapses back to
    a bare name once the weight rounds to 1.0 (e.g. after decrementing
    "(foo:1.1)" by a step) instead of ever emitting "(foo:1.0)"/"(foo:1)"."""
    if abs(weight - 1.0) < _UNWEIGHTED_TOLERANCE:
        return name
    return f"({name}:{weight})"


def split_segments(text: str) -> list[str]:
    """Splits prompt text on commas and/or newlines, discarding line
    structure -- fine for anything that only needs a flat bag of segments
    (dedup, membership checks), but never for anything that edits the text
    back, since rejoining loses the user's manual line grouping. Use
    split_lines for that instead."""
    return _SEGMENT_SPLIT_RE.split(text)


def split_lines(text: str) -> list[list[str]]:
    """Splits text into raw lines, each further split into trimmed non-empty
    comma-segments. Structure-preserving: rejoining each line's segments with
    ", " and the lines themselves with ",\\n" reproduces the original layout
    exactly. Use this (not split_segments) for anything that edits a prompt
    back, so surgically touching one segment can't disturb a user's manual
    line grouping anywhere else in the text."""
    return [[s.strip() for s in line.split(",") if s.strip()] for line in text.split("\n")]


def normalize_prompt(text: str) -> str:
    """Pulls pony score/source tags out to a new first line and loras out to
    the end (one per line), wherever in the prompt they were -- even mid-line.
    Everything else keeps its original line grouping and relative order
    completely untouched: users rely on manual newlines to cluster related
    keywords together (e.g. "foo1,foo2,\nbar1,bar2"), and this must not
    flatten that. Idempotent -- safe to call on an already-normalized prompt.

    Commas remain the real delimiter throughout -- the newlines inserted here
    are pure formatting, same convention as app.js's reorderLorasToEnd."""
    pony: list[str] = []
    loras: list[str] = []
    kept_lines: list[str] = []
    for segs in split_lines(text):
        kept: list[str] = []
        for seg in segs:
            name, _, kind = parse_segment(seg)
            if kind == "lora":
                loras.append(seg)
            elif PONY_TAG_RE.match(name):
                pony.append(seg)
            else:
                kept.append(seg)
        if kept:
            kept_lines.append(", ".join(kept))
    lines = []
    if pony:
        lines.append(", ".join(pony))
    lines.extend(kept_lines)
    lines.extend(loras)
    return ",\n".join(lines)
