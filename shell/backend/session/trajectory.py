"""Read kernel OTel trajectory JSON from a session workspace."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

_KEEP_TYPES = frozenset({"llm_start", "llm_end", "tool_start", "tool_end"})
_MAX_DETAIL = 4000
_MAX_MESSAGE = 1200
_MAX_PROMPT_TOTAL = 6000
_MIN_MESSAGE_PREVIEW = 80
_SUB_FILE_RE = re.compile(r"^trajectory_(\d+)_(\d+)\.json$")
_TRAJECTORY_FILE_RE = re.compile(r"^trajectory[\w.-]*\.json$")


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


def load_trajectory_prompt(
    otel_dir: Path,
    *,
    file: str,
    event_index: int,
    chunk_index: int = 0,
) -> dict[str, Any] | None:
    """Return unclipped prompt messages for one summarized llm_start event."""
    path = _safe_otel_file(otel_dir, file)
    if path is None or event_index < 0 or chunk_index < 0:
        return None
    raw = _read_json(path)
    if raw is None:
        return None
    chunks = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    if chunk_index >= len(chunks):
        return None
    chunk = chunks[chunk_index]
    if not isinstance(chunk, dict):
        return None
    events = chunk.get("events")
    if not isinstance(events, list):
        return None
    kept = 0
    for item in events:
        summarized = _summarize_event(item, clip_prompt=False)
        if summarized is None:
            continue
        if kept == event_index:
            if summarized.get("type") != "llm_start":
                return None
            payload: dict[str, Any] = {
                "file": path.name,
                "chunk_index": chunk_index,
                "event_index": event_index,
                "truncated": False,
            }
            if "prompt_messages" in summarized:
                payload["prompt_messages"] = summarized["prompt_messages"]
            if "prompt" in summarized:
                payload["prompt"] = summarized["prompt"]
            if "prompt_messages" not in payload and "prompt" not in payload:
                return None
            return payload
        kept += 1
    return None


def _safe_otel_file(otel_dir: Path, name: str) -> Path | None:
    if not name or "/" in name or "\\" in name or ".." in name or ".tmp." in name:
        return None
    if not _TRAJECTORY_FILE_RE.match(name):
        return None
    try:
        root = otel_dir.resolve()
        path = (otel_dir / name).resolve()
    except OSError:
        return None
    if not path.is_file():
        return None
    try:
        path.relative_to(root)
    except ValueError:
        return None
    return path


def _groups_from_file(path: Path) -> list[dict[str, Any]]:
    raw = _read_json(path)
    if raw is None:
        return []
    chunks = raw if isinstance(raw, list) else [raw] if isinstance(raw, dict) else []
    source = _source_from_name(path.name)
    out: list[dict[str, Any]] = []
    for chunk_index, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            continue
        events = chunk.get("events")
        summarized: list[dict[str, Any]] = []
        if isinstance(events, list):
            for item in events:
                packed = _summarize_event(item)
                if packed is None:
                    continue
                packed["event_index"] = len(summarized)
                summarized.append(packed)
        group: dict[str, Any] = {
            "file": path.name,
            "chunk_index": chunk_index,
            "role": str(chunk.get("role") or source["role"]),
            "sub_id": source["sub_id"],
            "run_id": source["run_id"] if source["run_id"] is not None else chunk.get("run_id"),
            "round_index": chunk.get("round_index", 0),
            "events": summarized,
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


def _summarize_event(raw: Any, *, clip_prompt: bool = True) -> dict[str, Any] | None:
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
        _put_prompt(item, raw.get("input"), clip=clip_prompt)
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


def _put_prompt(item: dict[str, Any], value: Any, *, clip: bool = True) -> None:
    """Prefer per-message prompt blocks so a long system prompt cannot hide the user turn."""
    if value is None or value == "":
        return
    messages = _as_message_list(value)
    if messages is None:
        if clip:
            _put_clipped(item, "prompt", value)
        else:
            item["prompt"] = value if isinstance(value, str) else _json_text(value)
        return
    if clip:
        packed, truncated = _clip_prompt_messages(messages)
        if packed:
            item["prompt_messages"] = packed
        if truncated:
            item["prompt_truncated"] = True
        return
    packed = _pack_prompt_messages_full(messages)
    if packed:
        item["prompt_messages"] = packed


def _pack_prompt_messages_full(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    packed: list[dict[str, Any]] = []
    for raw in messages:
        role = str(raw.get("role") or "other").strip() or "other"
        packed.append({"role": role, "content": _content_text(raw.get("content"))})
    return packed


def _as_message_list(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list) or not value:
        return None
    if not all(isinstance(item, dict) for item in value):
        return None
    if not any("role" in item or "content" in item for item in value):
        return None
    return value


def _clip_prompt_messages(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    packed: list[dict[str, Any]] = []
    truncated = False
    for raw in messages:
        role = str(raw.get("role") or "other").strip() or "other"
        text = _content_text(raw.get("content"))
        clipped, cut = _clip_head(text, _MAX_MESSAGE)
        entry: dict[str, Any] = {"role": role, "content": clipped}
        if cut:
            entry["truncated"] = True
            truncated = True
        packed.append(entry)
    if _fit_prompt_total(packed):
        truncated = True
    return packed, truncated


def _fit_prompt_total(packed: list[dict[str, Any]]) -> bool:
    """Shrink earlier messages first so the last turn stays in the budget."""
    if not packed:
        return False
    overflow = sum(len(str(item.get("content") or "")) for item in packed) - _MAX_PROMPT_TOTAL
    if overflow <= 0:
        return False
    changed = False
    last = len(packed) - 1
    for index, item in enumerate(packed):
        if overflow <= 0 or index == last:
            break
        content = str(item.get("content") or "")
        keep = max(_MIN_MESSAGE_PREVIEW, len(content) - overflow)
        if keep >= len(content):
            continue
        item["content"] = f"{content[:keep]}…"
        item["truncated"] = True
        overflow -= len(content) - keep
        changed = True
    return changed


def _content_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        chunks: list[str] = []
        for part in value:
            if isinstance(part, str) and part:
                chunks.append(part)
            elif isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str) and text:
                    chunks.append(text)
                    continue
                nested = part.get("content")
                if isinstance(nested, str) and nested:
                    chunks.append(nested)
                    continue
                dumped = _json_text(part)
                if dumped:
                    chunks.append(dumped)
            else:
                chunks.append(str(part))
        return "\n".join(chunks)
    return _json_text(value)


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _clip_head(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return f"{text[:limit]}…", True


def _put_clipped(item: dict[str, Any], key: str, value: Any) -> None:
    if value is None or value == "":
        return
    text = value if isinstance(value, str) else _json_text(value)
    if len(text) > _MAX_DETAIL:
        item[key] = f"{text[:_MAX_DETAIL]}…"
        item[f"{key}_truncated"] = True
    else:
        item[key] = text
