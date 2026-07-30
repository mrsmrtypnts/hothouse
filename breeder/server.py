import asyncio
import base64
import io
import secrets
import threading
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, PngImagePlugin
from pydantic import BaseModel

import client
import config
import corpus
import extract
import mutate
import store

# Loopback sockets on macOS are shared across every locally logged-in account,
# not just this one -- Fast User Switching or `su` lets another account reach
# this port with nothing more than a guess. ACCESS_TOKEN closes that gap: pass
# it once via ?token=, and a cookie carries it for the rest of the session.
ACCESS_TOKEN = secrets.token_hex(24)
TOKEN_COOKIE = "breeder_token"

app = FastAPI()


@app.middleware("http")
async def _require_token(request: Request, call_next):
    token = request.query_params.get("token") or request.cookies.get(TOKEN_COOKIE)
    if token != ACCESS_TOKEN:
        return PlainTextResponse("Forbidden", status_code=403)
    response = await call_next(request)
    response.set_cookie(TOKEN_COOKIE, ACCESS_TOKEN, httponly=True, samesite="lax")
    return response


@app.on_event("startup")
async def _print_access_url() -> None:
    url = f"http://127.0.0.1:{config.PORT}/?token={ACCESS_TOKEN}"
    print(f"breeder: {url}")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()


@app.on_event("startup")
async def _auto_scan_corpus() -> None:
    # bootstrap default for a fresh install only -- once any scan has ever run,
    # config.CORPUS_PATH exists and this is skipped every time after
    if config.CORPUS_DIRS and not config.CORPUS_PATH.exists():
        await asyncio.to_thread(corpus.scan, config.CORPUS_DIRS)


DEFAULTS = {
    # Pony Diffusion V6 XL was trained with score-based captions -- omitting
    # these tags noticeably degrades output. Only relevant while the bootstrap
    # default model (config.DEFAULT_MODEL_NAME) is actually in use; see the
    # PONY_PROMPT_PREFIX handling in create_root().
    "negative_prompt": (
        "score_6, score_5, score_4, source_pony, source_furry, source_cartoon, "
        "worst quality, low quality, bad anatomy, bad hands, extra digit, fewer digits, "
        "cropped, jpeg artifacts, signature, watermark, username, blurry"
    ),
    "model_name": config.DEFAULT_MODEL_NAME,
    "model_hash": config.DEFAULT_MODEL_HASH,
    "sampler_name": "Euler a",
    "steps": 20,
    "cfg_scale": 7,
    "seed": -1,
    "width": 512,
    "height": 512,
    "clip_skip": 1,
    "batch_size": 1,
    "n_iter": 1,
}

PONY_PROMPT_PREFIX = "score_9, score_8_up, score_7_up, score_6_up"

DEFAULT_DENOISING_STRENGTH = 0.75


class RootRequest(BaseModel):
    prompt: str
    overrides: dict = {}


class VariationsRequest(BaseModel):
    count: int = 6
    mode: str = "txt2img"
    denoising_strength: Optional[float] = None
    # defaults approximate the old implicit (reroll entangled with 1-2 other
    # mutators) behavior, for the old UI, which never sends these two fields
    reroll_probability: float = 0.5
    mutator_intensity: float = 1.0
    # ephemeral override for the base spec (new UI's edited form) -- never
    # written back to the parent node's stored spec
    spec: Optional[dict] = None


class CorpusScanRequest(BaseModel):
    paths: list[str]


def _image_filename(node_id: str, spec: dict) -> str:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"{stamp}-{spec.get('seed', 0)}-{node_id}.png"


def _tag_lineage(image_bytes: bytes, parent_id: str, mutation: str) -> bytes:
    im = Image.open(io.BytesIO(image_bytes))
    meta = PngImagePlugin.PngInfo()
    for k, v in im.info.items():
        if isinstance(v, str):
            meta.add_text(k, v)
    meta.add_text("parent_id", parent_id)
    meta.add_text("mutation", mutation)
    buf = io.BytesIO()
    im.save(buf, format="PNG", pnginfo=meta)
    return buf.getvalue()


# Diffus API calls are capped rather than fully serialized -- concurrency doesn't
# appear to be what's causing the intermittent webui logouts, so no need to be as
# conservative as a strict semaphore(1).
_render_semaphore = asyncio.Semaphore(3)


