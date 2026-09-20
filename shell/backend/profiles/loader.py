"""Product profile loader."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from shell.backend.config import PROFILES_DIR, REPO_ROOT, agent_config_path


@dataclass
class ProductProfile:
    id: str
    title: str
    layout: str
    agent_config: Path
    agent_type: str
    features: dict[str, Any] = field(default_factory=dict)


def _resolve_config_path(raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else REPO_ROOT / p


def load_profile_file(path: Path) -> ProductProfile:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    profile_id = str(data.get("id") or path.stem)
    agent_config_raw = str(data.get("agent_config") or "")
    if not agent_config_raw:
        raise ValueError(f"Profile {profile_id} missing agent_config")
    return ProductProfile(
        id=profile_id,
        title=str(data.get("title") or profile_id),
        layout=str(data.get("layout") or "data-workbench"),
        agent_config=_resolve_config_path(agent_config_raw),
        agent_type=str(data.get("agent_type") or "react"),
        features=dict(data.get("features") or {}),
    )


def list_profile_files() -> list[Path]:
    if not PROFILES_DIR.is_dir():
        return []
    return sorted(PROFILES_DIR.glob("*.yaml"))


def _infer_agent_meta(cfg_path: Path) -> tuple[str, str]:
    """Read AGENT_CONFIG.type from YAML and pick a default layout."""
    try:
        data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        agent_cfg = data.get("AGENT_CONFIG") or {}
        agent_type = str(agent_cfg.get("type") or "react")
    except (OSError, yaml.YAMLError):
        agent_type = "react"
    layout = "data-workbench" if agent_type == "nl2sql" else "chat-copilot"
    return agent_type, layout


def list_profiles() -> list[ProductProfile]:
    profiles: list[ProductProfile] = []
    for path in list_profile_files():
        try:
            profiles.append(load_profile_file(path))
        except (OSError, ValueError, yaml.YAMLError):
            continue
    if os.getenv("SHELL_AGENT_CONFIG", "").strip():
        if not any(p.id == "custom" for p in profiles):
            profiles.append(load_profile("custom"))
    return profiles


def resolve_active_profile_id() -> str:
    env_profile = os.getenv("SHELL_PROFILE", "").strip()
    if env_profile:
        return env_profile
    if os.getenv("SHELL_AGENT_CONFIG"):
        return "custom"
    return "landcheck-copilot"


def load_profile(profile_id: str | None = None) -> ProductProfile:
    pid = (profile_id or resolve_active_profile_id()).strip()
    if pid == "custom":
        cfg = agent_config_path()
        agent_type, layout = _infer_agent_meta(cfg)
        return ProductProfile(
            id="custom",
            title="Custom Agent",
            layout=layout,
            agent_config=cfg,
            agent_type=agent_type,
            features={},
        )
    path = PROFILES_DIR / f"{pid}.yaml"
    if path.is_file():
        return load_profile_file(path)
    for p in list_profile_files():
        try:
            prof = load_profile_file(p)
            if prof.id == pid:
                return prof
        except (ValueError, yaml.YAMLError):
            continue
    default_path = PROFILES_DIR / "landcheck-copilot.yaml"
    if default_path.is_file():
        return load_profile_file(default_path)
    cfg = agent_config_path()
    agent_type, layout = _infer_agent_meta(cfg)
    return ProductProfile(
        id="fallback",
        title="Fallback",
        layout=layout,
        agent_config=cfg,
        agent_type=agent_type,
        features={},
    )


def profile_to_dict(profile: ProductProfile) -> dict[str, Any]:
    return {
        "id": profile.id,
        "title": profile.title,
        "layout": profile.layout,
        "agent_config": str(profile.agent_config),
        "agent_type": profile.agent_type,
        "features": profile.features,
    }
