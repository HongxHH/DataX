"""ReAct / Flex agent stream adapter."""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncGenerator
from typing import Any

from shell.backend.adapters.base import BaseStreamAdapter, aclose_stream, parse_stream_tuple, sdk_error_event
from shell.backend.adapters.main_agent_bridge import (
    MAIN_AGENT_CUSTOM_TYPES,
    MainAgentStreamMapper,
)
from shell.backend.adapters.subagent_bridge import (
    DelegationAccumulator,
    agent_label_from_config_path,
    extract_sql_from_markdown,
    iter_subagent_progress_events,
    iter_subagent_state_events,
    enrich_worker_tool_event,
)
from dataagent.utils.constants import DEFAULT_USER_ID

from shell.backend.protocol.events import ShellEventType, shell_event
from shell.backend.session.live_span import normalize_live_span

_ANSWER_TAG_RE = re.compile(r"<answer>\s*(.*?)\s*</answer>", flags=re.DOTALL | re.IGNORECASE)


def _message_content(msg: Any) -> str:
    if isinstance(msg, dict):
        return str(msg.get("content") or "")
    return str(getattr(msg, "content", "") or "")


def format_react_result(state: dict[str, Any]) -> dict[str, Any]:
    messages = state.get("messages", [])
    content = ""
    if isinstance(messages, list) and messages:
        content = _message_content(messages[-1])
    if not content:
        return {"success": False, "message": "Agent returned an empty result"}
    match = _ANSWER_TAG_RE.search(content)
    sql = match.group(1).strip() if match else ""
    payload: dict[str, Any] = {
        "success": True,
        "message": content,
        "session_id": state.get("session_id"),
    }
    if sql:
        payload["sql"] = sql
    return payload


def coerce_kernel_run_id(value: Any) -> int:
    """Normalize adapter ``run_id``; invalid values fall back to 0 (first Flex run)."""
    try:
        run_id = int(value if value is not None else 0)
    except (TypeError, ValueError):
        return 0
    return run_id if run_id >= 0 else 0


def flex_turn_initial_state(query: str, session_id: str, run_id: int = 0) -> dict[str, Any]:
    """Per-turn Flex state. ``run_id`` must increment so planner registers a new Query."""
    return {
        "user_query": query,
        "session_id": session_id,
        "raw_user_query": query,
        "terminal_mode": False,
        "run_id": coerce_kernel_run_id(run_id),
        "user_id": DEFAULT_USER_ID,
    }


