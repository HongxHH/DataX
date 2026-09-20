"""Normalize compact live OTel spans for SSE and session persistence."""

from __future__ import annotations

from typing import Any

_KINDS = frozenset({"llm", "tool"})
_PHASES = frozenset({"start", "end"})
SPANS_MAX = 80


def normalize_live_span(data: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep compact span fields only. Never copies prompt/args/content."""
    if not isinstance(data, dict):
        return None
    kind = str(data.get("kind") or "")
    phase = str(data.get("phase") or "")
    if kind not in _KINDS or phase not in _PHASES:
        return None
    out: dict[str, Any] = {"kind": kind, "phase": phase}
    name = str(data.get("name") or "").strip()
    if name:
        out["name"] = name[:200]
    parent = str(data.get("parent_tool_call_id") or "").strip()
    tool_call_id = str(data.get("tool_call_id") or "").strip()
    inner = str(data.get("inner_tool_call_id") or "").strip()
    if kind == "tool" and parent and tool_call_id and tool_call_id != parent:
        out["inner_tool_call_id"] = inner or tool_call_id
        out["tool_call_id"] = parent
        out["parent_tool_call_id"] = parent
    elif parent:
        out["parent_tool_call_id"] = parent
        out["tool_call_id"] = tool_call_id or parent
    elif tool_call_id:
        out["tool_call_id"] = tool_call_id
    sub_id = data.get("sub_id")
    if isinstance(sub_id, int) and sub_id > 0:
        out["sub_id"] = sub_id
    ts = data.get("timestamp")
    if isinstance(ts, (int, float)):
        out["timestamp"] = float(ts)
    duration = data.get("duration_ms")
    if isinstance(duration, (int, float)) and duration >= 0:
        out["duration_ms"] = int(duration)
    usage = data.get("usage")
    if isinstance(usage, dict):
        compact_usage = {
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
        }
        out["usage"] = compact_usage
    if data.get("failed"):
        out["failed"] = True
    return out


def append_live_span(spans: list[dict[str, Any]], item: dict[str, Any]) -> None:
    spans.append(item)
    overflow = len(spans) - SPANS_MAX
    if overflow > 0:
        del spans[:overflow]
