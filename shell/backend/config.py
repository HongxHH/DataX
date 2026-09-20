"""Shell backend configuration."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SHELL_ROOT = REPO_ROOT / "shell"
SESSIONS_DIR = SHELL_ROOT / ".sessions"
PROFILES_DIR = SHELL_ROOT / "profiles"
DEFAULT_CONFIG_PATH = REPO_ROOT / "dataagent" / "core" / "flex" / "examples" / "landcheck_copilot.yaml"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8788

# Copilot 子 Agent 路径解析（Windows 无 PWD）
os.environ.setdefault("DATAAGENT_REPO_ROOT", str(REPO_ROOT))


def agent_config_path() -> Path:
    env = os.getenv("SHELL_AGENT_CONFIG")
    if env:
        p = Path(env)
        return p if p.is_absolute() else REPO_ROOT / p
    return DEFAULT_CONFIG_PATH


def semantic_layer_url() -> str:
    return os.getenv("SEMANTIC_LAYER_BASE_URL", "http://localhost:32000").rstrip("/")
