"""Sanitize compact prompt_inventory snapshots for SSE and session JSON."""

from __future__ import annotations

import re
from typing import Any

_RECALL = frozenset({"hit", "empty", "disabled"})
_TOOL_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_NODE_TYPE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,31}$")
_WORKERS_MAX = 10
_IR_SUMMARIES_MAX = 20
_IR_NODES_MAX = 8
_SUB_INVENTORIES_MAX = 20


def normalize_prompt_inventory(data: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep packed-inventory ids/counts only. Drops prompt/query/path keys."""
    if not isinstance(data, dict):
        return None
    count = _non_negative_int(data.get("ir_summary_count"))
    if count is None:
        return None
    out: dict[str, Any] = {
        "ir_summary_count": count,
        "workers": _normalize_workers(data.get("workers")),
    }
    summaries = _normalize_summaries(data.get("ir_summaries"))
    if summaries:
        out["ir_summaries"] = summaries
    skill = _non_negative_int(data.get("skill_count"))
    if skill is not None:
        out["skill_count"] = skill
    if data.get("has_plan") is True:
        out["has_plan"] = True
    if data.get("has_memory") is True:
        out["has_memory"] = True
    if data.get("ir_unpacked") is True:
        out["ir_unpacked"] = True
    recall = str(data.get("recall") or "").strip()
    if recall in _RECALL:
        out["recall"] = recall
    sub_id = _positive_int(data.get("sub_id"))
    if sub_id is not None:
        out["sub_id"] = sub_id
    return out


def is_main_agent_inventory(snapshot: dict[str, Any]) -> bool:
    """True when the snapshot belongs to the main agent (no positive sub_id)."""
    return _positive_int(snapshot.get("sub_id")) is None


def put_sub_prompt_inventory(
    store: dict[str, dict[str, Any]],
    compact: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Keep the latest snapshot per sub_id, dropping the oldest when over cap."""
    sub_id = _positive_int(compact.get("sub_id"))
    if sub_id is None:
        return store
    key = str(sub_id)
    store.pop(key, None)
    store[key] = compact
    while len(store) > _SUB_INVENTORIES_MAX:
        store.pop(next(iter(store)))
    return store


def normalize_sub_prompt_inventories(raw: Any) -> dict[str, dict[str, Any]] | None:
    """Sanitize a sub_id → compact inventory map. Drops main-agent snapshots."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, dict[str, Any]] = {}
    for value in raw.values():
        compact = normalize_prompt_inventory(value) if isinstance(value, dict) else None
        if compact is None or is_main_agent_inventory(compact):
            continue
        put_sub_prompt_inventory(out, compact)
    return out or None


def _normalize_workers(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[int] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        sub_id = _positive_int(item.get("sub_id"))
        if sub_id is None or sub_id in seen:
            continue
        seen.add(sub_id)
        count = _non_negative_int(item.get("artifact_count")) or 0
        out.append(
            {
                "sub_id": sub_id,
                "artifact_count": count,
                "has_error": item.get("has_error") is True,
            }
        )
        if len(out) >= _WORKERS_MAX:
            break
    return out


def _normalize_summaries(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        entry: dict[str, Any] = {}
        tool = str(item.get("tool") or "").strip()
        if _TOOL_NAME.match(tool):
            entry["tool"] = tool
        nodes = _normalize_nodes(item.get("nodes"))
        if nodes:
            entry["nodes"] = nodes
        if entry:
            out.append(entry)
        if len(out) >= _IR_SUMMARIES_MAX:
            break
    return out


def _normalize_nodes(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        name = str(item or "").strip()
        if not _NODE_TYPE.match(name) or name in seen:
            continue
        seen.add(name)
        out.append(name)
        if len(out) >= _IR_NODES_MAX:
            break
    return out


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
