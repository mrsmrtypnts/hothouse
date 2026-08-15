"""
Shared parser for Stable Diffusion "generation parameters" metadata -- the
text stored in a PNG "parameters" tEXt chunk, or a JPEG EXIF UserComment,
e.g.:

    a red bicycle, cinematic lighting, 8k
    Negative prompt: blurry, bad anatomy
    Steps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 512x768, Model: exampleModel

Some tools (or the same tool, for hires-fix/img2img jobs) omit the newline
before the settings block and comma-join everything onto one line instead --
this is anchored on the *content* of "Steps: N, Sampler:" rather than
assuming the settings live on their own line, so both forms parse the same.

Shared, dependency-free (stdlib only) module used by both breeder
(breeder/extract.py) and hoard (hoard/parse.py) -- each tool bootstraps its
own separate venv, so this stays out of both requirements.txt files.
"""

import re

_SETTINGS_START_RE = re.compile(r"\n?\s*Steps:\s*\d+,\s*Sampler:")
_NEGATIVE_PROMPT_RE = re.compile(r"\n?\s*Negative prompt:\s*", re.IGNORECASE)
_PARAM_SPLIT_RE = re.compile(r",\s+(?=[A-Za-z][A-Za-z0-9 ]*:\s)")


def parse(text: str) -> dict:
    """
    Parse a parameters blob into {positive_prompt, negative_prompt, params, raw}.
    `params` is a dict of whatever key: value pairs appear in the settings
    line (e.g. "Steps", "Sampler", "CFG scale", "Seed", "Size", "Model", ...)
    -- values are left as raw strings, callers cast whichever fields they
    need. Best-effort: returns whatever it can find, missing pieces are
    empty/absent.
    """
    # Normalize line endings first -- some tools write \r\n or bare \r
    # (old Mac-style) instead of \n, which would otherwise leave the whole
    # blob as a single unsplit "line" and silently break parsing below.
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip("\n")

    settings_m = _SETTINGS_START_RE.search(text)
    if settings_m:
        head, settings_text = text[:settings_m.start()], text[settings_m.start():]
    else:
        head, settings_text = text, ""

    neg_m = _NEGATIVE_PROMPT_RE.search(head)
    if neg_m:
        positive_prompt = head[:neg_m.start()].strip().rstrip(",").strip()
        negative_prompt = head[neg_m.end():].strip().rstrip(",").strip()
    else:
        positive_prompt = head.strip().rstrip(",").strip()
        negative_prompt = ""

    params = {}
    for chunk in _PARAM_SPLIT_RE.split(settings_text):
        if ":" not in chunk:
            continue
        key, _, value = chunk.partition(":")
        params[key.strip()] = value.strip()

    return {
        "positive_prompt": positive_prompt,
        "negative_prompt": negative_prompt,
        "params": params,
        "raw": text,
    }
