import copy
import json
import random
import re
from typing import Optional

import corpus
import promptsyntax
import reliability
from promptsyntax import KEYWORD_WEIGHT_RE, LORA_RE

SAMPLERS = ["DPM++ 2M SDE", "Euler a", "Euler", "DPM++ 2M", "DPM++ 2M Karras", "DPM++ SDE Karras", "UniPC"]
MODIFIERS = [
    "highly detailed", "cinematic lighting", "soft focus", "vivid colors",
    "dramatic lighting", "shallow depth of field", "intricate detail",
    "muted tones", "high contrast", "film grain",
]

KEYWORD_WEIGHT_BOUNDS = (0.3, 2.0)
LORA_WEIGHT_BOUNDS = (0.0, 1.5)
WEIGHT_STEP = 0.1
INCREASE_BIAS = 0.65  # probability a weight nudge goes up rather than down
NEGATIVE_PROMPT_CHANCE = 0.15  # how often weight/add mutators target negative_prompt
NEGATIVE_REMOVE_CHANCE = 0.6  # removal leans much more toward pruning negative_prompt


def _biased_step() -> float:
    return WEIGHT_STEP if random.random() < INCREASE_BIAS else -WEIGHT_STEP


def _apply_bounded_step(value: float, bounds: tuple[float, float]) -> float:
    lo, hi = bounds
    step = _biased_step()
    new = round(min(hi, max(lo, value + step)), 2)
    if new == round(value, 2):
        # clamped straight back to where it started -- push the other way instead
        new = round(min(hi, max(lo, value - step)), 2)
    return new


def _target_field() -> str:
    return "negative_prompt" if random.random() < NEGATIVE_PROMPT_CHANCE else "prompt"


def _existing_names(text: str) -> set[str]:
    names = set()
    for seg in promptsyntax.split_segments(text):
        seg = seg.strip()
        if not seg:
            continue
        name, _, _ = promptsyntax.parse_segment(seg)
        names.add(name)
    return names


def ensure_concrete_seed(spec: dict) -> dict:
    spec = copy.deepcopy(spec)
    if spec.get("seed", -1) in (None, -1):
        spec["seed"] = random.randint(0, 2**31 - 1)
    if spec.get("prompt"):
        spec["prompt"] = promptsyntax.normalize_prompt(spec["prompt"])
    return spec


def _reroll_seed(spec: dict) -> str:
    spec["seed"] = random.randint(0, 2**31 - 1)
    return "reroll"


def _nudge_cfg_scale(spec: dict) -> str:
    base = round(spec.get("cfg_scale", 7), 1)
    delta = random.uniform(0.3, 1.5) * random.choice((-1, 1))
    new = round(min(20.0, max(1.0, base + delta)), 1)
    spec["cfg_scale"] = new
    return f"cfg {base}→{new}"


def _nudge_steps(spec: dict) -> str:
    base = spec.get("steps", 20)
    delta = max(5, round(base * 0.2 / 5) * 5)  # ~20% of current value, rounded to a multiple of 5
    delta = delta if random.random() < 0.5 else -delta
    new = min(150, max(5, base + delta))
    spec["steps"] = new
    return f"steps {base}→{new}"


def _round64(x: float) -> int:
    return max(64, round(x / 64) * 64)


def _toggle_orientation(spec: dict) -> str:
    w = spec.get("width", 512)
    h = spec.get("height", 512)
    if w == h:
        # nothing to swap -- break the tie into a real orientation, picked at random
        new_w, new_h = (_round64(w * 1.5), h) if random.random() < 0.5 else (w, _round64(h * 1.5))
    else:
        new_w, new_h = h, w
    spec["width"], spec["height"] = new_w, new_h
    return f"{w}x{h}→{new_w}x{new_h}"


def _swap_sampler(spec: dict) -> str:
    current = spec.get("sampler_name", "Euler a")
    choices = [s for s in SAMPLERS if s != current] or SAMPLERS
    new = random.choice(choices)
    spec["sampler_name"] = new
    return f"sampler→{new}"


