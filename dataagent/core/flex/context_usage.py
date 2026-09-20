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
"""Compact context-occupancy snapshot for the shell. Never copies prompt text."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import ToolMessage

from dataagent.core.cbb.runtime_env import _get_context_window
from dataagent.utils.constants import DEFAULT_COMPRESS_TOKEN_LIMIT

IR_SUMMARY_PREFIX = "[IR Summary]"
_HISTORY_RESTORE = "restore"
_HISTORY_COMPRESSED = "compressed"
_KIND_FOLD = "fold"
_KIND_IR = "ir"


def inspect_history(messages: Any) -> dict[str, str]:
    """Classify conversation history currently visible to the planner.

    Fold markers win over IR summaries. Does not return message bodies.
    """
    ir_replaced = False
    for message in messages or []:
        if _is_folded(message):
            return {"history": _HISTORY_COMPRESSED, "compress_kind": _KIND_FOLD}
        if not ir_replaced and _is_ir_summary(message):
            ir_replaced = True
    if ir_replaced:
        return {"history": _HISTORY_COMPRESSED, "compress_kind": _KIND_IR}
    return {"history": _HISTORY_RESTORE}


def context_usage_payload(
    messages: Any,
    *,
    used_input_tokens: int | None = None,
    context_window: int | None = None,
    compress_token_limit: int | None = None,
    sub_id: int | None = None,
) -> dict[str, Any]:
    """Build a ``context_usage`` custom event. Omits prompt/content keys."""
    inspected = inspect_history(messages)
    used = _non_negative_int(used_input_tokens)
    payload: dict[str, Any] = {
        "type": "context_usage",
        "history": inspected["history"],
        "used_input_tokens": 0 if used is None else used,
    }
    kind = inspected.get("compress_kind")
    if payload["history"] == _HISTORY_COMPRESSED and kind:
        payload["compress_kind"] = kind
    window = _positive_int(context_window)
    if window is not None:
        payload["context_window"] = window
    limit = _positive_int(compress_token_limit)
    if limit is not None:
        payload["compress_token_limit"] = limit
    sid = _positive_int(sub_id)
    if sid is not None:
        payload["sub_id"] = sid
    parts = _usage_parts(messages, payload["used_input_tokens"])
    if parts is not None:
        payload["parts"] = parts
    return payload


def context_usage_from_runtime(
    messages: Any,
    *,
    usage: Any = None,
    runtime: Any = None,
    state: Any = None,
    node_name: str = "planner",
) -> dict[str, Any]:
    """Resolve window/limit/sub_id from runtime + state, then build the payload."""
    used = _usage_input_tokens(usage)
    env = getattr(runtime, "env", None)
    window = _planner_context_window(env, node_name)
    limit = _effective_compress_limit(env)
    sub_id = None
    if isinstance(state, dict):
        sub_id = state.get("sub_id")
    return context_usage_payload(
        messages,
        used_input_tokens=used,
        context_window=window,
        compress_token_limit=limit,
        sub_id=sub_id,
    )


def emit_context_usage(writer: Any, payload: dict[str, Any] | None) -> None:
    """Write a compact snapshot if a writer is available."""
    if writer is None or not isinstance(payload, dict):
        return
    writer(payload)


def _planner_context_window(env: Any, node_name: str) -> int | None:
    if env is None:
        return None
    configs = getattr(env, "llm_configs", None) or {}
    if not isinstance(configs, dict):
        return None
    cfg = configs.get(node_name) or configs.get("planner") or {}
    if not isinstance(cfg, dict):
        return None
    model_id = str(cfg.get("model") or "").strip()
    if not model_id:
        return None
    return _get_context_window(model_id, cfg)


def _effective_compress_limit(env: Any) -> int:
    raw = getattr(env, "compress_token_limit", None) if env is not None else None
    limit = _positive_int(raw)
    if limit is not None:
        return limit
    return DEFAULT_COMPRESS_TOKEN_LIMIT


def _usage_input_tokens(usage: Any) -> int:
    if not isinstance(usage, dict):
        return 0
    return _non_negative_int(usage.get("input_tokens")) or 0


def _usage_parts(messages: Any, used: int) -> dict[str, int] | None:
    """Approximate system / history / current-user shares. Remainder is tools + tokenizer gap."""
    if used <= 0:
        return None
    system_msgs, history_msgs, user_msgs = _split_prompt_messages(messages)
    return _fit_parts_to_used(
        _approx_tokens(system_msgs),
        _approx_tokens(history_msgs),
        _approx_tokens(user_msgs),
        used,
    )


def _split_prompt_messages(messages: Any) -> tuple[list[Any], list[Any], list[Any]]:
    items = [message for message in (messages or []) if message is not None]
    last_human = None
    for message in reversed(items):
        if _message_role(message) == "human":
            last_human = message
            break
    system: list[Any] = []
    history: list[Any] = []
    user: list[Any] = []
    for message in items:
        if last_human is not None and message is last_human:
            user.append(message)
        elif _message_role(message) == "system":
            system.append(message)
        elif _is_tool_message(message):
            continue
        else:
            history.append(message)
    return system, history, user


def _message_role(message: Any) -> str:
    if isinstance(message, dict):
        kind = str(message.get("type") or message.get("role") or "").lower()
    else:
        kind = str(getattr(message, "type", "") or "").lower()
    if kind in {"system", "sys"}:
        return "system"
    if kind in {"human", "user"}:
        return "human"
    return "other"


def _approx_tokens(messages: list[Any]) -> int:
    if not messages:
        return 0
    try:
        from langchain_core.messages.utils import count_tokens_approximately

        counted = count_tokens_approximately(messages)
    except Exception:
        return 0
    return _non_negative_int(counted) or 0


def _fit_parts_to_used(system: int, history: int, user: int, used: int) -> dict[str, int]:
    buckets = {
        "system": max(0, system),
        "history": max(0, history),
        "user": max(0, user),
    }
    approx = sum(buckets.values())
    if approx <= 0:
        return {"system": 0, "history": 0, "user": 0, "other": used}
    if approx <= used:
        return {**buckets, "other": used - approx}
    scaled = {key: int(value * used / approx) for key, value in buckets.items()}
    drift = used - sum(scaled.values())
    order = sorted(scaled, key=lambda key: (-scaled[key], key))
    index = 0
    guard = 0
    while drift != 0 and order and guard <= used + 8:
        key = order[index % len(order)]
        if drift > 0:
            scaled[key] += 1
            drift -= 1
        elif scaled[key] > 0:
            scaled[key] -= 1
            drift += 1
        index += 1
        guard += 1
    leftover = used - sum(scaled.values())
    return {**scaled, "other": max(0, leftover)}


def _is_folded(message: Any) -> bool:
    return _additional_kwargs(message).get("_folded") is True


def _is_ir_summary(message: Any) -> bool:
    if not _is_tool_message(message):
        return False
    text = _message_text(message).strip()
    if text.startswith("<results>"):
        text = text[len("<results>") :].strip()
    return text.startswith(IR_SUMMARY_PREFIX)


def _is_tool_message(message: Any) -> bool:
    if isinstance(message, ToolMessage):
        return True
    if isinstance(message, dict):
        kind = str(message.get("type") or "")
        return kind in {"ToolMessage", "tool"} or message.get("role") == "tool"
    return False


def _additional_kwargs(message: Any) -> dict[str, Any]:
    if isinstance(message, dict):
        raw = message.get("additional_kwargs") or {}
        return raw if isinstance(raw, dict) else {}
    raw = getattr(message, "additional_kwargs", None)
    return raw if isinstance(raw, dict) else {}


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
