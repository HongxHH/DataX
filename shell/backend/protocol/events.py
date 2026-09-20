"""Shell SSE event names and encoding."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import suppress
from enum import StrEnum
from typing import Any

PROTOCOL_VERSION = 1


class ShellEventType(StrEnum):
    STAGE = "stage"
    TOKEN = "token"
    THINK = "think"
    PLAN = "plan"
    TOOL = "tool"
    ARTIFACT = "artifact"
    LOG = "log"
    RESULT = "result"
    ERROR = "error"
    CONTEXT = "context"
    CONTEXT_USAGE = "context_usage"
    PROMPT_INVENTORY = "prompt_inventory"
    SPAN = "span"


# Defeat proxy/browser buffering (Vite http-proxy, nginx) so tiny think deltas flush immediately.
# HAZARD: 8KiB padding 按 Vite/nginx 经验值写死；若前置代理缓冲更大，think 仍可能攒批。
SSE_PADDING = ":" + (" " * 8192) + "\n\n"
SSE_FLUSH = ":\n\n"


def sse_encode(event: str, data: Any, *, version: int = PROTOCOL_VERSION) -> str:
    payload = data if isinstance(data, dict) else {"value": data}
    if "v" not in payload:
        payload = {"v": version, **payload}
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n{SSE_FLUSH}"


def shell_event(event: ShellEventType | str, data: dict[str, Any]) -> dict[str, Any]:
    return {"event": str(event), "data": {"v": PROTOCOL_VERSION, **data}}


_STREAM_END = object()


async def iter_stream_with_heartbeat(
    stream: AsyncIterator[Any],
    *,
    heartbeat_s: float,
) -> AsyncGenerator[Any, None]:
    """Yield stream items; yield ``None`` when idle for ``heartbeat_s``.

    Timeout must not cancel in-flight ``__anext__``, otherwise LangGraph / 子进程
    等待会被心跳掐掉。
    """
    if heartbeat_s <= 0:
        async for item in stream:
            yield item
        return

    aiter = stream.__aiter__()

    async def _next() -> Any:
        try:
            return await aiter.__anext__()
        except StopAsyncIteration:
            return _STREAM_END

    pending = asyncio.create_task(_next())
    try:
        while True:
            done, _ = await asyncio.wait({pending}, timeout=heartbeat_s)
            if not done:
                yield None
                continue
            item = pending.result()
            if item is _STREAM_END:
                return
            yield item
            pending = asyncio.create_task(_next())
    finally:
        if not pending.done():
            pending.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await pending
