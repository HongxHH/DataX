"""Agent and adapter pool with profile switching."""

from __future__ import annotations

from dataagent.interface.sdk.agent import DataAgent
from dataagent.utils.log import logger
from shell.backend.adapters.base import BaseStreamAdapter
from shell.backend.adapters.registry import get_adapter_for_agent
from shell.backend.profiles.loader import ProductProfile, load_profile, list_profiles, profile_to_dict


class AgentPool:
    def __init__(self) -> None:
        self._agents: dict[str, DataAgent] = {}
        self._adapters: dict[str, BaseStreamAdapter] = {}
        self._current_profile: ProductProfile = load_profile()
        self._ensure_loaded(self._current_profile.id)

    @property
    def current_profile(self) -> ProductProfile:
        return self._current_profile

    def list_profiles(self) -> list[dict]:
        return [profile_to_dict(p) for p in list_profiles()]

    def get_profile_dict(self) -> dict:
        data = profile_to_dict(self._current_profile)
        try:
            data["runtime_agent_type"] = str(self.get_agent().type)
        except RuntimeError:
            pass
        return data

    def _ensure_loaded(self, profile_id: str) -> None:
        if profile_id in self._agents:
            return
        profile = load_profile(profile_id)
        if not profile.agent_config.is_file():
            raise RuntimeError(f"Agent config not found: {profile.agent_config}")
        agent = DataAgent.from_config(profile.agent_config)
        actual_type = str(getattr(agent, "type", "") or "react")
        if profile.agent_type != actual_type:
            logger.warning(
                "Profile {} declares agent_type={} but config loaded type={}",
                profile.id,
                profile.agent_type,
                actual_type,
            )
        self._agents[profile_id] = agent
        self._adapters[profile_id] = get_adapter_for_agent(agent)

    def switch_profile(self, profile_id: str) -> ProductProfile:
        profile = load_profile(profile_id)
        self._ensure_loaded(profile.id)
        self._current_profile = profile
        return profile

    def get_agent(self) -> DataAgent:
        pid = self._current_profile.id
        self._ensure_loaded(pid)
        return self._agents[pid]

    def get_adapter(self) -> BaseStreamAdapter:
        pid = self._current_profile.id
        self._ensure_loaded(pid)
        return self._adapters[pid]


_pool: AgentPool | None = None


def get_pool() -> AgentPool:
    global _pool
    if _pool is None:
        _pool = AgentPool()
    return _pool