def _swap_model(spec: dict) -> str:
    current = spec.get("model_name", "")
    # corpus-informed rather than a fixed list (unlike _swap_sampler) --
    # there's no built-in universe of valid model names/hashes to pick from
    unreliable = reliability.unreliable_names("model")
    candidates = [
        (name, model_hash)
        for name, model_hash, _count in corpus.top_models()
        if name != current and name not in unreliable
    ]
    if not candidates:
        return _nudge_steps(spec)
    name, model_hash = random.choice(candidates)
    spec["model_name"] = name
    spec["model_hash"] = model_hash
    return f"model→{name}"


def _add_canned_keyword(spec: dict) -> str:
    # not independently selectable -- only ever reached as _add_learned_keyword's
    # fallback when the corpus has nothing to draw from, so there's always
    # *something* sensible to add for "add a keyword" rather than degrading to
    # an unrelated mutation
    prompt = spec.get("prompt", "")
    add = random.choice([m for m in MODIFIERS if m not in prompt] or MODIFIERS)
    spec["prompt"] = f"{prompt}, {add}" if prompt else add
    return f"+{add}"


def _nudge_keyword_weight(spec: dict) -> str:
    field = _target_field()
    text = spec.get(field, "")
    matches = list(KEYWORD_WEIGHT_RE.finditer(text))
    if not matches:
        return _add_learned_keyword(spec)
    m = random.choice(matches)
    name, weight = m.group(1), float(m.group(2))
    new_weight = _apply_bounded_step(weight, KEYWORD_WEIGHT_BOUNDS)
    replacement = promptsyntax.build_weighted_segment(name, new_weight)
    spec[field] = text[:m.start()] + replacement + text[m.end():]
    prefix = "neg " if field == "negative_prompt" else ""
    return f"{prefix}({name}) {weight}→{new_weight}"


def _nudge_lora_weight(spec: dict) -> str:
    field = _target_field()
    text = spec.get(field, "")
    matches = list(LORA_RE.finditer(text))
    if not matches and field != "prompt":
        field = "prompt"
        text = spec.get(field, "")
        matches = list(LORA_RE.finditer(text))
    if not matches:
        return _nudge_steps(spec)
    m = random.choice(matches)
    name, weight = m.group(1), float(m.group(2))
    new_weight = _apply_bounded_step(weight, LORA_WEIGHT_BOUNDS)
    spec[field] = text[:m.start()] + f"<lora:{name}:{new_weight}>" + text[m.end():]
    return f"lora:{name} {weight}→{new_weight}"


def _add_learned_keyword(spec: dict) -> str:
    field = _target_field()
    existing = _existing_names(spec.get(field, ""))
    candidates = corpus.top_keywords(field, existing)
    if not candidates:
        return _add_canned_keyword(spec)
    weights = [c[1] for c in candidates]
    name, _count, avg_weight = random.choices(candidates, weights=weights, k=1)[0]
    avg_weight = round(avg_weight, 1)
    addition = promptsyntax.build_weighted_segment(name, avg_weight)
    text = spec.get(field, "")
    spec[field] = f"{text}, {addition}" if text else addition
    prefix = "neg " if field == "negative_prompt" else ""
    return f"{prefix}+{name}"


def _segment_positions(text: str, *, kind: Optional[str] = None, exclude_kind: Optional[str] = None) -> list[tuple[int, int]]:
    """Returns (line_index, segment_index) pairs for segments matching the
    given kind filter -- addressing by position within split_lines'
    structure, not a flat index, so the caller can remove exactly one segment
    via split_lines/rejoin without flattening every other line in the prompt
    down to a single line in the process."""
    result = []
    for li, segs in enumerate(promptsyntax.split_lines(text)):
        for si, s in enumerate(segs):
            _, _, seg_kind = promptsyntax.parse_segment(s)
            if kind is not None and seg_kind != kind:
                continue
            if exclude_kind is not None and seg_kind == exclude_kind:
                continue
            result.append((li, si))
    return result


