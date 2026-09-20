"""Sanitize compact context_usage snapshots for SSE and session JSON."""

from __future__ import annotations

from typing import Any

_HISTORIES = frozenset({"restore", "compressed"})
_KINDS = frozenset({"ir", "fold"})
_PART_KEYS = ("system", "history", "user", "other")


def normalize_context_usage(data: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep occupancy fields only. Drops prompt/content and unknown keys."""
    if not isinstance(data, dict):
        return None
    used = _non_negative_int(data.get("used_input_tokens"))
    if used is None:
        return None
    history = str(data.get("history") or "").strip()
    if history not in _HISTORIES:
        return None
    out: dict[str, Any] = {"used_input_tokens": used, "history": history}
    window = _positive_int(data.get("context_window"))
    if window is not None:
        out["context_window"] = window
    limit = _positive_int(data.get("compress_token_limit"))
    if limit is not None:
        out["compress_token_limit"] = limit
    if history == "compressed":
        kind = str(data.get("compress_kind") or "").strip()
        if kind in _KINDS:
            out["compress_kind"] = kind
    sub_id = _positive_int(data.get("sub_id"))
    if sub_id is not None:
        out["sub_id"] = sub_id
    parts = _normalize_parts(data.get("parts"))
    if parts is not None:
        out["parts"] = parts
    return out


def is_main_agent_usage(snapshot: dict[str, Any]) -> bool:
    """True when the snapshot belongs to the main agent (no positive sub_id)."""
    return _positive_int(snapshot.get("sub_id")) is None


def list_usage_fields(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Fields stored on session list rows (main-agent occupancy only)."""
    return {key: value for key, value in snapshot.items() if key != "sub_id"}


def _non_negative_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if number < 0:
        return None
    return number


def _positive_int(value: Any) -> int | None:
    number = _non_negative_int(value)
    if number is None or number <= 0:
        return None
    return number


def _normalize_parts(raw: Any) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    out: dict[str, int] = {}
    for key in _PART_KEYS:
        number = _non_negative_int(raw.get(key))
        if number is not None:
            out[key] = number
    if not out:
        return None
    return {key: out.get(key, 0) for key in _PART_KEYS}
