"""Base stream adapter interface."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import suppress
from typing import Any

from dataagent.interface.sdk.agent import DataAgent

from shell.backend.protocol.events import ShellEventType, shell_event


async def aclose_stream(stream: AsyncIterator[Any] | None) -> None:
    """Close an SDK astream so session workspace locks are released."""
    if stream is None:
        return
    aclose = getattr(stream, "aclose", None)
    if not callable(aclose):
        return
    with suppress(Exception, asyncio.CancelledError):
        await aclose()


def parse_stream_tuple(item: Any) -> tuple[str | None, Any] | None:
    """Normalize LangGraph astream tuples to ``(stream_mode, data)``."""
    if not isinstance(item, tuple):
        return None
    if len(item) == 3:
        _, stream_mode, data = item
        return str(stream_mode), data
    if len(item) == 2:
        stream_mode, data = item
        return str(stream_mode), data
    return None


def sdk_error_event(item: dict[str, Any]) -> dict[str, Any] | None:
    """Map an SDK ``{"error": ...}`` dict to a shell ERROR event, if present."""
    if "error" not in item:
        return None
    err = item.get("error")
    payload = err if isinstance(err, dict) else {"message": str(err)}
    return shell_event(ShellEventType.ERROR, payload)


class BaseStreamAdapter:
    """Shared holder for a DataAgent instance."""

    def __init__(self, agent: DataAgent) -> None:
        self._agent = agent

    @property
    def agent_type(self) -> str:
        return str(getattr(self._agent, "type", "react") or "react")
