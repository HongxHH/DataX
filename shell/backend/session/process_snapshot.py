"""Accumulate live SSE process fields for session persistence."""

from __future__ import annotations

from typing import Any

from shell.backend.protocol.context_usage import is_main_agent_usage, normalize_context_usage
from shell.backend.protocol.events import ShellEventType
from shell.backend.protocol.prompt_inventory import (
    is_main_agent_inventory,
    normalize_prompt_inventory,
    put_sub_prompt_inventory,
)
from shell.backend.session.clipping import (
    LOGS_MAX,
    MAIN_THINKING_MAX,
    PLAN_PREP_MAX,
    STAGES_MAX,
    WORKBENCH_THINKING_MAX,
    clip_thinking_tail,
    trim_plan_prep,
)
from shell.backend.session.live_span import SPANS_MAX, append_live_span, normalize_live_span


class ProcessSnapshot:
    """Capture thinking / plan / stages / logs that RESULT payloads used to drop."""

    def __init__(self) -> None:
        self.main_thinking = ""
        self.thinking = ""
        self.plan_hint = ""
        self.plan_tools: list[dict[str, Any]] = []
        self.plan_prep: list[str] = []
        self.stages: list[dict[str, str]] = []
        self.logs: list[dict[str, str]] = []
        self.sql = ""
        self.rewritten_query = ""
        self.context_usage: dict[str, Any] | None = None
        self.prompt_inventory: dict[str, Any] | None = None
        self.sub_prompt_inventories: dict[str, dict[str, Any]] = {}
        self.otel_spans: list[dict[str, Any]] = []

    def ingest(self, event_name: str, data: dict[str, Any] | None) -> None:
        if not isinstance(data, dict):
            return
        if event_name == ShellEventType.THINK:
            self._on_think(data)
        elif event_name == ShellEventType.PLAN:
            self._on_plan(data)
        elif event_name == ShellEventType.STAGE:
            self._on_stage(data)
        elif event_name == ShellEventType.LOG:
            self._on_log(data)
        elif event_name == ShellEventType.ARTIFACT:
            self._on_artifact(data)
        elif event_name == ShellEventType.CONTEXT:
            self._on_context(data)
        elif event_name == ShellEventType.CONTEXT_USAGE:
            self._on_context_usage(data)
        elif event_name == ShellEventType.PROMPT_INVENTORY:
            self._on_prompt_inventory(data)
        elif event_name == ShellEventType.SPAN:
            self._on_span(data)

    def _on_think(self, data: dict[str, Any]) -> None:
        if data.get("tool_call_id"):
            return
        if str(data.get("phase") or "") != "delta":
            return
        content = str(data.get("content") or "")
        if not content:
            return
        scope = str(data.get("scope") or "")
        if scope == "main":
            merged = f"{self.main_thinking}{content}"
            self.main_thinking = clip_thinking_tail(merged, MAIN_THINKING_MAX)
            return
        merged = f"{self.thinking}{content}"
        self.thinking = clip_thinking_tail(merged, WORKBENCH_THINKING_MAX)

    def _on_plan(self, data: dict[str, Any]) -> None:
        hint = str(data.get("hint") or "").strip()
        if hint:
            self.plan_hint = hint
        tools = data.get("tools")
        if isinstance(tools, list):
            self.plan_tools = [t for t in tools if isinstance(t, dict)]

    def _on_stage(self, data: dict[str, Any]) -> None:
        if data.get("tool_call_id"):
            return
        stage = str(data.get("stage") or "")
        label = str(data.get("hint") or data.get("label") or stage).strip()
        if not stage and not label:
            return
        for item in self.stages:
            if item.get("status") == "active":
                item["status"] = "done"
        existing = next((item for item in self.stages if item.get("stage") == stage), None)
        if existing:
            existing["status"] = "active"
            existing["label"] = label or existing.get("label") or stage
        elif len(self.stages) < STAGES_MAX:
            self.stages.append({"stage": stage or label, "label": label or stage, "status": "active"})
        if stage == "planning" and label:
            self._add_plan_prep(label)

    def _on_artifact(self, data: dict[str, Any]) -> None:
        if data.get("tool_call_id"):
            return
        if str(data.get("kind") or "") == "sql" and data.get("sql"):
            self.sql = str(data.get("sql"))

    def _on_context(self, data: dict[str, Any]) -> None:
        rewritten = str(data.get("rewritten") or "").strip()
        raw = str(data.get("raw") or "").strip()
        if rewritten and rewritten != raw:
            self.rewritten_query = rewritten
            self._add_plan_prep(f"问句已改写为 {rewritten}")

    def _on_context_usage(self, data: dict[str, Any]) -> None:
        compact = normalize_context_usage(data)
        if compact is None or not is_main_agent_usage(compact):
            return
        self.context_usage = compact

    def _on_prompt_inventory(self, data: dict[str, Any]) -> None:
        compact = normalize_prompt_inventory(data)
        if compact is None:
            return
        if is_main_agent_inventory(compact):
            self.prompt_inventory = compact
            return
        put_sub_prompt_inventory(self.sub_prompt_inventories, compact)

    def _on_span(self, data: dict[str, Any]) -> None:
        span = normalize_live_span(data)
        if span is None:
            return
        append_live_span(self.otel_spans, span)

    def _on_log(self, data: dict[str, Any]) -> None:
        if data.get("tool_call_id"):
            return
        message = str(data.get("message") or "").strip()
        if not message or len(self.logs) >= LOGS_MAX:
            return
        entry: dict[str, str] = {"message": message[:500], "level": str(data.get("level") or "info")}
        self.logs.append(entry)

    def _add_plan_prep(self, hint: str) -> None:
        if self.plan_prep and self.plan_prep[-1] == hint:
            return
        self.plan_prep.append(hint)
        self.plan_prep = trim_plan_prep(self.plan_prep, PLAN_PREP_MAX)

    def persist_kwargs(self, *, finalize_stages: bool = True) -> dict[str, Any]:
        """Keyword args for assistant message persistence (omit empty)."""
        payload: dict[str, Any] = {}
        if self.main_thinking:
            payload["main_thinking"] = self.main_thinking
        if self.thinking:
            payload["thinking"] = self.thinking
        if self.plan_hint:
            payload["plan_hint"] = self.plan_hint
        if self.plan_tools:
            payload["plan_tools"] = self.plan_tools
        if self.plan_prep:
            payload["plan_prep"] = list(self.plan_prep)
        if self.stages:
            staged = []
            for item in self.stages:
                staged_item = dict(item)
                if finalize_stages and staged_item.get("status") == "active":
                    staged_item["status"] = "done"
                staged.append(staged_item)
            payload["stages"] = staged
        if self.logs:
            payload["logs"] = list(self.logs)
        if self.sql:
            payload["sql"] = self.sql
        if self.rewritten_query:
            payload["rewritten_query"] = self.rewritten_query
        if self.context_usage:
            payload["context_usage"] = dict(self.context_usage)
        if self.prompt_inventory:
            payload["prompt_inventory"] = dict(self.prompt_inventory)
        if self.sub_prompt_inventories:
            payload["sub_prompt_inventories"] = {
                key: dict(value) for key, value in self.sub_prompt_inventories.items()
            }
        if self.otel_spans:
            payload["otel_spans"] = list(self.otel_spans[-SPANS_MAX:])
        return payload
