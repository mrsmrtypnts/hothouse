#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Outside the repo, under the account's home dir and chmod 700 -- same reasoning
# as breeder's data dir and access token: keep this isolated from other locally
# logged-in accounts on the same Mac, regardless of where the repo itself lives.
VENV_DIR="$HOME/.local/share/breeder/venv"
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
    mkdir -p "$(dirname "$VENV_DIR")"
    python3 -m venv --upgrade-deps "$VENV_DIR"
    chmod 700 "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --quiet -r requirements.txt
    requirements_hash > "$HASH_FILE"
fi

PORT="$("$VENV_DIR/bin/python3" -c "import config; print(config.PORT)")"
exec "$VENV_DIR/bin/uvicorn" server:app --port "$PORT"
