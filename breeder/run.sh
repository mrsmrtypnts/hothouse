#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Outside the repo, under the account's home dir and chmod 700 -- same reasoning
# as breeder's data dir: keep this isolated from other locally logged-in
# accounts on the same Mac, regardless of where the repo itself lives.
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

port_in_use() {
    "$VENV_DIR/bin/python3" -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(('127.0.0.1', $1))
except OSError:
    sys.exit(0)
else:
    s.close()
    sys.exit(1)
"
}

CONFIGURED_PORT="$("$VENV_DIR/bin/python3" -c "import config; print(config.PORT)")"

# Give the configured port a few seconds' grace before concluding
# something else actually wants it and falling back to the next one, in
# case whatever was just using it (e.g. a previous instance mid-shutdown)
# hasn't fully released it yet. Cheap insurance either way: adds no delay
# when the port's already free, and a silent drift to a new port breaks
# anything scoped to the old port's origin -- e.g. Studio's per-origin
# "viewed" tracking, which then looks like every thumbnail went unread
# (confirmed: this same mechanism turned out to also be why the sticky
# breed-controls dials looked like they were resetting on a "server
# bounce" -- sessionStorage doesn't carry over to a new port's origin).
# One confirmed trigger: a single Ctrl-C only asks uvicorn to shut down
# gracefully, which waits for existing connections (e.g. a Studio tab still
# polling) to close before it actually releases the socket -- press Ctrl-C
# twice to force an immediate exit instead. Bumped from ~2s to ~8s since
# that grace period can genuinely run longer than the original window
# covered.
GRACE_TRIES=0
while port_in_use "$CONFIGURED_PORT" && [ "$GRACE_TRIES" -lt 40 ]; do
    GRACE_TRIES=$((GRACE_TRIES + 1))
    sleep 0.2
done

PORT="$CONFIGURED_PORT"
TRIES=0
while port_in_use "$PORT"; do
    TRIES=$((TRIES + 1))
    if [ "$TRIES" -gt 20 ]; then
        echo "breeder: no free port found near $CONFIGURED_PORT after 20 tries" >&2
        exit 1
    fi
    PORT=$((PORT + 1))
done
if [ "$PORT" != "$CONFIGURED_PORT" ]; then
    echo "breeder: port $CONFIGURED_PORT already in use, using $PORT instead" >&2
fi

BREEDER_PORT="$PORT" exec "$VENV_DIR/bin/uvicorn" server:app --port "$PORT"
