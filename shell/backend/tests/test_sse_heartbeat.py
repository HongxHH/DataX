"""SSE comment heartbeat while the kernel stream is idle."""

from __future__ import annotations

import asyncio

import pytest

from shell.backend.protocol.events import SSE_FLUSH, iter_stream_with_heartbeat


@pytest.mark.asyncio
async def test_iter_stream_with_heartbeat_emits_none_while_idle():
    async def slow_stream():
        yield {"event": "stage", "data": {"hint": "正在规划…"}}
        await asyncio.sleep(0.08)
        yield {"event": "plan", "data": {"hint": "将委派 NL2SQL"}}

    items = []
    async for item in iter_stream_with_heartbeat(slow_stream(), heartbeat_s=0.03):
        items.append(item)

    assert items[0]["event"] == "stage"
    assert None in items
    assert items[-1]["event"] == "plan"
    assert SSE_FLUSH.startswith(":")


@pytest.mark.asyncio
async def test_iter_stream_with_heartbeat_ends_cleanly():
    async def finite_stream():
        yield {"event": "token", "data": {"content": "ok"}}

    items = [item async for item in iter_stream_with_heartbeat(finite_stream(), heartbeat_s=0.2)]
    assert items == [{"event": "token", "data": {"content": "ok"}}]
