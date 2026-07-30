import asyncio
import base64
import time
from typing import Optional
from urllib.parse import urlparse

import httpx

import config

HEADERS = {"x-diffus-passkey": config.API_KEY}

POLL_INTERVAL = 1.5
POLL_TIMEOUT = 240


async def submit(spec: dict) -> str:
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.post(f"{config.API_BASE}/txt2img", json=spec, headers=HEADERS)
        resp.raise_for_status()
        body = resp.json()
        return body["data"]["task_id"]


async def check_progress(task_id: str) -> Optional[dict]:
    """Single progress check. Returns the data dict if the task has finished,
    None if it's still in progress, or raises if it failed."""
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.get(
            f"{config.API_BASE}/progress",
            params={"task_id": task_id},
            headers=HEADERS,
        )
        resp.raise_for_status()
        data = resp.json()["data"]
        if data.get("failed_reason"):
            raise RuntimeError(data["failed_reason"])
        return data if data.get("imgs") else None


async def _poll(task_id: str) -> dict:
    deadline = time.monotonic() + POLL_TIMEOUT
    while time.monotonic() < deadline:
        data = await check_progress(task_id)
        if data is not None:
            return data
        await asyncio.sleep(POLL_INTERVAL)
    raise TimeoutError(f"task {task_id} did not finish in time")


def _filename_from_url(url: str) -> Optional[str]:
    name = urlparse(url).path.rstrip("/").split("/")[-1]
    return name if name and "." in name else None


async def _fetch_image(entry: str, http: httpx.AsyncClient) -> tuple[bytes, Optional[str]]:
    if entry.startswith("http://") or entry.startswith("https://"):
        resp = await http.get(entry)
        resp.raise_for_status()
        return resp.content, _filename_from_url(entry)
    return base64.b64decode(entry), None


async def fetch_images(data: dict) -> list[tuple[bytes, Optional[str]]]:
    async with httpx.AsyncClient(timeout=60) as http:
        return [await _fetch_image(e, http) for e in data["imgs"]]


async def poll_and_fetch(task_id: str) -> list[tuple[bytes, Optional[str]]]:
    data = await _poll(task_id)
    return await fetch_images(data)


async def render(spec: dict) -> list[tuple[bytes, Optional[str]]]:
    task_id = await submit(spec)
    return await poll_and_fetch(task_id)


async def submit_img2img(spec: dict, init_image_b64: str) -> str:
    body = {**spec, "mode": 0, "init_img": {"encoded_image": init_image_b64}}
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.post(f"{config.API_BASE}/img2img", json=body, headers=HEADERS)
        resp.raise_for_status()
        return resp.json()["data"]["task_id"]


async def render_img2img(spec: dict, init_image_b64: str) -> list[tuple[bytes, Optional[str]]]:
    task_id = await submit_img2img(spec, init_image_b64)
    return await poll_and_fetch(task_id)
