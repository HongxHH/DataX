"""Adapter registry."""

from __future__ import annotations

from dataagent.interface.sdk.agent import DataAgent
from shell.backend.adapters.base import BaseStreamAdapter
from shell.backend.adapters.nl2sql import Nl2sqlStreamAdapter
from shell.backend.adapters.react import ReactStreamAdapter

_ADAPTER_BY_TYPE: dict[str, type[BaseStreamAdapter]] = {
    "nl2sql": Nl2sqlStreamAdapter,
    "react": ReactStreamAdapter,
}


def get_adapter_for_agent(agent: DataAgent) -> BaseStreamAdapter:
    agent_type = str(getattr(agent, "type", "react") or "react")
    cls = _ADAPTER_BY_TYPE.get(agent_type, ReactStreamAdapter)
    return cls(agent)
