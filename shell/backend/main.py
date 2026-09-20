"""Run the shell backend with uvicorn."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure repo root is on sys.path when running as script
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Load .env from repo root if python-dotenv is available via project
_env_file = _REPO_ROOT / ".env"
if _env_file.is_file():
    for line in _env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)

os.environ.setdefault("DATAAGENT_REPO_ROOT", str(_REPO_ROOT))

if __name__ == "__main__":
    import uvicorn

    from shell.backend.config import DEFAULT_HOST, DEFAULT_PORT

    uvicorn.run("shell.backend.app:app", host=DEFAULT_HOST, port=DEFAULT_PORT, reload=False)
