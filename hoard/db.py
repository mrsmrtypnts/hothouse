"""SQLite storage for hoard: schema, connection, and multi-criteria search."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

DB_PATH = Path.home() / ".local" / "share" / "hoard" / "index.db"
LAST_DIR_FILE = Path.home() / ".local" / "share" / "hoard" / "last_dir.txt"


def get_last_scanned_dir() -> str | None:
    if LAST_DIR_FILE.exists():
        text = LAST_DIR_FILE.read_text().strip()
        return text or None
    return None


def set_last_scanned_dir(path: str) -> None:
    LAST_DIR_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_DIR_FILE.parent.chmod(0o700)
    LAST_DIR_FILE.write_text(path)

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    filename TEXT,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    positive_prompt TEXT,
    negative_prompt TEXT,
    model TEXT,
    sampler TEXT,
    seed TEXT,
    steps INTEGER,
    cfg_scale REAL,
    raw_params TEXT,
    indexed_at REAL NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS images_fts USING fts5(
    positive_prompt, negative_prompt, content=images, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS images_ai AFTER INSERT ON images BEGIN
    INSERT INTO images_fts(rowid, positive_prompt, negative_prompt)
    VALUES (new.id, new.positive_prompt, new.negative_prompt);
END;

CREATE TRIGGER IF NOT EXISTS images_ad AFTER DELETE ON images BEGIN
    INSERT INTO images_fts(images_fts, rowid, positive_prompt, negative_prompt)
    VALUES ('delete', old.id, old.positive_prompt, old.negative_prompt);
END;

CREATE TRIGGER IF NOT EXISTS images_au AFTER UPDATE ON images BEGIN
    INSERT INTO images_fts(images_fts, rowid, positive_prompt, negative_prompt)
    VALUES ('delete', old.id, old.positive_prompt, old.negative_prompt);
    INSERT INTO images_fts(rowid, positive_prompt, negative_prompt)
    VALUES (new.id, new.positive_prompt, new.negative_prompt);
END;
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after the initial schema, and backfill them."""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(images)").fetchall()}
    if "filename" not in cols:
        conn.execute("ALTER TABLE images ADD COLUMN filename TEXT")
    rows = conn.execute("SELECT id, path FROM images WHERE filename IS NULL").fetchall()
    if rows:
        conn.executemany(
            "UPDATE images SET filename = ? WHERE id = ?",
            [(Path(row["path"]).name, row["id"]) for row in rows],
        )
        conn.commit()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.parent.chmod(0o700)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def get_indexed_file(conn: sqlite3.Connection, path: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT mtime, size FROM images WHERE path = ?", (path,)
    ).fetchone()


def upsert_image(conn: sqlite3.Connection, record: dict) -> None:
    conn.execute(
        """
        INSERT INTO images (
            path, filename, mtime, size, width, height,
            positive_prompt, negative_prompt,
            model, sampler, seed, steps, cfg_scale,
            raw_params, indexed_at
        ) VALUES (
            :path, :filename, :mtime, :size, :width, :height,
            :positive_prompt, :negative_prompt,
            :model, :sampler, :seed, :steps, :cfg_scale,
            :raw_params, :indexed_at
        )
        ON CONFLICT(path) DO UPDATE SET
            filename=excluded.filename,
            mtime=excluded.mtime, size=excluded.size,
            width=excluded.width, height=excluded.height,
            positive_prompt=excluded.positive_prompt,
            negative_prompt=excluded.negative_prompt,
            model=excluded.model, sampler=excluded.sampler,
            seed=excluded.seed, steps=excluded.steps, cfg_scale=excluded.cfg_scale,
            raw_params=excluded.raw_params, indexed_at=excluded.indexed_at
        """,
        record,
    )


def delete_missing_under(conn: sqlite3.Connection, root: str, existing_paths: set[str]) -> int:
    """Remove DB rows for files under `root` that are no longer present on disk."""
    rows = conn.execute(
        "SELECT id, path FROM images WHERE path LIKE ? ESCAPE '\\'",
        (_like_prefix(root),),
    ).fetchall()
    stale_ids = [row["id"] for row in rows if row["path"] not in existing_paths]
    if stale_ids:
        conn.executemany("DELETE FROM images WHERE id = ?", [(i,) for i in stale_ids])
    return len(stale_ids)


def _like_prefix(root: str) -> str:
    escaped = root.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped.rstrip("/") + "/%"


