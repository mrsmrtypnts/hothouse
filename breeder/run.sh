#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR=".venv"
HASH_FILE="$VENV_DIR/.requirements.sha256"

requirements_hash() {
    shasum -a 256 requirements.txt | awk '{print $1}'
}

venv_is_current() {
    [ -x "$VENV_DIR/bin/uvicorn" ] \
        && [ -f "$HASH_FILE" ] \
        && [ "$(cat "$HASH_FILE")" = "$(requirements_hash)" ]
}

if ! venv_is_current; then
    echo "breeder: setting up its Python environment (first run only)..." >&2
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip
    "$VENV_DIR/bin/pip" install --quiet -r requirements.txt
    requirements_hash > "$HASH_FILE"
fi

PORT="$("$VENV_DIR/bin/python3" -c "import config; print(config.PORT)")"
exec "$VENV_DIR/bin/uvicorn" server:app --port "$PORT"
