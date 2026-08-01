import re

KEYWORD_WEIGHT_RE = re.compile(r"\(([^():]+):([0-9.]+)\)")
LORA_RE = re.compile(r"<lora:([^:>]+):([0-9.]+)>")
PONY_TAG_RE = re.compile(r"^(score_\d+(_up)?|source_\w+)$", re.IGNORECASE)

_SEGMENT_SPLIT_RE = re.compile(r"[,\n]+")


def parse_segment(seg: str) -> tuple[str, float, str]:
    """Returns (name, weight, kind) where kind is 'lora', 'weighted', or 'plain'."""
    seg = seg.strip()
    m = LORA_RE.fullmatch(seg)
    if m:
        return m.group(1).strip(), float(m.group(2)), "lora"
    m = KEYWORD_WEIGHT_RE.fullmatch(seg)
    if m:
        return m.group(1).strip(), float(m.group(2)), "weighted"
    return seg, 1.0, "plain"


def split_segments(text: str) -> list[str]:
    """Splits prompt text on commas and/or newlines -- normalize_prompt uses
    newlines as a segment separator too, so parsing has to match."""
    return _SEGMENT_SPLIT_RE.split(text)


def normalize_prompt(text: str) -> str:
    """Reorders a prompt's segments into a canonical layout: pony score/source
    tags together on the first line, then everything else, then loras last,
    one per line. Idempotent -- safe to call on an already-normalized prompt.

    Commas remain the real delimiter throughout -- the newlines inserted here
    are pure formatting, same convention as app.js's reorderLorasToEnd."""
    pony, plain, loras = [], [], []
    for seg in split_segments(text):
        seg = seg.strip()
        if not seg:
            continue
        name, _, kind = parse_segment(seg)
        if kind == "lora":
            loras.append(seg)
        elif PONY_TAG_RE.match(name):
            pony.append(seg)
        else:
            plain.append(seg)
    lines = []
    if pony:
        lines.append(", ".join(pony))
    if plain:
        lines.append(", ".join(plain))
    lines.extend(loras)
    return ",\n".join(lines)
