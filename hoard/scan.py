"""Walk a directory tree, extract SD metadata from images, and index into SQLite."""

from __future__ import annotations

import struct
import sys
import time
from pathlib import Path

from PIL import Image

from hoard import db
from hoard.parse import parse_parameters

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def list_png_chunks(path: Path) -> list[dict]:
    """
    Low-level PNG chunk walk, independent of Pillow's lazy chunk parsing —
    for diagnosing extraction failures without revealing file content.
    Returns [{type, length, before_idat, keyword (if a text chunk)}, ...].
    """
    chunks = []
    seen_idat = False
    with open(path, "rb") as f:
        if f.read(8) != PNG_SIGNATURE:
            return chunks
        while True:
            header = f.read(8)
            if len(header) < 8:
                break
            length, ctype_raw = struct.unpack(">I4s", header)
            ctype = ctype_raw.decode("ascii", "replace")
            data = f.read(length)
            f.read(4)  # CRC, unused
            entry = {"type": ctype, "length": length, "before_idat": not seen_idat}
            if ctype in ("tEXt", "zTXt", "iTXt") and b"\x00" in data:
                entry["keyword"] = data.split(b"\x00", 1)[0].decode("latin-1", "replace")
            chunks.append(entry)
            if ctype == "IDAT":
                seen_idat = True
            elif ctype == "IEND":
                break
    return chunks


def find_images(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
            yield path


def extract_parameters_text(path: Path) -> str | None:
    """Read the raw SD parameters blob from a PNG tEXt chunk or JPEG EXIF UserComment."""
    return _extract_parameters_text_ex(path)[0]


def _extract_parameters_text_ex(path: Path) -> tuple[str | None, bool]:
    """Same as extract_parameters_text, but also reports whether the slow
    (post-IDAT) fallback path was needed, for perf diagnostics."""
    with Image.open(path) as im:
        if path.suffix.lower() == ".png":
            text = im.info.get("parameters")
            if text is not None:
                return text, False
            # Fast path found nothing. Pillow only parses PNG chunks before
            # IDAT during Image.open() alone, so some tools' post-IDAT
            # "parameters" chunk would still be missed here. But before
            # paying for a full pixel decode via im.load() (~10x slower) to
            # check, do a cheap structural scan (chunk headers only, no
            # decompression) — most images with no fast-path match simply
            # have no "parameters" chunk anywhere, and it'd be wasteful to
            # fully decode every one of those just to confirm that.
            has_params_chunk = any(
                c.get("keyword") == "parameters" for c in list_png_chunks(path)
            )
            if not has_params_chunk:
                return None, False
            im.load()
            return im.info.get("parameters"), True

        exif = im.getexif()
        raw = exif.get(0x9286)  # UserComment
        if not raw:
            return None, False
        if isinstance(raw, bytes):
            # EXIF UserComment is prefixed with an 8-byte character-code header.
            raw = raw[8:] if len(raw) > 8 else raw
            for enc in ("utf-16-be", "utf-16-le", "utf-8", "ascii"):
                try:
                    return raw.decode(enc).strip("\x00").strip(), False
                except (UnicodeDecodeError, UnicodeError):
                    continue
            return None, False
        return str(raw), False


def scan_directory(root: str, rescan: bool = False, progress: bool = True) -> dict:
    root_path = Path(root).expanduser().resolve()
    conn = db.connect()

    indexed = 0
    skipped = 0
    failed = 0
    empty_prompt = 0
    slow_fallback = 0
    seen_paths = set()

    paths = list(find_images(root_path))
    total = len(paths)
    is_tty = sys.stderr.isatty()
    last_report = 0.0

    for i, path in enumerate(paths, 1):
        path_str = str(path)
        seen_paths.add(path_str)
        stat = path.stat()

        if not rescan:
            existing = db.get_indexed_file(conn, path_str)
            if existing and existing["mtime"] == stat.st_mtime and existing["size"] == stat.st_size:
                skipped += 1
                continue

        try:
            with Image.open(path) as im:
                width, height = im.size

            params_text, used_fallback = _extract_parameters_text_ex(path)
            if used_fallback:
                slow_fallback += 1
            parsed = parse_parameters(params_text) if params_text else {
                "positive_prompt": "",
                "negative_prompt": "",
                "params": {},
                "raw": "",
            }
            p = parsed["params"]

            record = {
                "path": path_str,
                "filename": path.name,
                "mtime": stat.st_mtime,
                "size": stat.st_size,
                "width": width,
                "height": height,
                "positive_prompt": parsed["positive_prompt"],
                "negative_prompt": parsed["negative_prompt"],
                "model": p.get("Model"),
                "sampler": p.get("Sampler"),
                "seed": p.get("Seed"),
                "steps": int(p["Steps"]) if p.get("Steps", "").isdigit() else None,
                "cfg_scale": _to_float(p.get("CFG scale")),
                "raw_params": parsed["raw"],
                "indexed_at": time.time(),
            }
            db.upsert_image(conn, record)
            indexed += 1
            if not record["positive_prompt"] and not record["negative_prompt"]:
                empty_prompt += 1
        except Exception:
            failed += 1

        if progress and total:
            now = time.monotonic()
            if now - last_report >= 0.5 or i == total:
                last_report = now
                msg = f"Scanning: {i}/{total} ({indexed} indexed, {skipped} unchanged, {failed} failed)"
                end = "\n" if (not is_tty or i == total) else ""
                print(f"\r{msg}" if is_tty else msg, end=end, file=sys.stderr, flush=True)

    removed = db.delete_missing_under(conn, str(root_path), seen_paths)
    conn.commit()
    conn.close()

    db.set_last_scanned_dir(str(root_path))

    return {
        "indexed": indexed,
        "skipped": skipped,
        "failed": failed,
        "removed": removed,
        "empty_prompt": empty_prompt,
        "slow_fallback": slow_fallback,
    }


def _to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None
