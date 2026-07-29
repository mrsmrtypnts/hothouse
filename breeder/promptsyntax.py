import re

KEYWORD_WEIGHT_RE = re.compile(r"\(([^():]+):([0-9.]+)\)")
LORA_RE = re.compile(r"<lora:([^:>]+):([0-9.]+)>")


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
