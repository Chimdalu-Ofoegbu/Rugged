"""One-shot — generate + register a Circle Entity Secret.

For Circle Developer-Controlled Wallets. Generates a 32-byte entity secret,
registers its ciphertext with Circle (using CIRCLE_API_KEY from .env), and
saves the recovery file under recovery/. Run once:

    uv run python scripts/setup_entity_secret.py

The printed entity secret then goes into .env as CIRCLE_ENTITY_SECRET.
The recovery file is gitignored — store it somewhere safe offline.
"""

import os
import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv
from circle.web3 import utils

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

api_key = os.environ.get("CIRCLE_API_KEY", "")
if not api_key:
    sys.exit("CIRCLE_API_KEY missing from .env")

# 1. Generate a fresh 32-byte entity secret (64 hex chars).
#    (utils.generate_entity_secret() only prints — it returns None.)
entity_secret = secrets.token_hex(32)
print(f"ENTITY_SECRET={entity_secret}")

# 2. Register its ciphertext with Circle; save the recovery file
recovery_dir = ROOT / "recovery"
recovery_dir.mkdir(exist_ok=True)
result = utils.register_entity_secret_ciphertext(
    api_key=api_key,
    entity_secret=entity_secret,
    recoveryFileDownloadPath=str(recovery_dir),
)
print(f"REGISTERED={result}")
print(f"RECOVERY_DIR={recovery_dir}")