class ReactStreamAdapter(BaseStreamAdapter):
    async def stream_events(
        self,
        query: str,
        session_id: str,
        **kwargs: Any,
    ) -> AsyncGenerator[dict[str, Any], None]:
        mapper = MainAgentStreamMapper()
        yield mapper.initial_stage_event()
        await asyncio.sleep(0)

        final_state: dict[str, Any] | None = None
        delegations = DelegationAccumulator()
        initial_state = flex_turn_initial_state(query, session_id, coerce_kernel_run_id(kwargs.get("run_id")))
        stream = None
        stream_kwargs: dict[str, Any] = {
            "initial_state": initial_state,
            "session_id": session_id,
            "stream_mode": ["updates", "custom", "values"],
            "message": query,
        }

        def _track_and_yield(item: dict[str, Any]) -> dict[str, Any]:
            event_name = str(item.get("event") or "")
            data = item.get("data")
            if isinstance(data, dict):
                delegations.ingest_shell_event(event_name, data)
            return item

        try:
            stream = self._agent.astream(**stream_kwargs)
            async for item in stream:
                if isinstance(item, dict):
                    err_event = sdk_error_event(item)
                    if err_event is not None:
                        yield err_event
                        return

                parsed = parse_stream_tuple(item)
                if parsed is None:
                    continue

                stream_mode, data = parsed

                if stream_mode == "values" and isinstance(data, dict):
                    final_state = data
                    continue

                if stream_mode == "custom" and isinstance(data, dict):
                    event_type = data.get("type")
                    if event_type in MAIN_AGENT_CUSTOM_TYPES:
                        for ev in mapper.iter_events(data):
                            yield _track_and_yield(ev)
                        continue
                    if event_type == "otel_span":
                        span = normalize_live_span(data)
                        if span is not None:
                            yield _track_and_yield(shell_event(ShellEventType.SPAN, span))
                        continue
                    if event_type == "tool_status":
                        tool_args = data.get("tool_args") if isinstance(data.get("tool_args"), dict) else {}
                        config_path = str(tool_args.get("config_path") or "")
                        tool_name = str(data.get("tool_name") or "")
                        payload = {
                            "tool_name": tool_name,
                            "tool_call_id": data.get("tool_call_id"),
                            "status": data.get("status"),
                            "summary": data.get("summary"),
                            "error": data.get("error"),
                            "node": data.get("node_name"),
                            "scope": "main",
                            "config_path": config_path,
                            "agent_label": agent_label_from_config_path(config_path, tool_name),
                        }
                        payload.update(enrich_worker_tool_event(data, tool_args))
                        ev = shell_event(ShellEventType.TOOL, payload)
                        yield _track_and_yield(ev)
                        continue
                    if event_type == "subagent_state":
                        tool_call_id = str(data.get("tool_call_id") or "")
                        tool_name = str(data.get("tool_name") or "")
                        config_path = str(data.get("config_path") or "")
                        state = data.get("state") if isinstance(data.get("state"), dict) else {}
                        for ev in iter_subagent_state_events(
                            state,
                            tool_call_id=tool_call_id,
                            tool_name=tool_name,
                            config_path=config_path,
                        ):
                            yield _track_and_yield(ev)
                        continue
                    if event_type == "execution_msg":
                        extra = data.get("extra_msg")
                        tool_call_id = str(data.get("tool_call_id") or "") or None
                        tool_name = str(data.get("tool_name") or "") or None
                        if extra == "subagent_progress":
                            if data.get("is_final"):
                                continue
                            content = str(data.get("content") or "")
                            for ev in iter_subagent_progress_events(
                                content,
                                tool_call_id=tool_call_id,
                                tool_name=tool_name,
                            ):
                                yield _track_and_yield(ev)
                            continue
                        content = str(data.get("content") or "")
                        if tool_name == "sub_agent_tool" and tool_call_id and content:
                            sql = extract_sql_from_markdown(content)
                            if sql:
                                ev = shell_event(
                                    ShellEventType.ARTIFACT,
                                    {
                                        "kind": "sql",
                                        "sql": sql,
                                        "tool_call_id": tool_call_id,
                                        "scope": "subagent",
                                        "agent_type": "nl2sql",
                                        "tool_name": tool_name,
                                    },
                                )
                                yield _track_and_yield(ev)
                        continue
                    message = str(data.get("message") or data.get("content") or "")
                    if message:
                        yield shell_event(ShellEventType.LOG, {"message": message[:500]})
                    continue

                if stream_mode == "updates" and isinstance(data, dict):
                    for node_name, node_state in data.items():
                        if node_name == "__interrupt__":
                            continue
                        if isinstance(node_state, dict):
                            stage_event = mapper.node_update_stage(str(node_name))
                            if stage_event is not None:
                                yield stage_event

            if not final_state:
                yield shell_event(ShellEventType.RESULT, {"success": False, "message": "Agent returned an empty result"})
                return

            if isinstance(final_state.get("error"), dict):
                yield shell_event(ShellEventType.RESULT, final_state["error"])
                return

            formatted = format_react_result(final_state)
            finalized = delegations.finalize()
            if finalized:
                formatted["delegations"] = finalized
            yield shell_event(ShellEventType.RESULT, formatted)
        except Exception as exc:
            yield shell_event(ShellEventType.ERROR, {"message": str(exc)})
        finally:
            await aclose_stream(stream)