def _pop_segment(text: str, li: int, si: int) -> tuple[str, str]:
    """Removes the segment at (line, index) from split_lines(text), returning
    (new_text, removed_name). Drops the line entirely if it becomes empty --
    never leaves a stray blank line -- and every other line is untouched."""
    lines = promptsyntax.split_lines(text)
    name, _, _ = promptsyntax.parse_segment(lines[li][si])
    lines[li].pop(si)
    return ",\n".join(", ".join(segs) for segs in lines if segs), name


def _remove_keyword(spec: dict) -> str:
    field = "negative_prompt" if random.random() < NEGATIVE_REMOVE_CHANCE else "prompt"
    candidates = _segment_positions(spec.get(field, ""), exclude_kind="lora")
    if not candidates and field != "prompt":
        field = "prompt"
        candidates = _segment_positions(spec.get(field, ""), exclude_kind="lora")
    if not candidates:
        # nothing to remove -- a genuine no-op, not a disguised add. Keeps
        # add/remove symmetric even at the floor (see mutate_once's caller,
        # which filters out falsy tags rather than counting this as a change).
        return ""
    li, si = random.choice(candidates)
    spec[field], name = _pop_segment(spec[field], li, si)
    prefix = "neg " if field == "negative_prompt" else ""
    return f"{prefix}−{name}"


def _add_learned_lora(spec: dict) -> str:
    existing = _existing_names(spec.get("prompt", ""))
    unreliable = reliability.unreliable_names("lora")
    candidates = [c for c in corpus.top_loras(existing) if c[0] not in unreliable]
    if not candidates:
        return _nudge_lora_weight(spec)
    weights = [c[1] for c in candidates]
    name, _count, avg_weight = random.choices(candidates, weights=weights, k=1)[0]
    lo, hi = LORA_WEIGHT_BOUNDS
    avg_weight = round(min(hi, max(lo, avg_weight)), 1)
    addition = f"<lora:{name}:{avg_weight}>"
    text = spec.get("prompt", "")
    spec["prompt"] = f"{text}, {addition}" if text else addition
    return f"+lora:{name}"


def _remove_lora(spec: dict) -> str:
    field = _target_field()
    candidates = _segment_positions(spec.get(field, ""), kind="lora")
    if not candidates and field != "prompt":
        field = "prompt"
        candidates = _segment_positions(spec.get(field, ""), kind="lora")
    if not candidates:
        # nothing to remove -- a genuine no-op, same reasoning as _remove_keyword
        return ""
    li, si = random.choice(candidates)
    spec[field], name = _pop_segment(spec[field], li, si)
    return f"−lora:{name}"


# Three independent pools, one per UI slider -- each family samples its own
# expected count via _sample_count, so e.g. a keyword mutation and a lora
# mutation can both land on the same child instead of competing for one
# shared slot. Relative weights within a family still matter (which specific
# mutator fires); relative weights *across* families no longer do.
KEYWORD_MUTATORS = [
    (_add_learned_keyword, 2.0),
    (_remove_keyword, 2.0),
    (_nudge_keyword_weight, 1.0),
]

LORA_MUTATORS = [
    (_add_learned_lora, 1.0),
    (_remove_lora, 1.0),
    (_nudge_lora_weight, 1.0),
]

OTHER_MUTATORS = [
    (_nudge_cfg_scale, 0.4),
    (_nudge_steps, 0.4),
    (_swap_sampler, 0.4),
    (_swap_model, 0.05),  # no more frequent than orientation -- both jarring, keep rare
    (_toggle_orientation, 0.05),
]


def _weighted_sample(pool: list[tuple], k: int) -> list:
    pool = list(pool)
    chosen = []
    for _ in range(min(k, len(pool))):
        total = sum(w for _, w in pool)
        r = random.uniform(0, total)
        upto = 0.0
        for i, (item, w) in enumerate(pool):
            upto += w
            if upto >= r:
                chosen.append(item)
                pool.pop(i)
                break
    return chosen


