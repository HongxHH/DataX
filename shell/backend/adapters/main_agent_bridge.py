"""Map main-agent planner stream chunks into Shell SSE events."""

from __future__ import annotations

import json
import re
from typing import Any

from shell.backend.adapters.subagent_bridge import agent_label_from_config_path, is_sub_agent_tool
from shell.backend.protocol.context_usage import normalize_context_usage
from shell.backend.protocol.events import ShellEventType, shell_event
from shell.backend.protocol.prompt_inventory import normalize_prompt_inventory

_TOOL_BOILERPLATE_OUTPUT_RE = re.compile(
    r"^\s*\*\*.*?(?:执行完成|工具执行结果|工具执行失败).*\*\*",
    re.IGNORECASE | re.DOTALL,
)

HIDDEN_PLAN_TOOLS = frozenset(
    {
        "request_human_feedback",
        "submit_subagent",
        "poll_subagent",
        "collect_subagent",
        "cancel_subagent",
        "search_workspaces",
        "inspect_workspace",
        "glob",
        "bash",
        "grep",
        "read_file",
        "write_file",
        "edit_file",
        "create_plan",
        "update_plan",
        "delete_plan",
        "complete_current_todo",
    }
)

MAIN_AGENT_CUSTOM_TYPES = frozenset(
    {
        "break",
        "output_msg",
        "planner_stream",
        "planner_tool_calls",
        "planner_error",
        "progress_hint",
        "context_rewrite",
        "cross_session_recall",
        "context_usage",
        "prompt_inventory",
    }
)

_NODE_STAGE_HINTS: dict[str, tuple[str, str, int]] = {
    "planner": ("planning", "正在规划…", 10),
    "executor": ("executing", "正在执行工具…", 40),
}

_QUERY_SUMMARY_MAX = 80


def _should_stream_output_msg(content: str) -> bool:
    text = content.strip()
    if not text:
        return False
    if _TOOL_BOILERPLATE_OUTPUT_RE.match(text):
        return False
    if "工具执行结果" in text and "```" in text:
        return False
    if "正在调用以下工具" in text:
        return False
    return True


def _truncate(text: str, limit: int = _QUERY_SUMMARY_MAX) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "…"


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _tool_name(tool_call: Any) -> str:
    if isinstance(tool_call, dict):
        name = tool_call.get("name")
        if name:
            return str(name)
        function = tool_call.get("function")
        if isinstance(function, dict) and function.get("name"):
            return str(function["name"])
        return ""
    return str(getattr(tool_call, "name", "") or "")


def _tool_args(tool_call: Any) -> dict[str, Any]:
    if isinstance(tool_call, dict):
        args = _as_dict(tool_call.get("args") or tool_call.get("arguments"))
        if args:
            return args
        function = tool_call.get("function")
        if isinstance(function, dict):
            return _as_dict(function.get("arguments") or function.get("args"))
        return {}
    return _as_dict(getattr(tool_call, "args", None))


def should_emit_plan(tool_calls: Any) -> bool:
    return bool(_visible_tool_calls(tool_calls))


def _visible_tool_calls(tool_calls: Any) -> list[Any]:
    if not isinstance(tool_calls, list):
        return []
    visible: list[Any] = []
    for tool_call in tool_calls:
        name = _tool_name(tool_call)
        if name and name not in HIDDEN_PLAN_TOOLS:
            visible.append(tool_call)
    return visible


