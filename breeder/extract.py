import io
import re
import sys
from pathlib import Path

from PIL import Image

# sdmeta.py lives at the repo root, shared with hoard's parser -- add it to
# sys.path since breeder runs as flat scripts from within this directory
# (`uvicorn server:app`), not as an installed package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sdmeta

# Maps a Diffus API spec field to (raw metadata key name, cast function).
_FIELD_MAP = {
    "steps": ("Steps", int),
    "sampler_name": ("Sampler", str),
    "cfg_scale": ("CFG scale", float),
    "seed": ("Seed", int),
    "model_hash": ("Model hash", str),
    "model_name": ("Model", str),
    "clip_skip": ("Clip skip", int),
    "denoising_strength": ("Denoising strength", float),
}

_SIZE_RE = re.compile(r"(\d+)\s*x\s*(\d+)")


def parse_parameters_text(text: str) -> dict:
    parsed = sdmeta.parse(text)
    params = parsed["params"]
    spec = {"prompt": parsed["positive_prompt"], "negative_prompt": parsed["negative_prompt"]}

    for field, (key, cast) in _FIELD_MAP.items():
        raw = params.get(key)
        if raw is None:
            continue
        try:
            spec[field] = cast(raw)
        except ValueError:
            continue

    size_m = _SIZE_RE.match(params.get("Size", ""))
    if size_m:
        spec["width"] = int(size_m.group(1))
        spec["height"] = int(size_m.group(2))

    return spec


def extract_spec(image_bytes: bytes) -> dict:
    im = Image.open(io.BytesIO(image_bytes))
    text = im.info.get("parameters")
    if not text:
        raise ValueError("no embedded generation parameters found in this image")
    return parse_parameters_text(text)
