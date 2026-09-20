"""Read kernel OTel trajectory JSON from a session workspace."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_KEEP_TYPES = frozenset({"llm_start", "llm_end", "tool_start", "tool_end"})
_MAX_DETAIL = 4000
_SUB_FILE_RE = re.compile(r"^trajectory_(\d+)_(\d+)\.json$")


def load_session_trajectory(otel_dir: Path) -> dict[str, Any]:
    """Return summarized llm/tool groups. Missing or corrupt files yield []."""
    groups: list[dict[str, Any]] = []
    if not otel_dir.is_dir():
        return {"groups": groups}
    for path in sorted(otel_dir.glob("trajectory*.json")):
        if ".tmp." in path.name:
            continue
        groups.extend(_groups_from_file(path))
    return {"groups": groups}


def _groups_from_file(path: Path) -> list[dict[str, Any]]:
    raw = _read_json(path)
    if raw is None:
        return []
    chunks = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    source = _source_from_name(path.name)
    out: list[dict[str, Any]] = []
    for chunk in chunks:
        if not isinstance(chunk, dict):
            continue
        events = chunk.get("events")
        summarized = [_summarize_event(item) for item in events] if isinstance(events, list) else []
        group: dict[str, Any] = {
            "file": path.name,
            "role": str(chunk.get("role") or source["role"]),
            "sub_id": source["sub_id"],
            "run_id": source["run_id"] if source["run_id"] is not None else chunk.get("run_id"),
            "round_index": chunk.get("round_index", 0),
            "events": [item for item in summarized if item is not None],
        }
        parent = chunk.get("parent_tool_call_id")
        if isinstance(parent, str) and parent.strip():
            group["parent_tool_call_id"] = parent.strip()
        out.append(group)
    return out


def _source_from_name(name: str) -> dict[str, Any]:
    if name == "trajectory.json":
        return {"role": "main", "sub_id": None, "run_id": None}
    match = _SUB_FILE_RE.match(name)
    if match:
        return {"role": "sub-agent", "sub_id": int(match.group(1)), "run_id": int(match.group(2))}
    return {"role": "unknown", "sub_id": None, "run_id": None}


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def _summarize_event(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("type") or "")
    if kind not in _KEEP_TYPES:
        return None
    item: dict[str, Any] = {"type": kind}
    ts = raw.get("timestamp")
    if isinstance(ts, (int, float)):
        item["timestamp"] = ts
    if kind.startswith("llm"):
        _put_str(item, "model", raw.get("model"))
        _put_clipped(item, "prompt", raw.get("input"))
        _put_clipped(item, "content", raw.get("content"))
        _put_str(item, "finish_reason", raw.get("finish_reason"))
        usage = raw.get("usage")
        if isinstance(usage, dict):
            item["usage"] = {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            }
        return item
    _put_str(item, "tool_name", raw.get("tool_name"))
    _put_str(item, "tool_call_id", raw.get("tool_call_id"))
    if raw.get("is_error"):
        item["is_error"] = True
    _put_clipped(item, "arguments", raw.get("arguments"))
    _put_clipped(item, "result", raw.get("result"))
    return item


def _put_str(item: dict[str, Any], key: str, value: Any) -> None:
    text = str(value or "").strip()
    if text:
        item[key] = text


def _put_clipped(item: dict[str, Any], key: str, value: Any) -> None:
    if value is None or value == "":
        return
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(value)
    if len(text) > _MAX_DETAIL:
        item[key] = f"{text[:_MAX_DETAIL]}…"
        item[f"{key}_truncated"] = True
    else:
        item[key] = text
