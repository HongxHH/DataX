"""NL2SQL stream adapter."""

from __future__ import annotations

import hashlib
import re
from collections.abc import AsyncGenerator
from typing import Any

from shell.backend.adapters.base import BaseStreamAdapter, aclose_stream, parse_stream_tuple, sdk_error_event
from shell.backend.adapters.nl2sql_stages import NL2SQL_NODE_STAGES, NL2SQL_STAGE_ORDER
from shell.backend.protocol.events import ShellEventType, shell_event

_THINK_KIND = "DA_THINK"
_DRAFT_KIND = "DA_DRAFT"

_CREATE_TABLE_RE = re.compile(r"CREATE\s+TABLE", re.IGNORECASE)
_NODE_STAGE: dict[str, tuple[str, str]] = {
    **NL2SQL_NODE_STAGES,
    "traffic_insight_perceptor": ("perceiving", "正在分析表结构"),
    "business_twin_perceptor": ("perceiving", "正在读取业务孪生结构"),
}
_STAGES_ORDER = NL2SQL_STAGE_ORDER


def _is_ddl_message(message: str) -> bool:
    return bool(_CREATE_TABLE_RE.search(message)) or "=== Perceptor ===" in message


def _extract_sql_from_state(state: dict[str, Any]) -> str | None:
    sql = str(state.get("sql") or "").strip()
    if sql:
        return sql
    for key in ("generation_results", "validation_results", "execution_results"):
        items = state.get(key) or []
        for item in items:
            if isinstance(item, dict) and item.get("sql"):
                return str(item["sql"])
    return None


def _hash_sql(sql: str) -> str:
    return hashlib.sha256(re.sub(r"\s+", " ", (sql or "").strip()).encode()).hexdigest()


def _collect_nl2sql_candidates(state: dict[str, Any]) -> list[dict[str, Any]]:
    sources = (
        state.get("execution_results") or state.get("validation_results") or state.get("generation_results") or []
    )
    candidates: list[dict[str, Any]] = []
    for item in sources:
        if isinstance(item, dict):
            item_sql = str(item.get("sql") or "")
            idx = item.get("id", len(candidates))
            digest = item.get("sql_sha256") or (_hash_sql(item_sql) if item_sql else "")
        else:
            item_sql = str(getattr(item, "sql", "") or "")
            idx = getattr(item, "id", len(candidates))
            digest = getattr(item, "sql_sha256", None) or (_hash_sql(item_sql) if item_sql else "")
        if not item_sql:
            continue
        candidates.append({"index": idx, "sql": item_sql, "sql_sha256": digest})
    return candidates


def _think_event(*, phase: str, node: str, content: str = "") -> dict[str, Any]:
    return shell_event(
        ShellEventType.THINK,
        {
            "content": content,
            "node": node,
            "scope": "subagent",
            "phase": phase,
            "kind": "reasoning",
        },
    )


def iter_nl2sql_custom_events(
    data: dict[str, Any],
    *,
    last_think_node: str | None,
    draft_sql: str,
) -> tuple[list[dict[str, Any]], str | None, str]:
    """Map in-process ``nl2sql_progress`` custom payloads to shell SSE events."""
    if str(data.get("type") or "") != "nl2sql_progress":
        return [], last_think_node, draft_sql
    kind = str(data.get("kind") or "")
    node = str(data.get("node") or "nl2sql")
    delta = str(data.get("delta") or "")
    events: list[dict[str, Any]] = []
    if kind == _THINK_KIND:
        if node != last_think_node:
            events.append(_think_event(phase="start", node=node))
            last_think_node = node
        if delta:
            events.append(_think_event(phase="delta", node=node, content=delta))
        return events, last_think_node, draft_sql
    if kind == _DRAFT_KIND and delta:
        merged = f"{draft_sql}{delta}"
        if merged != draft_sql:
            events.append(shell_event(ShellEventType.ARTIFACT, {"kind": "sql", "sql": merged}))
        return events, last_think_node, merged
    return events, last_think_node, draft_sql


