#!/bin/bash
# Installs the native messaging host for the Image Downloader Chrome extension.
# Usage: ./install.sh <extension-id>
#
# Find your extension ID at chrome://extensions after loading the unpacked extension.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="$SCRIPT_DIR/image_downloader.py"
WRAPPER="$SCRIPT_DIR/host_wrapper.sh"
HOST_NAME="com.imagedl.host"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install.sh <extension-id>"
  echo ""
  echo "To find your extension ID:"
  echo "  1. Go to chrome://extensions"
  echo "  2. Enable Developer mode (top-right toggle)"
  echo "  3. Load the unpacked extension (Load unpacked button)"
  echo "  4. Copy the ID shown under the extension name"
  exit 1
fi

# Locate python3 at install time so Chrome doesn't need the user's PATH
PYTHON3="$(command -v python3 || true)"
if [ -z "$PYTHON3" ]; then
  # Common Homebrew / system locations
  for candidate in /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
    if [ -x "$candidate" ]; then PYTHON3="$candidate"; break; fi
  done
fi
if [ -z "$PYTHON3" ]; then
  echo "Error: python3 not found. Install it with: brew install python3"
  exit 1
fi
echo "Using Python: $PYTHON3  ($(${PYTHON3} --version))"

# Write a small wrapper so Chrome gets the exact python3 path and the right
# working directory, regardless of what PATH it inherits.
cat > "$WRAPPER" << WRAPPER_EOF
#!/bin/bash
exec "$PYTHON3" "$PYTHON_SCRIPT"
WRAPPER_EOF
chmod +x "$WRAPPER"
chmod +x "$PYTHON_SCRIPT"
mkdir -p "$MANIFEST_DIR"

cat > "$MANIFEST_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "Image Downloader native host",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Done. Native messaging host installed:"
echo "  Manifest : $MANIFEST_DIR/$HOST_NAME.json"
echo "  Wrapper  : $WRAPPER"
echo "  Script   : $PYTHON_SCRIPT"
echo ""
echo "If Chrome was already running, restart it for the change to take effect."
