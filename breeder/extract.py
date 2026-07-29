import io
import re

from PIL import Image

FIELD_PATTERNS = {
    "steps": (r"Steps:\s*(\d+)", int),
    "sampler_name": (r"Sampler:\s*([^,]+)", str),
    "cfg_scale": (r"CFG scale:\s*([\d.]+)", float),
    "seed": (r"Seed:\s*(-?\d+)", int),
    "model_hash": (r"Model hash:\s*([^,]+)", str),
    "model_name": (r"Model:\s*([^,]+)", str),
    "clip_skip": (r"Clip skip:\s*(\d+)", int),
    "denoising_strength": (r"Denoising strength:\s*([\d.]+)", float),
}


_SETTINGS_START_RE = re.compile(r"\n?\s*Steps:\s*\d+,\s*Sampler:")
_NEGATIVE_PROMPT_RE = re.compile(r"\n?\s*Negative prompt:\s*")


def parse_parameters_text(text: str) -> dict:
    # Some tools omit the newline before the settings block and just comma-join
    # everything on one line, so split on content (anchored on "Steps: N, Sampler:")
    # rather than assuming the settings live on their own line.
    settings_m = _SETTINGS_START_RE.search(text)
    if settings_m:
        head, settings_text = text[:settings_m.start()], text[settings_m.start():]
    else:
        head, settings_text = text, ""

    neg_m = _NEGATIVE_PROMPT_RE.search(head)
    if neg_m:
        prompt = head[:neg_m.start()].strip().rstrip(",").strip()
        negative_prompt = head[neg_m.end():].strip().rstrip(",").strip()
    else:
        prompt = head.strip().rstrip(",").strip()
        negative_prompt = ""

    spec = {"prompt": prompt, "negative_prompt": negative_prompt}
    for key, (pattern, cast) in FIELD_PATTERNS.items():
        m = re.search(pattern, settings_text)
        if m:
            spec[key] = cast(m.group(1).strip())

    size_m = re.search(r"Size:\s*(\d+)x(\d+)", settings_text)
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