def format_nl2sql_result(state: dict[str, Any]) -> dict[str, Any]:
    sql = str(state.get("sql") or "")
    rows_preview = state.get("rows_preview")
    message = "SQL 已生成。"
    if rows_preview:
        message = "SQL 已生成并执行，结果见下方表格。"
    if not sql:
        message = "未生成可执行的 SQL。"

    candidates = _collect_nl2sql_candidates(state)
    if not candidates and sql:
        candidates = [{"index": 0, "sql": sql, "sql_sha256": _hash_sql(sql)}]

    payload: dict[str, Any] = {
        "success": True,
        "message": message,
        "candidates": candidates,
        "sql": sql,
        "confidence": state.get("confidence"),
        "columns": state.get("columns"),
        "rows_preview": rows_preview,
        "session_id": state.get("session_id"),
    }
    if sql:
        payload["sql_fingerprint"] = _hash_sql(sql)
    return payload


class Nl2sqlStreamAdapter(BaseStreamAdapter):
    async def stream_events(
        self,
        query: str,
        session_id: str,
        **_: Any,
    ) -> AsyncGenerator[dict[str, Any], None]:
        final_state: dict[str, Any] | None = None
        update_state: dict[str, Any] = {}
        completed_stages: set[str] = set()
        last_think_node: str | None = None
        draft_sql = ""

        initial_state = {"user_query": query, "session_id": session_id}
        stream = None

        try:
            stream = self._agent.astream(
                initial_state=initial_state,
                session_id=session_id,
                message=query,
                stream_mode=["updates", "custom", "values"],
            )
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
                    custom_events, last_think_node, draft_sql = iter_nl2sql_custom_events(
                        data,
                        last_think_node=last_think_node,
                        draft_sql=draft_sql,
                    )
                    for ev in custom_events:
                        yield ev
                    continue

                if stream_mode == "updates" and isinstance(data, dict):
                    for node_name, node_state in data.items():
                        if not isinstance(node_state, dict):
                            continue
                        update_state.update(node_state)
                        stage_info = _NODE_STAGE.get(str(node_name))
                        if stage_info:
                            stage, label = stage_info
                            if stage not in completed_stages:
                                completed_stages.add(stage)
                                # HAZARD: 未知 stage 的 order 回落为 99，新增节点时会排到队尾且不易察觉。
                                order = _STAGES_ORDER.index(stage) if stage in _STAGES_ORDER else 99
                                yield shell_event(
                                    ShellEventType.STAGE,
                                    {
                                        "stage": stage,
                                        "label": label,
                                        "hint": label,
                                        "node": node_name,
                                        "order": order,
                                    },
                                )
                            if stage == "generating":
                                sql_draft = _extract_sql_from_state(node_state)
                                if sql_draft and sql_draft != draft_sql:
                                    draft_sql = sql_draft
                                    yield shell_event(
                                        ShellEventType.ARTIFACT,
                                        {"kind": "sql", "sql": sql_draft},
                                    )
                        raw_msg = node_state.get("stream_message")
                        if raw_msg:
                            text = str(raw_msg)
                            if _is_ddl_message(text):
                                yield shell_event(
                                    ShellEventType.LOG,
                                    {"message": "表结构感知完成", "level": "info"},
                                )
                            else:
                                yield shell_event(
                                    ShellEventType.LOG,
                                    {"message": text[:500], "level": "info"},
                                )

            result_state = final_state if final_state is not None else update_state
            if not result_state:
                yield shell_event(ShellEventType.RESULT, {"success": False, "message": "Agent returned an empty result"})
                return

            if isinstance(result_state.get("error"), dict):
                yield shell_event(ShellEventType.RESULT, result_state["error"])
                return

            formatted = format_nl2sql_result(result_state)
            yield shell_event(ShellEventType.RESULT, formatted)
        except Exception as exc:
            yield shell_event(ShellEventType.ERROR, {"message": str(exc)})
        finally:
            await aclose_stream(stream)