_TAG_RE = re.compile(r"^(neg )?([+−])(.+)$")


def _tags_cancel(tags: list[str]) -> bool:
    # catches combos like "+hair bangs" then "-hair bangs" landing in the same
    # mutate_once call -- two independently-sampled mutators can undo each other
    seen: dict[tuple[str, str], str] = {}
    for tag in tags:
        m = _TAG_RE.match(tag)
        if not m:
            continue
        prefix, sign, name = m.groups()
        key = (prefix or "", name.strip())
        if seen.get(key, sign) != sign:
            return True
        seen[key] = sign
    return False


def _sample_count(intensity: float, pool_size: int) -> int:
    # floor + probabilistic remainder so E[k] == intensity exactly
    # (e.g. intensity=1.5 -> 50% chance of 1, 50% chance of 2)
    lo = int(intensity)
    frac = intensity - lo
    k = lo + (1 if random.random() < frac else 0)
    return max(0, min(k, pool_size))


_FAMILIES = (KEYWORD_MUTATORS, LORA_MUTATORS, OTHER_MUTATORS)


def _mutate_once_raw(
    spec: dict, reroll_probability: float, keyword_intensity: float, lora_intensity: float, other_intensity: float
) -> tuple[dict, str]:
    intensities = (keyword_intensity, lora_intensity, other_intensity)
    for _ in range(10):
        child = copy.deepcopy(spec)
        tags = []
        if random.random() < reroll_probability:
            tags.append(_reroll_seed(child))
        for pool, intensity in zip(_FAMILIES, intensities):
            k = _sample_count(intensity, len(pool))
            if k:
                tags.extend(tag for fn in _weighted_sample(pool, k=k) if (tag := fn(child)))
        if not tags:
            return child, "(no change)"
        if not _tags_cancel(tags):
            return child, ", ".join(tags)
    # give up combining and fall back to a single mutator, which can't self-cancel
    child = copy.deepcopy(spec)
    if reroll_probability > 0:
        tag = _reroll_seed(child)
    else:
        nonzero = [(pool, intensity) for pool, intensity in zip(_FAMILIES, intensities) if intensity > 0]
        if not nonzero:
            return child, "(no change)"
        pool = _weighted_sample(nonzero, k=1)[0]
        fn = _weighted_sample(pool, k=1)[0]
        tag = fn(child)
    return child, tag or "(no change)"


def mutate_once(
    spec: dict, reroll_probability: float, keyword_intensity: float, lora_intensity: float, other_intensity: float
) -> tuple[dict, str]:
    child, tag = _mutate_once_raw(spec, reroll_probability, keyword_intensity, lora_intensity, other_intensity)
    if child.get("prompt"):
        child["prompt"] = promptsyntax.normalize_prompt(child["prompt"])
    return child, tag


def generate_children(
    spec: dict,
    count: int,
    reroll_probability: float = 1.0,
    keyword_intensity: float = 1.0,
    lora_intensity: float = 1.0,
    other_intensity: float = 0.5,
) -> list[tuple[dict, str]]:
    children: list[tuple[dict, str]] = []
    seen: set[str] = set()
    for _ in range(count):
        # a collision here means two independently-sampled mutations landed on an
        # identical result (guaranteed if both knobs are 0) -- retry a few times,
        # but duplicates are an acceptable outcome of that explicit choice
        child, label = mutate_once(spec, reroll_probability, keyword_intensity, lora_intensity, other_intensity)
        key = json.dumps(child, sort_keys=True)
        attempts = 0
        while key in seen and attempts < 10:
            child, label = mutate_once(spec, reroll_probability, keyword_intensity, lora_intensity, other_intensity)
            key = json.dumps(child, sort_keys=True)
            attempts += 1
        seen.add(key)
        children.append((child, label))
    return children