def _args_summary(name: str, args: dict[str, Any]) -> str:
    if is_sub_agent_tool(name):
        query = str(args.get("query") or args.get("user_query") or "").strip()
        return _truncate(query) if query else ""
    for key in ("query", "question", "message", "path", "command"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return _truncate(value)
    return ""


def format_tool_plan_hint(tool_calls: Any) -> tuple[list[dict[str, str]], str]:
    """Build visible tool chips and a one-line human hint."""
    tools: list[dict[str, str]] = []
    hints: list[str] = []
    for tool_call in _visible_tool_calls(tool_calls):
        name = _tool_name(tool_call)
        args = _tool_args(tool_call)
        summary = _args_summary(name, args)
        config_path = str(args.get("config_path") or "")
        label = agent_label_from_config_path(config_path, name) if is_sub_agent_tool(name) else name
        item: dict[str, str] = {"name": name, "label": label}
        if summary:
            item["args_summary"] = summary
        if config_path:
            item["config_path"] = config_path
        tools.append(item)
        if is_sub_agent_tool(name):
            hints.append(f"将委派 {label} 处理：{summary}" if summary else f"将委派 {label}")
        else:
            hints.append(f"将调用 {name}")
    hint = "；".join(hints) if hints else "正在准备调用工具…"
    return tools, hint


def _stage_event(
    *,
    hint: str,
    node: Any = "planner",
    stage: str = "planning",
    order: int = 10,
    label: Any = None,
) -> dict[str, Any]:
    node_name = str(node or "planner")
    return shell_event(
        ShellEventType.STAGE,
        {
            "stage": stage,
            "label": str(label) if label is not None else node_name,
            "hint": hint,
            "node": node_name,
            "scope": "main",
            "order": order,
        },
    )


def _think_event(*, phase: str, content: str = "", node: Any = None) -> dict[str, Any]:
    return shell_event(
        ShellEventType.THINK,
        {
            "content": content,
            "node": node,
            "scope": "main",
            "phase": phase,
        },
    )


def _plan_event(*, tools: list[dict[str, str]], hint: str, node: Any = None) -> dict[str, Any]:
    return shell_event(
        ShellEventType.PLAN,
        {
            "node": node,
            "scope": "main",
            "tools": tools,
            "hint": hint,
        },
    )


def _token_event(*, content: str, node: Any = None) -> dict[str, Any]:
    return shell_event(
        ShellEventType.TOKEN,
        {
            "content": content,
            "node": node,
            "scope": "main",
        },
    )


class MainAgentStreamMapper:
    """Stateful mapper: kernel custom events → think / plan / token / stage."""

    def __init__(self) -> None:
        self._thinking_started = False
        self._thinking_ended = False

    def initial_stage_event(self) -> dict[str, Any]:
        return _stage_event(hint="正在规划…", node="planner", stage="planning", order=10)

    def node_update_stage(self, node_name: str) -> dict[str, Any] | None:
        mapped = _NODE_STAGE_HINTS.get(node_name)
        if mapped is None:
            return None
        stage, hint, order = mapped
        return _stage_event(hint=hint, node=node_name, stage=stage, order=order)

    def iter_events(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        event_type = data.get("type")
        if event_type == "break":
            return self._end_thinking(data.get("node_name"))
        if event_type == "output_msg":
            return self._handle_output_msg(data)
        if event_type == "planner_stream":
            return self._handle_planner_stream(data)
        if event_type == "planner_tool_calls":
            return self._handle_planner_tool_calls(data)
        if event_type == "planner_error":
            return self._handle_planner_error(data)
        if event_type == "progress_hint":
            return self._handle_progress_hint(data)
        if event_type == "context_rewrite":
            return self._handle_context_rewrite(data)
        if event_type == "cross_session_recall":
            return self._handle_cross_session_recall(data)
        if event_type == "context_usage":
            return self._handle_context_usage(data)
        if event_type == "prompt_inventory":
            return self._handle_prompt_inventory(data)
        return []

    def _handle_progress_hint(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        hint = str(data.get("hint") or "").strip()
        if not hint:
            return []
        return [
            _stage_event(
                hint=hint,
                node=data.get("node_name") or "planner",
                stage=str(data.get("stage") or "planning"),
                order=10,
            )
        ]

    def _handle_context_rewrite(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        raw = str(data.get("raw_user_query") or "").strip()
        rewritten = str(data.get("user_query") or "").strip()
        if not raw or not rewritten or raw == rewritten:
            return []
        return [
            shell_event(
                ShellEventType.CONTEXT,
                {"raw": raw, "rewritten": rewritten, "scope": "main"},
            )
        ]

    def _handle_context_usage(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        compact = normalize_context_usage(data)
        if compact is None:
            return []
        return [shell_event(ShellEventType.CONTEXT_USAGE, compact)]

    def _handle_prompt_inventory(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        compact = normalize_prompt_inventory(data)
        if compact is None:
            return []
        return [shell_event(ShellEventType.PROMPT_INVENTORY, compact)]

    def _handle_cross_session_recall(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        status = str(data.get("status") or "").strip()
        if status == "disabled":
            hint = "跨会话记忆：已跳过"
        elif status == "hit":
            try:
                hit_count = int(data.get("hit_count") or 0)
            except (TypeError, ValueError):
                hit_count = 0
            hint = f"跨会话记忆：命中 {hit_count} 段"
            preview = str(data.get("preview") or "").strip()
            if preview:
                hint = f"{hint} · {preview}"
        elif status == "empty":
            hint = "跨会话记忆：未命中"
        else:
            return []
        return [_stage_event(hint=hint, node="planner", stage="planning", order=10)]

    def _start_thinking(self, node: Any) -> list[dict[str, Any]]:
        if self._thinking_started and not self._thinking_ended:
            return []
        self._thinking_started = True
        self._thinking_ended = False
        return [_think_event(phase="start", node=node)]

    def _emit_think_delta(self, content: str, node: Any) -> list[dict[str, Any]]:
        events = self._start_thinking(node)
        if content:
            events.append(_think_event(phase="delta", content=content, node=node))
        return events

    def _end_thinking(self, node: Any = None) -> list[dict[str, Any]]:
        if not self._thinking_started or self._thinking_ended:
            return []
        self._thinking_ended = True
        return [_think_event(phase="end", node=node)]

    def _maybe_plan(self, tool_calls: Any, node: Any) -> list[dict[str, Any]]:
        tools, hint = format_tool_plan_hint(tool_calls)
        if not tools:
            return []
        return [_plan_event(tools=tools, hint=hint, node=node)]

    def _handle_output_msg(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        node = data.get("node_name")
        events: list[dict[str, Any]] = []
        reasoning = str(data.get("reasoning_content") or "")
        if reasoning:
            events.extend(self._emit_think_delta(reasoning, node))
        tool_calls = data.get("tool_calls") or []
        plan_events = self._maybe_plan(tool_calls, node)
        events.extend(plan_events)
        if plan_events:
            events.extend(self._end_thinking(node))
        content = str(data.get("content") or "")
        if content and _should_stream_output_msg(content):
            events.extend(self._end_thinking(node))
            events.append(_token_event(content=content, node=node))
        return events

    def _handle_planner_stream(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        phase = str(data.get("phase") or "")
        node = data.get("node_name")
        content = str(data.get("content") or "")
        if phase == "start":
            return self._start_thinking(node)
        if phase == "reasoning":
            return self._emit_think_delta(content, node)
        if phase == "content":
            events = self._end_thinking(node)
            if content:
                events.append(_token_event(content=content, node=node))
            return events
        if phase == "end":
            return self._end_thinking(node)
        return []

    def _handle_planner_tool_calls(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        node = data.get("node_name")
        events = self._end_thinking(node)
        events.extend(self._maybe_plan(data.get("tool_calls") or [], node))
        return events

    def _handle_planner_error(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        node = data.get("node_name")
        events = self._end_thinking(node)
        message = str(data.get("content") or data.get("message") or "")
        if message:
            events.append(shell_event(ShellEventType.LOG, {"message": message[:500], "node": node, "scope": "main"}))
        return events