def _like_needle(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


_TERM_RE = re.compile(r'[^,]+')


def build_fts_query(query: str) -> str | None:
    """
    Convert a comma-separated keyword query like "baz, foo" into an FTS5
    query string like '"baz" AND "foo"' (order-independent AND match).
    Returns None for an empty/whitespace-only query.
    """
    terms = [t.strip() for t in _TERM_RE.findall(query)]
    terms = [t for t in terms if t]
    if not terms:
        return None
    escaped = [t.replace('"', '""') for t in terms]
    return " AND ".join(f'"{t}"' for t in escaped)


_ASPECT_RATIO_RE = re.compile(r'^\s*(\d+(?:\.\d+)?)\s*[x:]\s*(\d+(?:\.\d+)?)\s*$')
_ASPECT_TOLERANCE = 0.03  # relative tolerance for numeric ratio matches
_SQUARE_TOLERANCE = 0.02  # relative tolerance for "square" bucket


def _parse_aspect_token(token: str) -> tuple[str, float | None] | None:
    token = token.strip().lower()
    if not token:
        return None
    if token == "portrait":
        return ("portrait", None)
    if token == "landscape":
        return ("landscape", None)
    if token == "square":
        return ("square", None)
    m = _ASPECT_RATIO_RE.match(token)
    if m:
        w, h = float(m.group(1)), float(m.group(2))
        if h == 0:
            return None
        return ("ratio", w / h)
    return None


def _aspect_sql_clause(raw_query: str) -> tuple[str | None, list]:
    """
    Build an OR'd SQL clause from a comma-separated aspect query like
    "portrait, 16x9". Unparseable tokens are silently skipped.
    """
    parts = []
    params: list = []
    for token in _TERM_RE.findall(raw_query):
        parsed = _parse_aspect_token(token)
        if parsed is None:
            continue
        kind, value = parsed
        if kind == "portrait":
            parts.append("height > width")
        elif kind == "landscape":
            parts.append("width > height")
        elif kind == "square":
            parts.append(
                "width IS NOT NULL AND height IS NOT NULL AND "
                "ABS(CAST(width AS REAL) - height) / MAX(width, height) < ?"
            )
            params.append(_SQUARE_TOLERANCE)
        elif kind == "ratio":
            parts.append(
                "width IS NOT NULL AND height IS NOT NULL AND "
                "ABS(CAST(width AS REAL) / height - ?) / ? < ?"
            )
            params.extend([value, value, _ASPECT_TOLERANCE])
    if not parts:
        return None, []
    return "(" + " OR ".join(parts) + ")", params


def _build_criteria(criteria: dict) -> tuple[str | None, str, list]:
    """
    Build the FTS match expression (or None) and a plain-SQL WHERE fragment
    (always non-empty, defaulting to "1=1") plus its bound params, from a
    criteria dict with optional keys: prompt, negative_prompt, filename, aspect.
    """
    fts_parts = []
    prompt_q = build_fts_query(criteria.get("prompt", ""))
    if prompt_q:
        fts_parts.append(f"positive_prompt: ({prompt_q})")
    negative_q = build_fts_query(criteria.get("negative_prompt", ""))
    if negative_q:
        fts_parts.append(f"negative_prompt: ({negative_q})")
    fts_query = " AND ".join(fts_parts) if fts_parts else None

    where_clauses = []
    params: list = []

    filename = criteria.get("filename", "").strip()
    if filename:
        where_clauses.append("images.filename LIKE ? ESCAPE '\\'")
        params.append(_like_needle(filename))

    aspect = criteria.get("aspect", "").strip()
    if aspect:
        clause, aparams = _aspect_sql_clause(aspect)
        if clause:
            where_clauses.append(clause)
            params.extend(aparams)

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
    return fts_query, where_sql, params


def search(conn: sqlite3.Connection, criteria: dict, limit: int = 1000, offset: int = 0) -> list[sqlite3.Row]:
    fts_query, where_sql, params = _build_criteria(criteria)
    if fts_query is None:
        sql = f"SELECT images.* FROM images WHERE {where_sql} ORDER BY images.mtime DESC LIMIT ? OFFSET ?"
        return conn.execute(sql, [*params, limit, offset]).fetchall()
    sql = f"""
        SELECT images.* FROM images_fts
        JOIN images ON images.id = images_fts.rowid
        WHERE images_fts MATCH ? AND {where_sql}
        ORDER BY images.mtime DESC
        LIMIT ? OFFSET ?
    """
    return conn.execute(sql, [fts_query, *params, limit, offset]).fetchall()


def count_matches(conn: sqlite3.Connection, criteria: dict) -> int:
    fts_query, where_sql, params = _build_criteria(criteria)
    if fts_query is None:
        sql = f"SELECT COUNT(*) FROM images WHERE {where_sql}"
        return conn.execute(sql, params).fetchone()[0]
    sql = f"""
        SELECT COUNT(*) FROM images_fts
        JOIN images ON images.id = images_fts.rowid
        WHERE images_fts MATCH ? AND {where_sql}
    """
    return conn.execute(sql, [fts_query, *params]).fetchone()[0]


def get_image(conn: sqlite3.Connection, image_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
