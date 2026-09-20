# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ============================================================================
"""Compact packed-prompt inventory for the shell. Never copies prompt text."""

from __future__ import annotations

import json
import re
from typing import Any

from langchain_core.messages import ToolMessage

from dataagent.core.flex.context_usage import IR_SUMMARY_PREFIX

IR_UNPACKED_PREFIX = "[IR Unpacked]"
_JSON_FENCE = "```json"
_SKILL_MARK = "### Skill:"
_HAS_PLAN_MARK = "**Overall task (introduction):**"
_MEMORY_MARKS = (
    "# User Memory",
    "**Session Snapshot:**",
    "**User Profile:**",
    "**Cross-Session Memories:**",
)
_RECALL_PACKED_MARK = "**Cross-Session Memories:**"
_IR_TOOL = re.compile(r"\[IR Summary\]\s*tool=([A-Za-z0-9_.-]+)")
_IR_NODE = re.compile(r"^-\s+([A-Za-z][A-Za-z0-9]*)\(")
_TOOL_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_WORKERS_MAX = 10
_IR_SUMMARIES_MAX = 20
_IR_NODES_MAX = 8


def prompt_inventory_from_messages(messages: Any, *, state: Any = None) -> dict[str, Any]:
    """Inspect assembled planner messages. Omits query/answer/path/prompt keys."""
    items = [message for message in (messages or []) if message is not None]
    workers = _compact_workers(items)
    summaries = _compact_ir_summaries(items)
    joined = "\n".join(_message_text(message) for message in items)
    payload: dict[str, Any] = {
        "type": "prompt_inventory",
        "workers": workers,
        "ir_summary_count": len(summaries),
        "skill_count": joined.count(_SKILL_MARK),
        "has_plan": _HAS_PLAN_MARK in joined,
        "has_memory": any(mark in joined for mark in _MEMORY_MARKS),
        "ir_unpacked": _has_ir_unpacked(items),
    }
    if summaries:
        payload["ir_summaries"] = summaries
    if _RECALL_PACKED_MARK in joined:
        payload["recall"] = "hit"
    sub_id = None
    if isinstance(state, dict):
        sub_id = _positive_int(state.get("sub_id"))
    if sub_id is not None:
        payload["sub_id"] = sub_id
    return payload


def emit_prompt_inventory(writer: Any, payload: dict[str, Any] | None) -> None:
    """Write a compact inventory if a writer is available."""
    if writer is None or not isinstance(payload, dict):
        return
    writer(payload)


def _compact_workers(messages: list[Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    seen: set[int] = set()
    for message in messages:
        if _message_role(message) != "system":
            continue
        for raw in _iter_json_arrays(_message_text(message)):
            for item in raw:
                compact = _compact_worker(item)
                if compact is None:
                    continue
                sub_id = compact["sub_id"]
                if sub_id in seen:
                    continue
                seen.add(sub_id)
                found.append(compact)
                if len(found) >= _WORKERS_MAX:
                    return found
    return found


def _compact_worker(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    sub_id = _positive_int(item.get("sub_id"))
    if sub_id is None:
        return None
    artifacts = item.get("artifacts")
    count = len(artifacts) if isinstance(artifacts, list) else 0
    return {
        "sub_id": sub_id,
        "artifact_count": max(0, count),
        "has_error": bool(item.get("error")),
    }


def _compact_ir_summaries(messages: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for message in messages:
        if not _is_tool_message(message) or not _is_ir_summary(message):
            continue
        text = _unwrap_results(_message_text(message))
        entry: dict[str, Any] = {}
        tool = _ir_tool_name(message, text)
        if tool:
            entry["tool"] = tool
        nodes = _ir_node_types(text)
        if nodes:
            entry["nodes"] = nodes
        out.append(entry)
        if len(out) >= _IR_SUMMARIES_MAX:
            break
    return out


def _ir_tool_name(message: Any, text: str) -> str:
    match = _IR_TOOL.search(text)
    if match:
        return match.group(1)[:64]
    raw = message.get("name") if isinstance(message, dict) else getattr(message, "name", None)
    name = str(raw or "").strip()
    if _TOOL_NAME.match(name):
        return name
    return ""


def _ir_node_types(text: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        match = _IR_NODE.match(line.strip())
        if not match:
            continue
        name = match.group(1)
        if name in seen:
            continue
        seen.add(name)
        found.append(name)
        if len(found) >= _IR_NODES_MAX:
            break
    return found


def _has_ir_unpacked(messages: list[Any]) -> bool:
    for message in messages:
        text = _unwrap_results(_message_text(message)).lstrip()
        if text.startswith(IR_UNPACKED_PREFIX):
            return True
    return False


def _iter_json_arrays(text: str) -> list[list[Any]]:
    arrays: list[list[Any]] = []
    start = 0
    decoder = json.JSONDecoder()
    while True:
        idx = text.find(_JSON_FENCE, start)
        if idx < 0:
            return arrays
        rest = text[idx + len(_JSON_FENCE) :].lstrip()
        if not rest.startswith("["):
            start = idx + len(_JSON_FENCE)
            continue
        try:
            value, _ = decoder.raw_decode(rest)
        except json.JSONDecodeError:
            start = idx + len(_JSON_FENCE)
            continue
        if isinstance(value, list):
            arrays.append(value)
        start = idx + len(_JSON_FENCE)


def _is_ir_summary(message: Any) -> bool:
    if not _is_tool_message(message):
        return False
    text = _unwrap_results(_message_text(message)).lstrip()
    return text.startswith(IR_SUMMARY_PREFIX)


def _unwrap_results(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("<results>"):
        return stripped[len("<results>") :].strip()
    return stripped


def _is_tool_message(message: Any) -> bool:
    if isinstance(message, ToolMessage):
        return True
    if isinstance(message, dict):
        kind = str(message.get("type") or "")
        return kind in {"ToolMessage", "tool"} or message.get("role") == "tool"
    return False


def _message_role(message: Any) -> str:
    if isinstance(message, dict):
        kind = str(message.get("type") or message.get("role") or "").lower()
    else:
        kind = str(getattr(message, "type", "") or "").lower()
    if kind in {"system", "sys"}:
        return "system"
    return "other"


def _message_text(message: Any) -> str:
    content = message.get("content") if isinstance(message, dict) else getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


def _positive_int(value: Any) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number