def _crop_and_resize(image_bytes: bytes, target_w: int, target_h: int) -> bytes:
    # The Diffus API has no resize_mode equivalent -- it always stretches the init
    # image to fit width/height. Do our own "crop and resize" (center-crop to the
    # target aspect ratio, then scale) so a mismatched aspect ratio doesn't distort.
    im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    src_w, src_h = im.size
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        new_w = round(src_h * target_ratio)
        left = (src_w - new_w) // 2
        im = im.crop((left, 0, left + new_w, src_h))
    elif src_ratio < target_ratio:
        new_h = round(src_w / target_ratio)
        top = (src_h - new_h) // 2
        im = im.crop((0, top, src_w, top + new_h))
    im = im.resize((target_w, target_h), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


async def _render_node(
    node_id: str,
    spec: dict,
    parent_id: Optional[str] = None,
    label: Optional[str] = None,
    render_mode: str = "txt2img",
    init_image_bytes: Optional[bytes] = None,
) -> None:
    try:
        async with _render_semaphore:
            if render_mode == "img2img" and init_image_bytes is not None:
                resized_init = _crop_and_resize(
                    init_image_bytes, spec.get("width", 512), spec.get("height", 512)
                )
                init_b64 = base64.b64encode(resized_init).decode()
                task_id = await client.submit_img2img(spec, init_b64)
            else:
                task_id = await client.submit(spec)
            await store.set_task_id(node_id, task_id)
            images = await client.poll_and_fetch(task_id)
            image_bytes, api_filename = images[0]
            if parent_id and label:
                image_bytes = _tag_lineage(image_bytes, parent_id, label)
            filename = api_filename or _image_filename(node_id, spec)
            (config.IMAGE_DIR / filename).write_bytes(image_bytes)
        await store.mark_done(node_id, filename)
    except Exception as exc:
        await store.mark_error(node_id, str(exc))


@app.post("/api/root")
async def create_root(req: RootRequest):
    spec = {**DEFAULTS, **req.overrides}
    prompt = req.prompt
    # only relevant while the bootstrap default model is actually in use --
    # req.overrides may have picked a different model, in which case these
    # Pony-specific tags would just be irrelevant noise
    if config.DEFAULT_MODEL_NAME and spec["model_name"] == config.DEFAULT_MODEL_NAME:
        prompt = f"{PONY_PROMPT_PREFIX}, {prompt}"
    spec["prompt"] = prompt
    spec = mutate.ensure_concrete_seed(spec)
    node = await store.create_node(spec, parent_id=None)
    asyncio.create_task(_render_node(node["id"], spec))
    return node


@app.post("/api/root/from-image")
async def create_root_from_image(file: UploadFile = File(...)):
    image_bytes = await file.read()
    try:
        extracted = extract.extract_spec(image_bytes)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    spec = mutate.ensure_concrete_seed({**DEFAULTS, **extracted})
    # "Denoising strength" only appears in metadata for img2img (or Hires Fix) jobs --
    # not a certain signal, but a reasonable default given img2img is the common case.
    inferred_mode = "img2img" if "denoising_strength" in extracted else "txt2img"
    node = await store.create_node(spec, parent_id=None, render_mode=inferred_mode)
    filename = file.filename if file.filename and "." in file.filename else _image_filename(node["id"], spec)
    (config.IMAGE_DIR / filename).write_bytes(image_bytes)
    await store.mark_done(node["id"], filename)
    return store.get(node["id"])


@app.post("/api/nodes/{node_id}/variations")
async def create_variations(node_id: str, req: VariationsRequest):
    parent = store.get(node_id)
    if parent is None:
        raise HTTPException(404, "node not found")
    if req.mode not in ("txt2img", "img2img"):
        raise HTTPException(400, "mode must be 'txt2img' or 'img2img'")
    init_bytes = None
    if req.mode == "img2img":
        if parent["status"] != "done" or not parent["image_file"]:
            raise HTTPException(400, "parent must be a completed render to use img2img")
        init_bytes = (config.IMAGE_DIR / parent["image_file"]).read_bytes()

    base_spec = req.spec if req.spec is not None else parent["spec"]
    reroll_probability = min(1.0, max(0.0, req.reroll_probability))
    mutator_intensity = max(0.0, req.mutator_intensity)
    mutations = mutate.generate_children(base_spec, req.count, reroll_probability, mutator_intensity)
    batch_id = uuid.uuid4().hex
    new_nodes = []
    for spec, label in mutations:
        if req.mode == "img2img":
            spec["denoising_strength"] = (
                req.denoising_strength if req.denoising_strength is not None else DEFAULT_DENOISING_STRENGTH
            )
        else:
            spec.pop("denoising_strength", None)
        node = await store.create_node(
            spec, parent_id=node_id, label=label, batch_id=batch_id, render_mode=req.mode
        )
        asyncio.create_task(_render_node(node["id"], spec, node_id, label, req.mode, init_bytes))
        new_nodes.append(node)
    return new_nodes


@app.get("/api/nodes/{node_id}")
async def get_node(node_id: str):
    node = store.get(node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    return node


@app.post("/api/nodes/{node_id}/retry")
async def retry_node(node_id: str):
    node = store.get(node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    if node["status"] != "error":
        raise HTTPException(400, "node is not in an error state")
    render_mode = node.get("render_mode", "txt2img")
    init_bytes = None
    if render_mode == "img2img" and node["parent_id"]:
        parent = store.get(node["parent_id"])
        if parent and parent.get("image_file"):
            init_bytes = (config.IMAGE_DIR / parent["image_file"]).read_bytes()
    await store.mark_pending(node_id)
    asyncio.create_task(
        _render_node(node_id, node["spec"], node["parent_id"], node["label"], render_mode, init_bytes)
    )
    return store.get(node_id)


@app.delete("/api/nodes/{node_id}")
async def delete_node(node_id: str):
    if store.get(node_id) is None:
        raise HTTPException(404, "node not found")
    removed = await store.delete_subtree(node_id)
    for n in removed:
        if n["image_file"]:
            f = config.IMAGE_DIR / n["image_file"]
            if f.exists():
                f.unlink()
    return {"deleted": [n["id"] for n in removed]}


@app.get("/api/nodes/{node_id}/children")
async def get_children(node_id: str):
    return store.children(node_id)


@app.get("/api/nodes/{node_id}/ancestors")
async def get_ancestors(node_id: str):
    return store.ancestors(node_id)


@app.get("/api/roots")
async def get_roots():
    return store.roots()


@app.get("/api/nodes")
async def get_all_nodes():
    return store.all_nodes()


@app.get("/api/models")
async def get_known_models():
    # merges models seen in a corpus scan with models seen in your own
    # generation history, summing counts where both agree on the same pair
    merged: dict[str, dict] = {}
    for name, model_hash, count in corpus.top_models() + store.distinct_models():
        key = f"{name}|{model_hash}"
        entry = merged.setdefault(key, {"model_name": name, "model_hash": model_hash, "count": 0})
        entry["count"] += count
    return sorted(merged.values(), key=lambda r: -r["count"])


@app.post("/api/pick-directory")
async def pick_directory():
    script = 'POSIX path of (choose folder with prompt "Select a directory to scan")'
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _stderr = await proc.communicate()
    if proc.returncode != 0:
        return {"path": None}
    return {"path": stdout.decode().strip()}


@app.post("/api/corpus/scan")
async def scan_corpus(req: CorpusScanRequest):
    return await asyncio.to_thread(corpus.scan, req.paths)


@app.get("/api/corpus/summary")
async def get_corpus_summary():
    return corpus.summary()


@app.on_event("startup")
async def recover_orphaned_renders() -> None:
    for node in store.pending_with_task_id():
        try:
            data = await client.check_progress(node["task_id"])
        except Exception as exc:
            await store.mark_error(node["id"], f"interrupted (server restart): {exc}")
            continue
        if data is None:
            await store.mark_error(
                node["id"], "interrupted (server restart); task may still be running on Diffus"
            )
            continue
        try:
            images = await client.fetch_images(data)
            image_bytes, api_filename = images[0]
            if node["parent_id"] and node["label"]:
                image_bytes = _tag_lineage(image_bytes, node["parent_id"], node["label"])
            filename = api_filename or _image_filename(node["id"], node["spec"])
            (config.IMAGE_DIR / filename).write_bytes(image_bytes)
            await store.mark_done(node["id"], filename)
        except Exception as exc:
            await store.mark_error(node["id"], str(exc))


app.mount("/images", StaticFiles(directory=str(config.IMAGE_DIR)), name="images")
# must be mounted before the catch-all "/" below -- Starlette matches mounts in
# registration order by prefix, so "/" registered first would swallow /v2/* too
app.mount("/v2", StaticFiles(directory=str(Path(__file__).parent / "static_v2"), html=True), name="static_v2")
app.mount("/", StaticFiles(directory=str(Path(__file__).parent / "static"), html=True), name="static")
