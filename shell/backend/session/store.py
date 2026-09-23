"""Session metadata JSON store."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from shell.backend.config import SESSIONS_DIR
from shell.backend.protocol.context_usage import is_main_agent_usage, list_usage_fields, normalize_context_usage
from shell.backend.protocol.prompt_inventory import (
    is_main_agent_inventory,
    normalize_prompt_inventory,
    normalize_sub_prompt_inventories,
)
from shell.backend.session.clipping import (
    LOGS_MAX,
    MAIN_THINKING_MAX,
    PLAN_PREP_MAX,
    STAGES_MAX,
    SUB_THINKING_MAX,
    WORKBENCH_THINKING_MAX,
    clip_thinking_tail,
    trim_plan_prep,
)
from shell.backend.session.live_span import SPANS_MAX


def sanitize_session_id(session_id: str) -> str:
    return session_id.replace("/", "_").replace("\\", "_")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{sanitize_session_id(session_id)}.json"


def ensure_sessions_dir() -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)


def list_sessions() -> list[dict[str, Any]]:
    ensure_sessions_dir()
    sessions: list[dict[str, Any]] = []
    for path in SESSIONS_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            sessions.append(
                {
                    "id": data.get("id", path.stem),
                    "title": data.get("title", "新对话"),
                    "preview": data.get("preview", ""),
                    "created_at": data.get("created_at"),
                    "updated_at": data.get("updated_at"),
                    **_list_context_usage(data),
                }
            )
        except (json.JSONDecodeError, OSError):
            continue
    sessions.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    return sessions


def get_session(session_id: str) -> dict[str, Any] | None:
    path = _session_path(session_id)
    if not path.is_file():
        return None
    # HAZARD: 损坏 JSON 会抛到 FastAPI 500；list_sessions 会跳过坏文件。读详情与列表行为不一致。
    return json.loads(path.read_text(encoding="utf-8"))


def _new_session(session_id: str, title: str | None = None) -> dict[str, Any]:
    now = _now_iso()
    return {
        "id": session_id,
        "title": title or "新对话",
        "preview": "",
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }


def _load_or_create_session(session_id: str) -> dict[str, Any]:
    session = get_session(session_id)
    if session is None:
        return _new_session(session_id)
    return session


def ensure_session(session_id: str, title: str | None = None) -> dict[str, Any]:
    existing = get_session(session_id)
    if existing is not None:
        return existing
    return save_session(_new_session(session_id, title))


def create_session(title: str | None = None) -> dict[str, Any]:
    return save_session(_new_session(str(uuid.uuid4()), title))


def delete_session(session_id: str) -> bool:
    """Remove the session JSON. Returns False if the file was already missing."""
    path = _session_path(session_id)
    if not path.is_file():
        return False
    path.unlink()
    return True


def save_session(session: dict[str, Any]) -> dict[str, Any]:
    ensure_sessions_dir()
    session["updated_at"] = _now_iso()
    _session_path(session["id"]).write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    return session


def _non_negative_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def allocate_kernel_run_id(session_id: str) -> int:
    """Reserve the next Flex ``run_id`` for this shell session.

    Flex allows one Query node per run. Official CLI increments ``run_id`` each
    turn so planner ``initial_pt`` tracks the latest user question. Copilot must
    do the same; ``run_id`` stuck at 0 freezes planning on the first greeting.

    Missing counters (old session JSON) skip already-recorded user turns so a
    follow-up after a burned ``run_id=0`` still gets a fresh Query node.
    """
    session = _load_or_create_session(session_id)
    session["id"] = session_id
    fallback = sum(1 for msg in session.get("messages") or [] if msg.get("role") == "user")
    run_id = _non_negative_int(session.get("next_kernel_run_id"))
    if run_id is None:
        run_id = fallback
    session["next_kernel_run_id"] = run_id + 1
    save_session(session)
    return run_id


def append_user_message(session_id: str, content: str) -> dict[str, Any]:
    session = _load_or_create_session(session_id)
    session["id"] = session_id
    session["messages"].append({"role": "user", "content": content, "timestamp": _now_iso()})
    if not session.get("preview"):
        session["preview"] = content[:80]
    if session.get("title") == "新对话":
        session["title"] = content[:40] + ("…" if len(content) > 40 else "")
    return save_session(session)


def _build_assistant_message(
    content: str,
    *,
    sql: str | None = None,
    columns: list[str] | None = None,
    rows_preview: list[Any] | None = None,
    delegations: list[dict[str, Any]] | None = None,
    thinking: str | None = None,
    main_thinking: str | None = None,
    plan_hint: str | None = None,
    plan_tools: list[dict[str, Any]] | None = None,
    plan_prep: list[str] | None = None,
    stages: list[dict[str, Any]] | None = None,
    logs: list[dict[str, Any]] | None = None,
    status: str | None = None,
    turn_started_at: int | None = None,
    turn_ended_at: int | None = None,
    rewritten_query: str | None = None,
    context_usage: dict[str, Any] | None = None,
    prompt_inventory: dict[str, Any] | None = None,
    sub_prompt_inventories: dict[str, Any] | None = None,
    otel_spans: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    msg: dict[str, Any] = {"role": "assistant", "content": content, "timestamp": _now_iso()}
    if status:
        msg["status"] = status
    if turn_started_at is not None:
        msg["turn_started_at"] = turn_started_at
    if turn_ended_at is not None:
        msg["turn_ended_at"] = turn_ended_at
    if sql:
        msg["sql"] = sql
    if columns:
        msg["columns"] = columns
    if rows_preview:
        msg["rows_preview"] = rows_preview
    if delegations:
        msg["delegations"] = _trim_delegations(delegations)
    if thinking:
        msg["thinking"] = clip_thinking_tail(thinking, WORKBENCH_THINKING_MAX)
    if main_thinking:
        msg["main_thinking"] = clip_thinking_tail(main_thinking, MAIN_THINKING_MAX)
    if plan_hint:
        msg["plan_hint"] = plan_hint
    if plan_tools:
        msg["plan_tools"] = plan_tools
    if plan_prep:
        msg["plan_prep"] = trim_plan_prep(plan_prep, PLAN_PREP_MAX)
    if stages:
        msg["stages"] = stages[-STAGES_MAX:]
    if logs:
        msg["logs"] = logs[-LOGS_MAX:]
    if rewritten_query:
        msg["rewritten_query"] = rewritten_query
    compact_usage = normalize_context_usage(context_usage) if isinstance(context_usage, dict) else None
    if compact_usage:
        msg["context_usage"] = compact_usage
    compact_inventory = (
        normalize_prompt_inventory(prompt_inventory) if isinstance(prompt_inventory, dict) else None
    )
    if compact_inventory and is_main_agent_inventory(compact_inventory):
        msg["prompt_inventory"] = compact_inventory
    compact_subs = normalize_sub_prompt_inventories(sub_prompt_inventories)
    if compact_subs:
        msg["sub_prompt_inventories"] = compact_subs
    if otel_spans:
        msg["otel_spans"] = otel_spans[-SPANS_MAX:]
    return msg


def append_assistant_message(
    session_id: str,
    content: str,
    **kwargs: Any,
) -> dict[str, Any]:
    session = _load_or_create_session(session_id)
    session["messages"].append(_build_assistant_message(content, **kwargs))
    _remember_session_usage(session, kwargs.get("context_usage"))
    return save_session(session)


def upsert_assistant_message(
    session_id: str,
    content: str,
    **kwargs: Any,
) -> dict[str, Any]:
    """Replace the trailing in-progress assistant message, otherwise append."""
    session = _load_or_create_session(session_id)
    msg = _build_assistant_message(content, **kwargs)
    messages = session["messages"]
    if messages and messages[-1].get("role") == "assistant" and messages[-1].get("status") == "running":
        messages[-1] = msg
    else:
        messages.append(msg)
    _remember_session_usage(session, kwargs.get("context_usage"))
    return save_session(session)


def _remember_session_usage(session: dict[str, Any], usage: Any) -> None:
    compact = normalize_context_usage(usage) if isinstance(usage, dict) else None
    if not compact or not is_main_agent_usage(compact):
        return
    session["context_usage"] = compact


def _list_context_usage(data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("context_usage")
    compact = normalize_context_usage(raw) if isinstance(raw, dict) else None
    if not compact or not is_main_agent_usage(compact):
        return {}
    fields = list_usage_fields(compact)
    return {"context_usage": fields} if fields else {}


def _trim_delegations(delegations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    trimmed: list[dict[str, Any]] = []
    for block in delegations:
        if not isinstance(block, dict):
            continue
        copy = dict(block)
        logs = copy.get("logs")
        if isinstance(logs, list) and len(logs) > LOGS_MAX:
            copy["logs"] = logs[-LOGS_MAX:]
        thinking = copy.get("sub_thinking")
        if isinstance(thinking, str):
            copy["sub_thinking"] = clip_thinking_tail(thinking, SUB_THINKING_MAX)
        trimmed.append(copy)
    return trimmed


def build_contextual_query(session_id: str, query: str) -> str:
    session = get_session(session_id)
    if not session or not session.get("messages"):
        return query
    history_lines: list[str] = []
    # HAZARD: 固定取最近 8 条；长对话会丢更早约束。若要改窗口需同时评估 prompt 长度。
    for msg in session["messages"][-8:]:
        if msg.get("status") == "running":
            continue
        role = "用户" if msg.get("role") == "user" else "助手"
        text = str(msg.get("content") or "").strip()
        if text:
            history_lines.append(f"{role}: {text}")
    if not history_lines:
        return query
    history_lines.append(f"用户: {query}")
    return (
        "以下是同一会话中的对话历史，请结合上下文理解并回答用户的最新问题。\n"
        + "\n".join(history_lines)
    )


def resolve_chat_query(agent_type: str, session_id: str, query: str) -> str:
    """React Copilot 把同会话历史交给内核 restore（须同时递增 ``run_id``）；NL2SQL 直连仍由壳拼接。"""
    if str(agent_type or "").strip().lower() == "react":
        return query
    return build_contextual_query(session_id, query)
