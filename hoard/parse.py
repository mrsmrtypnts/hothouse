"""
Parse generation metadata.

Example input text (as stored in the PNG "parameters" tEXt chunk, or in the
JPEG EXIF UserComment field):

    a red bicycle, cinematic lighting, 8k
    Negative prompt: blurry, bad anatomy
    Steps: 20, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 512x768, Model: exampleModel
"""

import re

_PARAM_LINE_SPLIT_RE = re.compile(r",\s+(?=[A-Za-z][A-Za-z0-9 ]*:\s)")
_NEGATIVE_PREFIX_RE = re.compile(r"^Negative prompt:\s*", re.IGNORECASE)


def parse_parameters(text: str) -> dict:
    """
    Parse a parameters blob into a structured dict:
    {positive_prompt, negative_prompt, params: {key: value}, raw}
    Best-effort: returns whatever it can find, missing pieces are None/empty.
    """
    # Normalize line endings first — some tools write \r\n or bare \r
    # (old Mac-style) instead of \n, which would otherwise leave the whole
    # blob as a single unsplit "line" and silently break parsing below.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.strip("\n")
    lines = text.split("\n")

    # The last line is (almost always) the "Steps: .., Sampler: .., ..." line.
    params_line = None
    if lines and re.search(r"\bSteps:\s*\d", lines[-1]):
        params_line = lines.pop()

    negative_prompt = ""
    body_lines = lines
    for i, line in enumerate(lines):
        if _NEGATIVE_PREFIX_RE.match(line):
            negative_prompt = "\n".join(
                [_NEGATIVE_PREFIX_RE.sub("", line)] + lines[i + 1:]
            ).strip()
            body_lines = lines[:i]
            break

    positive_prompt = "\n".join(body_lines).strip()

    params = {}
    if params_line:
        for chunk in _PARAM_LINE_SPLIT_RE.split(params_line):
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
