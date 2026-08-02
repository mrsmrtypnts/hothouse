import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

API_BASE = os.environ.get("BREEDER_API_BASE", "https://sd-api.diffus.me/api/v3")
API_KEY = os.environ.get("BREEDER_API_KEY", "")
# Fallback default model, used only when creating a root with no better model
# info available yet (no corpus scan, no prior generations to draw from). Not
# the normal way to pick a model -- that's the Studio UI's model dropdown, or
# whatever an imported image's own metadata specifies. Not a secret (it's a
# public checkpoint name/hash), so unlike the settings above it's fine to
# hardcode here rather than read from .env.
DEFAULT_MODEL_NAME = "ponyDiffusionV6XL_v6.safetensors"
DEFAULT_MODEL_HASH = "67ab2fd8ec"
PORT = int(os.environ.get("BREEDER_PORT", "8731"))
CORPUS_DIRS = [p.strip() for p in os.environ.get("BREEDER_CORPUS_DIRS", "").split(",") if p.strip()]

# ~/.local/share, not /tmp -- on macOS the system tempdir isn't scoped to this
# account, so generated images and prompts would otherwise be exposed to
# anyone locally logged in via Fast User Switching or su.
_default_data_dir = Path.home() / ".local" / "share" / "breeder"
DATA_DIR = Path(os.environ.get("BREEDER_DATA_DIR", _default_data_dir)).expanduser()
IMAGE_DIR = DATA_DIR / "images"
TREE_PATH = DATA_DIR / "tree.json"
CORPUS_PATH = DATA_DIR / "corpus.json"
LORA_HEALTH_PATH = DATA_DIR / "lora_health.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)
IMAGE_DIR.mkdir(parents=True, exist_ok=True)
