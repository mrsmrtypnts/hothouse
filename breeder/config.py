import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

API_BASE = os.environ.get("BREEDER_API_BASE", "https://sd-api.diffus.me/api/v3")
API_KEY = os.environ.get("BREEDER_API_KEY", "")
DEFAULT_MODEL_NAME = os.environ.get("BREEDER_MODEL_NAME", "")
DEFAULT_MODEL_HASH = os.environ.get("BREEDER_MODEL_HASH", "")
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
