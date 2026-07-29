"""
Local web server for browsing/searching the hoard index. Binds to localhost
only — but on macOS, loopback sockets are shared across every locally
logged-in account, not just the one that started the server. If another
account is logged in at the same time (e.g. via `su` or Fast User
Switching), its processes can otherwise reach this server's port with
nothing more than a guess. ACCESS_TOKEN closes that gap: it's required once
via the URL, then carried automatically by a signed session cookie for the
rest of the browser session.
"""

import secrets
import subprocess
from pathlib import Path

from flask import Flask, jsonify, request, send_file, abort, session

from hoard import db
from hoard.thumbs import ensure_thumb

STATIC_DIR = Path(__file__).parent / "static"

ACCESS_TOKEN = secrets.token_hex(24)  # hex only — no hyphens/underscores to trip up copy-paste

app = Flask(__name__, static_folder=None)
app.secret_key = secrets.token_bytes(32)


@app.before_request
def _require_token():
    if session.get("authed"):
        return
    if request.args.get("token") == ACCESS_TOKEN:
        session["authed"] = True
        return
    abort(403)


def _row_to_summary(row) -> dict:
    return {
        "id": row["id"],
        "path": row["path"],
        "positive_prompt": row["positive_prompt"],
        "negative_prompt": row["negative_prompt"],
    }


def _row_to_detail(row) -> dict:
    d = _row_to_summary(row)
    d.update({
        "filename": row["filename"],
        "width": row["width"],
        "height": row["height"],
        "model": row["model"],
        "sampler": row["sampler"],
        "seed": row["seed"],
        "steps": row["steps"],
        "cfg_scale": row["cfg_scale"],
        "raw_params": row["raw_params"],
    })
    return d


@app.get("/")
def index():
    return send_file(STATIC_DIR / "index.html")


@app.get("/app.js")
def app_js():
    return send_file(STATIC_DIR / "app.js")


@app.get("/style.css")
def style_css():
    return send_file(STATIC_DIR / "style.css")


DEFAULT_PAGE_SIZE = 200


@app.get("/api/search")
def api_search():
    criteria = {
        "prompt": request.args.get("prompt", ""),
        "negative_prompt": request.args.get("negative_prompt", ""),
        "filename": request.args.get("filename", ""),
        "aspect": request.args.get("aspect", ""),
    }
    offset = int(request.args.get("offset", 0))
    limit = int(request.args.get("limit", DEFAULT_PAGE_SIZE))
    conn = db.connect()
    rows = db.search(conn, criteria, limit=limit, offset=offset)
    total = db.count_matches(conn, criteria)
    conn.close()
    return jsonify({
        "total": total,
        "offset": offset,
        "items": [_row_to_summary(r) for r in rows],
    })


@app.get("/api/image/<int:image_id>")
def api_image(image_id):
    conn = db.connect()
    row = db.get_image(conn, image_id)
    conn.close()
    if row is None:
        abort(404)
    return jsonify(_row_to_detail(row))


@app.get("/thumb/<int:image_id>")
def thumb(image_id):
    conn = db.connect()
    row = db.get_image(conn, image_id)
    conn.close()
    if row is None:
        abort(404)
    path = Path(row["path"])
    if not path.exists():
        abort(404)
    return send_file(ensure_thumb(str(path)))


@app.get("/full/<int:image_id>")
def full(image_id):
    conn = db.connect()
    row = db.get_image(conn, image_id)
    conn.close()
    if row is None:
        abort(404)
    path = Path(row["path"])
    if not path.exists():
        abort(404)
    return send_file(path)


@app.post("/api/open/<int:image_id>")
def api_open(image_id):
    conn = db.connect()
    row = db.get_image(conn, image_id)
    conn.close()
    if row is None:
        abort(404)
    path = Path(row["path"])
    if not path.exists():
        abort(404)
    # `open` is macOS's own "double-click in Finder" launcher — respects
    # whatever app is set as the default for this file type.
    subprocess.run(["open", str(path)], check=True)
    return jsonify({"ok": True})


def run(port: int = 8420):
    app.run(host="127.0.0.1", port=port, debug=False)
