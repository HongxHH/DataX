"""Translate kernel sub-agent stream chunks into shell SSE payloads."""

from __future__ import annotations

import copy
import re
import time
from pathlib import Path
from typing import Any

from shell.backend.adapters.nl2sql_stages import NL2SQL_NODE_STAGES
from shell.backend.adapters.sql_security_copy import sql_security_user_message
from shell.backend.protocol.events import ShellEventType, shell_event
from shell.backend.session.live_span import normalize_live_span


def _now_ms() -> int:
    return int(time.time() * 1000)


def interrupted_delegation_message(started_at: Any, now_ms: int | None = None) -> str:
    """User-facing copy when a still-running delegation is cut off."""
    now = _now_ms() if now_ms is None else now_ms
    try:
        started = int(started_at)
    except (TypeError, ValueError):
        minutes = 1
    else:
        minutes = max(1, (now - started) // 60_000)
    return f"已运行 {minutes} 分钟后连接中断"


_SQL_BLOCK_RE = re.compile(r"```sql\s*(.*?)```", re.IGNORECASE | re.DOTALL)

# NL2SQL subprocess stderr node headers (see agent_status_handler._NL2SQLStatusHandler)
_NL2SQL_NODE_LABELS: dict[str, tuple[str, str]] = {
    "coordinator": ("perceiving", "协调"),
    **NL2SQL_NODE_STAGES,
    "final result": ("executing", "查询完成"),
}

_TOOL_DISPLAY_NAMES: dict[str, str] = {
    "sub_agent_tool": "子 Agent",
    "nl2sql_sub_agent_tool": "Landcheck NL2SQL",
}

_CONFIG_LABELS: dict[str, str] = {
    "landcheck_nl2sql.yaml": "Landcheck NL2SQL",
    "landcheck_document_recall.yaml": "Document Recall",
    "document_recall_agent.yaml": "Document Recall",
    "landcheck_plot.yaml": "Landcheck Plot",
    "landcheck_report.yaml": "Landcheck Report",
}


def agent_label_from_config_path(config_path: str | None, tool_name: str | None = None) -> str:
    name = Path(str(config_path or "")).name.lower()
    if name in _CONFIG_LABELS:
        return _CONFIG_LABELS[name]
    stem = name.replace(".yaml", "").replace(".yml", "")
    if "document_recall" in stem:
        return "Document Recall"
    if "plot" in stem:
        return "Landcheck Plot"
    if "report" in stem:
        return "Landcheck Report"
    if "nl2sql" in stem:
        return "Landcheck NL2SQL"
    return tool_display_name(tool_name)


SUB_AGENT_TOOLS = frozenset({"sub_agent_tool", "nl2sql_sub_agent_tool"})


def is_sub_agent_tool(tool_name: str | None) -> bool:
    return str(tool_name or "") in SUB_AGENT_TOOLS


def parse_worker_sub_id(value: Any) -> int | None:
    try:
        if value is None or str(value).strip() == "":
            return None
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def is_worker_busy_text(*parts: Any) -> bool:
    blob = " ".join(str(part or "") for part in parts)
    lowered = blob.lower()
    return "already running" in lowered or "本次未启动" in blob


def worker_busy_message(sub_id: int | None) -> str:
    if sub_id:
        return f"子 Agent #{sub_id} 正在运行。请停止当前生成，或换一个新的 worker 再问。"
    return "子 Agent 正在运行。请停止当前生成，或换一个新的 worker 再问。"


def enrich_worker_tool_event(data: dict[str, Any], tool_args: dict[str, Any] | None = None) -> dict[str, Any]:
    args = tool_args if isinstance(tool_args, dict) else {}
    if not args and isinstance(data.get("tool_args"), dict):
        args = data["tool_args"]
    sub_id = parse_worker_sub_id(data.get("sub_id")) or parse_worker_sub_id(args.get("sub_id"))
    # Do not invent resumed from args.sub_id; only pass through kernel truth.
    resumed = data.get("resumed")
    busy = bool(data.get("worker_busy")) or is_worker_busy_text(data.get("summary"), data.get("error"))
    extra: dict[str, Any] = {}
    if sub_id is not None:
        extra["sub_id"] = sub_id
    if resumed is not None:
        extra["resumed"] = bool(resumed)
    if busy:
        extra["worker_busy"] = True
        extra["status"] = "error"
        extra["error"] = worker_busy_message(sub_id)
        return extra
    security = sql_security_user_message(data.get("summary"), data.get("error"))
    if security:
        extra["status"] = "error"
        extra["error"] = security
    return extra


def tool_display_name(tool_name: str | None) -> str:
    name = str(tool_name or "sub_agent").strip()
    return _TOOL_DISPLAY_NAMES.get(name, name)


def extract_sql_from_markdown(text: str) -> str | None:
    match = _SQL_BLOCK_RE.search(text or "")
    if not match:
        return None
    sql = match.group(1).strip()
    return sql or None


_DA_KIND_MAP = {"DA_THINK": "reasoning", "DA_DRAFT": "draft"}


def _decode_da_delta(encoded: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(encoded):
        if encoded[i] == "\\" and i + 1 < len(encoded):
            nxt = encoded[i + 1]
            mapped = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\"}
            if nxt in mapped:
                out.append(mapped[nxt])
                i += 2
                continue
        out.append(encoded[i])
        i += 1
    return "".join(out)


def parse_da_progress_line(text: str) -> tuple[str, str, str] | None:
    """Parse `DA_THINK|DA_DRAFT\\tnode\\tdelta` (optional ↳ prefix)."""
    raw = text.strip()
    if raw.startswith("↳"):
        raw = raw[1:].strip()
    parts = raw.split("\t", 2)
    if len(parts) < 3:
        return None
    kind, node, encoded = parts
    mapped = _DA_KIND_MAP.get(kind)
    if not mapped or not node:
        return None
    return mapped, node, _decode_da_delta(encoded)


def _is_react_status_line(text: str) -> bool:
    if text in {"正在调用工具", "思考完毕", "执行失败"}:
        return True
    if text.endswith("执行失败") and len(text) <= 40:
        return True
    if text.endswith("完成") and len(text) <= 24:
        return True
    return False


def _stage_from_hint(hint: str) -> tuple[str, str] | None:
    raw = hint.strip()
    if raw.startswith("↳"):
        raw = raw[1:].strip()
    if ":" in raw:
        head, _ = raw.split(":", 1)
        raw = head.strip()
    key = raw.lower()
    if key in _NL2SQL_NODE_LABELS:
        return _NL2SQL_NODE_LABELS[key]
    for node_key, stage_info in _NL2SQL_NODE_LABELS.items():
        if key == node_key or key.startswith(node_key):
            return stage_info
    return None


def iter_subagent_progress_events(
    content: str,
    *,
    tool_call_id: str | None,
    tool_name: str | None,
) -> list[dict[str, Any]]:
    if not content or not tool_call_id:
        return []
    events: list[dict[str, Any]] = []
    last_think_node: str | None = None
    for line in content.splitlines():
        text = line.strip()
        if not text or text == "```" or text.endswith("工具执行过程：**"):
            continue
        if text.startswith("```"):
            continue
        base = {
            "tool_call_id": tool_call_id,
            "scope": "subagent",
            "agent_type": "nl2sql",
            "tool_name": tool_name,
        }
        parsed = parse_da_progress_line(text)
        if parsed:
            kind, node, delta = parsed
            if node != last_think_node:
                events.append(
                    shell_event(
                        ShellEventType.THINK,
                        {
                            **base,
                            "node": node,
                            "phase": "start",
                            "kind": kind,
                            "content": "",
                        },
                    )
                )
                last_think_node = node
            if delta:
                events.append(
                    shell_event(
                        ShellEventType.THINK,
                        {
                            **base,
                            "node": node,
                            "phase": "delta",
                            "kind": kind,
                            "content": delta,
                        },
                    )
                )
            continue
        stage_info = _stage_from_hint(text)
        if stage_info:
            stage, label = stage_info
            events.append(
                shell_event(
                    ShellEventType.STAGE,
                    {
                        **base,
                        "stage": stage,
                        "label": label,
                        "hint": label,
                        "node": text,
                        "order": 50,
                    },
                )
            )
            events.append(
                shell_event(
                    ShellEventType.LOG,
                    {**base, "message": text, "level": "stage"},
                )
            )
        else:
            clean = text.lstrip("↳").strip()
            if clean:
                if _is_react_status_line(clean):
                    events.append(
                        shell_event(
                            ShellEventType.STAGE,
                            {
                                **base,
                                "stage": "executing",
                                "label": clean,
                                "hint": clean,
                                "node": clean,
                                "order": 60,
                            },
                        )
                    )
                events.append(
                    shell_event(
                        ShellEventType.LOG,
                        {**base, "message": clean, "level": "info"},
                    )
                )
    return events


def _resolve_table_row_counts(state: dict[str, Any]) -> tuple[int | None, int | None]:
    """Derive total/preview row counts from NL2SQL sub-agent state."""
    row_count = state.get("row_count")
    preview_row_count = state.get("preview_row_count")
    if not isinstance(row_count, int) and isinstance(state.get("rows"), list):
        row_count = len(state["rows"])
    rows_preview = state.get("rows_preview")
    if not isinstance(preview_row_count, int) and isinstance(rows_preview, list):
        preview_row_count = len(rows_preview)
    return (
        row_count if isinstance(row_count, int) else None,
        preview_row_count if isinstance(preview_row_count, int) else None,
    )


def iter_subagent_state_events(
    state: dict[str, Any],
    *,
    tool_call_id: str | None,
    tool_name: str | None,
    config_path: str | None = None,
) -> list[dict[str, Any]]:
    if not tool_call_id or not isinstance(state, dict):
        return []
    events: list[dict[str, Any]] = []
    agent_label = agent_label_from_config_path(config_path, tool_name)
    base = {
        "tool_call_id": tool_call_id,
        "scope": "subagent",
        "agent_type": "nl2sql" if "nl2sql" in agent_label.lower() else "react",
        "tool_name": tool_name,
        "config_path": config_path or "",
        "agent_label": agent_label,
    }
    sql = str(state.get("sql") or "").strip()
    if sql:
        events.append(
            shell_event(
                ShellEventType.ARTIFACT,
                {"kind": "sql", "sql": sql, **base},
            )
        )
    columns = state.get("columns")
    rows = state.get("rows_preview")
    row_count, preview_row_count = _resolve_table_row_counts(state)
    if isinstance(columns, list) and columns and isinstance(rows, list):
        table_payload: dict[str, Any] = {
            "kind": "table",
            "columns": columns,
            "rows_preview": rows,
            **base,
        }
        if row_count is not None:
            table_payload["row_count"] = row_count
        if preview_row_count is not None:
            table_payload["preview_row_count"] = preview_row_count
        if state.get("csv_path"):
            table_payload["csv_path"] = str(state.get("csv_path"))
        if state.get("sql_path"):
            table_payload["sql_path"] = str(state.get("sql_path"))
        events.append(
            shell_event(
                ShellEventType.ARTIFACT,
                table_payload,
            )
        )
    excerpts = state.get("excerpts")
    if isinstance(excerpts, list) and excerpts:
        events.append(
            shell_event(
                ShellEventType.ARTIFACT,
                {
                    "kind": "excerpts",
                    "excerpts": excerpts,
                    "recall_summary": str(state.get("recall_summary") or ""),
                    "recall_path": str(state.get("recall_path") or ""),
                    **base,
                },
            )
        )
    image_path = str(state.get("image_path") or "").strip()
    images = state.get("images") if isinstance(state.get("images"), list) else []
    if image_path or images:
        events.append(
            shell_event(
                ShellEventType.ARTIFACT,
                {
                    "kind": "image",
                    "image_path": image_path,
                    "images": images,
                    **base,
                },
            )
        )
    report_path = str(state.get("report_path") or "").strip()
    if report_path:
        events.append(
            shell_event(
                ShellEventType.ARTIFACT,
                {
                    "kind": "report",
                    "report_path": report_path,
                    **base,
                },
            )
        )
    return events


class DelegationAccumulator:
    """Track delegation blocks for session persistence."""

    MAX_LOGS = 50  # HAZARD: 与 session.store 截断上限重复硬编码，改一处需同步另一处。
    MAX_THINKING = 2000

    def __init__(self) -> None:
        self._blocks: dict[str, dict[str, Any]] = {}

    def _ensure(self, tool_call_id: str, tool_name: str | None = None, *, agent_label: str | None = None) -> dict[str, Any]:
        block = self._blocks.get(tool_call_id)
        label = agent_label or tool_display_name(tool_name)
        if block is None:
            block = {
                "tool_call_id": tool_call_id,
                "tool_name": tool_name or "sub_agent_tool",
                "label": label,
                "status": "running",
                "logs": [],
                "stages": [],
                "started_at": _now_ms(),
            }
            self._blocks[tool_call_id] = block
        elif tool_name and not block.get("tool_name"):
            block["tool_name"] = tool_name
            if not block.get("label") or block.get("label") == tool_display_name("sub_agent_tool"):
                block["label"] = label
        elif agent_label:
            block["label"] = agent_label
        return block

    def on_tool(self, data: dict[str, Any]) -> None:
        tool_call_id = str(data.get("tool_call_id") or "")
        if not tool_call_id:
            return
        label = str(data.get("agent_label") or "") or agent_label_from_config_path(
            str(data.get("config_path") or ""),
            str(data.get("tool_name") or ""),
        )
        block = self._ensure(tool_call_id, str(data.get("tool_name") or ""), agent_label=label)
        worker = enrich_worker_tool_event(data)
        if worker.get("sub_id") is not None:
            block["sub_id"] = worker["sub_id"]
        if "resumed" in worker:
            block["resumed"] = worker["resumed"]
        status = str(worker.get("status") or data.get("status") or "").lower()
        error_text = str(worker.get("error") or data.get("error") or "")
        security = sql_security_user_message(error_text, data.get("summary"))
        if security:
            error_text = security
            status = "error"
        if status in ("error", "failed", "failure") or worker.get("worker_busy"):
            block["status"] = "error"
            if error_text:
                block["error"] = error_text
            block["ended_at"] = _now_ms()
        elif status in ("success", "completed", "done", "complete"):
            block["status"] = "done"
            block["ended_at"] = _now_ms()
        else:
            block["status"] = "running"

    def on_log(self, data: dict[str, Any]) -> None:
        tool_call_id = str(data.get("tool_call_id") or "")
        if not tool_call_id:
            return
        block = self._ensure(tool_call_id, str(data.get("tool_name") or ""))
        logs = block.setdefault("logs", [])
        if len(logs) >= self.MAX_LOGS:
            return
        entry = {
            "message": str(data.get("message") or ""),
            "level": data.get("level") or "info",
        }
        logs.append(entry)

    def on_stage(self, data: dict[str, Any]) -> None:
        tool_call_id = str(data.get("tool_call_id") or "")
        if not tool_call_id:
            return
        block = self._ensure(tool_call_id, str(data.get("tool_name") or ""))
        stage = str(data.get("stage") or "")
        label = str(data.get("hint") or data.get("label") or stage)
        block["current_stage_label"] = label
        stages: list[dict[str, Any]] = block.setdefault("stages", [])
        for s in stages:
            if s.get("status") == "active":
                s["status"] = "done"
        existing = next((s for s in stages if s.get("stage") == stage), None)
        if existing:
            existing["status"] = "active"
            existing["label"] = label
        else:
            stages.append({"stage": stage, "label": label, "status": "active"})

    def on_think(self, data: dict[str, Any]) -> None:
        tool_call_id = str(data.get("tool_call_id") or "")
        if not tool_call_id:
            return
        if str(data.get("phase") or "") != "delta":
            return
        content = str(data.get("content") or "")
        if not content:
            return
        block = self._ensure(tool_call_id, str(data.get("tool_name") or ""))
        prev = str(block.get("sub_thinking") or "")
        merged = f"{prev}{content}"
        block["sub_thinking"] = merged[: self.MAX_THINKING]

    def on_artifact(self, data: dict[str, Any]) -> None:
        tool_call_id = str(data.get("tool_call_id") or "")
        if not tool_call_id:
            return
        block = self._ensure(tool_call_id, str(data.get("tool_name") or ""))
        kind = str(data.get("kind") or "")
        if kind == "sql" and data.get("sql"):
            block["sql"] = str(data.get("sql"))
        if kind == "table":
            if isinstance(data.get("columns"), list):
                block["columns"] = data.get("columns")
            if isinstance(data.get("rows_preview"), list):
                block["rows_preview"] = data.get("rows_preview")
            if isinstance(data.get("row_count"), int):
                block["row_count"] = data.get("row_count")
            if isinstance(data.get("preview_row_count"), int):
                block["preview_row_count"] = data.get("preview_row_count")
            if data.get("csv_path"):
                block["csv_path"] = str(data.get("csv_path"))
            if data.get("sql_path"):
                block["sql_path"] = str(data.get("sql_path"))
        if kind == "excerpts" and isinstance(data.get("excerpts"), list):
            block["excerpts"] = data.get("excerpts")
            if data.get("recall_summary"):
                block["recall_summary"] = str(data.get("recall_summary"))
            if data.get("recall_path"):
                block["recall_path"] = str(data.get("recall_path"))
        if kind == "image":
            if data.get("image_path"):
                block["image_path"] = str(data.get("image_path"))
            if isinstance(data.get("images"), list):
                block["images"] = data.get("images")
        if kind == "report" and data.get("report_path"):
            block["report_path"] = str(data.get("report_path"))
        if data.get("agent_label"):
            block["label"] = str(data.get("agent_label"))

    def on_span(self, data: dict[str, Any]) -> None:
        span = normalize_live_span(data)
        if span is None:
            return
        tool_call_id = str(span.get("tool_call_id") or span.get("parent_tool_call_id") or "")
        if not tool_call_id:
            return
        block = self._ensure(tool_call_id)
        sub_id = span.get("sub_id")
        if isinstance(sub_id, int) and sub_id > 0:
            block["sub_id"] = sub_id
        if span.get("kind") != "llm":
            return
        name = str(span.get("name") or "").strip()
        if span.get("phase") == "start":
            block["llm_running"] = True
            if name:
                block["last_llm_name"] = name
            return
        block["llm_running"] = False
        duration = span.get("duration_ms")
        if isinstance(duration, int):
            block["last_llm_ms"] = duration
        if name:
            block["last_llm_name"] = name
        usage = span.get("usage") if isinstance(span.get("usage"), dict) else {}
        block["input_tokens"] = int(block.get("input_tokens") or 0) + int(usage.get("input_tokens") or 0)
        block["output_tokens"] = int(block.get("output_tokens") or 0) + int(usage.get("output_tokens") or 0)

    def ingest_shell_event(self, event_name: str, data: dict[str, Any]) -> None:
        if event_name == ShellEventType.SPAN:
            self.on_span(data)
            return
        if not data.get("tool_call_id"):
            return
        tool_name = str(data.get("tool_name") or "")
        if tool_name and not is_sub_agent_tool(tool_name):
            return
        if event_name == ShellEventType.TOOL:
            self.on_tool(data)
        elif event_name == ShellEventType.LOG:
            self.on_log(data)
        elif event_name == ShellEventType.STAGE:
            self.on_stage(data)
        elif event_name == ShellEventType.ARTIFACT:
            self.on_artifact(data)
        elif event_name == ShellEventType.THINK:
            self.on_think(data)

    def snapshot(self) -> list[dict[str, Any]]:
        """Copy current blocks without marking them done (for mid-turn persist)."""
        return copy.deepcopy(list(self._blocks.values()))

    def finalize(self, *, interrupted: bool = False) -> list[dict[str, Any]]:
        if not self._blocks:
            return []
        now = _now_ms()
        for block in self._blocks.values():
            if block.get("status") == "running":
                if interrupted:
                    block["status"] = "error"
                    if not block.get("error"):
                        block["error"] = interrupted_delegation_message(block.get("started_at"), now)
                else:
                    block["status"] = "done"
            if block.get("ended_at") is None:
                block["ended_at"] = now
            stages = block.get("stages") or []
            for s in stages:
                if s.get("status") == "active":
                    s["status"] = "done"
            block.pop("current_stage_label", None)
        return list(self._blocks.values())
