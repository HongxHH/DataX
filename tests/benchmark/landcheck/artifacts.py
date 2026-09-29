# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ============================================================================
"""Serialize NL2SQL astream chunks into eval replay artifacts.

Default case outputs:
  - trajectory.json  — per-node steps (+ truncated custom events)
  - final_state.json — JSON-safe final workflow state
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

# Keep dumps readable; full prompts live under workspace/.memory/context_dump when dump-llm is on.
_MAX_STR = 4000
_MAX_LIST = 40
_MAX_ISSUES = 20
_MAX_ROWS = 20
_MAX_PROMPT_PREVIEW = 240
_MAX_CUSTOM_EVENTS = 80
_MAX_SCHEMA_COLS = 80

_RESULT_LIST_KEYS = ("generation_results", "validation_results", "execution_results")


def parse_stream_item(item: Any) -> tuple[str | None, Any] | None:
    """Normalize LangGraph / SDK stream items to ``(stream_mode, data)``.

    Bare dicts (single ``values`` mode, or SDK ``{"error": ...}``) become
    ``("values", dict)`` / ``("error", payload)``.
    """
    if isinstance(item, dict):
        if "error" in item and len(item) == 1:
            return "error", item.get("error")
        return "values", item
    if not isinstance(item, tuple):
        return None
    if len(item) == 3:
        _, stream_mode, data = item
        return str(stream_mode), data
    if len(item) == 2:
        left, right = item
        # Single-mode updates sometimes yield (node_name, state) without a mode tag.
        if isinstance(left, str) and left in {"updates", "values", "custom", "messages", "debug"}:
            return left, right
        if isinstance(left, str) and isinstance(right, dict):
            return "updates", {left: right}
        return str(left), right
    return None


def _truncate_str(value: str, limit: int = _MAX_STR) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + f"...<truncated {len(value) - limit} chars>"


def sanitize_value(value: Any, *, depth: int = 0) -> Any:
    """Recursively make a value JSON-serializable with size caps."""
    if depth > 8:
        return f"<max_depth {type(value).__name__}>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _truncate_str(value)
    if isinstance(value, bytes):
        return f"<bytes len={len(value)}>"
    if is_dataclass(value) and not isinstance(value, type):
        return sanitize_value(asdict(value), depth=depth + 1)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= _MAX_LIST:
                out["__truncated__"] = f"{len(value) - _MAX_LIST} more keys"
                break
            out[str(k)] = sanitize_value(v, depth=depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        items = [sanitize_value(x, depth=depth + 1) for x in list(value)[:_MAX_LIST]]
        if len(value) > _MAX_LIST:
            items.append(f"<truncated {len(value) - _MAX_LIST} more>")
        return items
    if hasattr(value, "model_dump") and callable(value.model_dump):
        try:
            return sanitize_value(value.model_dump(), depth=depth + 1)
        except Exception:  # noqa: BLE001
            return str(value)
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return str(value)


def _sanitize_result(item: Any) -> dict[str, Any]:
    raw: dict[str, Any]
    if is_dataclass(item) and not isinstance(item, type):
        raw = asdict(item)
    elif isinstance(item, dict):
        raw = dict(item)
    else:
        return {"_raw": str(item)}

    prompt = str(raw.get("prompt") or "")
    rows = raw.get("rows")
    row_list = list(rows) if isinstance(rows, (list, tuple)) else None
    preview = raw.get("rows_preview")
    preview_list = list(preview) if isinstance(preview, (list, tuple)) else None

    return {
        "id": raw.get("id"),
        "sql": _truncate_str(str(raw.get("sql") or ""), 8000),
        "strategy": raw.get("strategy"),
        "score": raw.get("score"),
        "confidence": raw.get("confidence"),
        "issues": sanitize_value((raw.get("issues") or [])[:_MAX_ISSUES]),
        "columns": sanitize_value(raw.get("columns")),
        "rows": sanitize_value(row_list[:_MAX_ROWS] if row_list is not None else None),
        "rows_preview": sanitize_value(preview_list[:_MAX_ROWS] if preview_list is not None else None),
        "row_count": len(row_list) if row_list is not None else None,
        "error": raw.get("error"),
        "need_ref": raw.get("need_ref"),
        "security_checked": raw.get("security_checked"),
        "security_violations": sanitize_value(raw.get("security_violations")),
        "prompt_chars": len(prompt),
        "prompt_preview": _truncate_str(prompt, _MAX_PROMPT_PREVIEW) if prompt else "",
    }


def _schema_summary(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        return {"_raw": str(schema)[:500]}
    tables: dict[str, Any] = {}
    for table, meta in list(schema.items())[:_MAX_LIST]:
        if isinstance(meta, dict):
            cols = meta.get("columns") or meta.get("fields") or list(meta.keys())
            if isinstance(cols, dict):
                col_names = list(cols.keys())[:_MAX_SCHEMA_COLS]
            elif isinstance(cols, list):
                col_names = [str(c.get("name") if isinstance(c, dict) else c) for c in cols[:_MAX_SCHEMA_COLS]]
            else:
                col_names = []
            tables[str(table)] = {"columns": col_names, "column_count": len(col_names)}
        else:
            tables[str(table)] = {"_raw": str(meta)[:200]}
    return {"table_count": len(schema), "tables": tables}


def summarize_node_state(node_name: str, state: dict[str, Any]) -> dict[str, Any]:
    """Compact per-node summary for trajectory steps."""
    summary: dict[str, Any] = {"node": node_name}
    if state.get("sql"):
        summary["sql"] = _truncate_str(str(state["sql"]), 4000)
    if state.get("keywords"):
        summary["keywords"] = sanitize_value(state.get("keywords"))
    if state.get("schema") and isinstance(state["schema"], dict):
        summary["schema_tables"] = list(state["schema"].keys())[:_MAX_LIST]
    if state.get("reasoning"):
        summary["reasoning"] = _truncate_str(str(state["reasoning"]), 1500)
    if state.get("stream_message"):
        summary["stream_message"] = _truncate_str(str(state["stream_message"]), 800)
    if "proceed" in state:
        summary["proceed"] = state.get("proceed")
    if "proceed_to_executor" in state:
        summary["proceed_to_executor"] = state.get("proceed_to_executor")
    if "security_sql_approved" in state:
        summary["security_sql_approved"] = state.get("security_sql_approved")
    if "ref_retries" in state:
        summary["ref_retries"] = state.get("ref_retries")
    if "sel_retries" in state:
        summary["sel_retries"] = state.get("sel_retries")
    if "confidence" in state and state.get("confidence") is not None:
        summary["confidence"] = state.get("confidence")
    if "llm_total_tokens" in state:
        summary["llm_total_tokens"] = state.get("llm_total_tokens")
    if state.get("error"):
        summary["error"] = sanitize_value(state.get("error"))

    for key in _RESULT_LIST_KEYS:
        items = state.get(key)
        if not items:
            continue
        summary[key] = [_sanitize_result(x) for x in list(items)[:_MAX_LIST]]
        if len(items) > _MAX_LIST:
            summary[f"{key}_truncated"] = len(items) - _MAX_LIST
    return summary


def sanitize_final_state(state: dict[str, Any] | None) -> dict[str, Any]:
    """JSON-safe final state for ``final_state.json``."""
    if not state:
        return {}
    out: dict[str, Any] = {}
    keep_scalar = (
        "question",
        "sql",
        "confidence",
        "user_id",
        "session_id",
        "run_id",
        "sub_id",
        "workspace",
        "csv_path",
        "sql_path",
        "persist_row_count",
        "persist_truncated",
        "persist_max_rows",
        "security_sql_approved",
        "ref_retries",
        "sel_retries",
        "proceed",
        "llm_total_tokens",
        "score",
    )
    for key in keep_scalar:
        if key in state:
            out[key] = sanitize_value(state.get(key))

    if "keywords" in state:
        out["keywords"] = sanitize_value(state.get("keywords"))
    if "joins" in state:
        out["joins"] = sanitize_value(state.get("joins"))
    if "schema" in state:
        out["schema"] = _schema_summary(state.get("schema"))
    if state.get("schema_str"):
        out["schema_str"] = _truncate_str(str(state["schema_str"]), 6000)
    if state.get("sql_rules"):
        out["sql_rules"] = _truncate_str(str(state["sql_rules"]), 4000)
    if state.get("evidence"):
        out["evidence"] = _truncate_str(str(state["evidence"]), 2000)
    if state.get("few_shot_examples"):
        out["few_shot_examples"] = _truncate_str(str(state["few_shot_examples"]), 2000)
    if state.get("stream_message"):
        out["stream_message"] = _truncate_str(str(state["stream_message"]), 1500)
    if state.get("reasoning"):
        out["reasoning"] = _truncate_str(str(state["reasoning"]), 2000)
    if state.get("error") is not None:
        out["error"] = sanitize_value(state.get("error"))

    for key in _RESULT_LIST_KEYS:
        items = state.get(key)
        if items:
            out[key] = [_sanitize_result(x) for x in list(items)[:_MAX_LIST]]

    if state.get("columns") is not None:
        out["columns"] = sanitize_value(state.get("columns"))
    rows = state.get("rows")
    if isinstance(rows, (list, tuple)):
        out["rows"] = sanitize_value(list(rows)[:_MAX_ROWS])
        out["row_count"] = len(rows)
    if state.get("rows_preview") is not None:
        out["rows_preview"] = sanitize_value(state.get("rows_preview"))

    # Preserve any extra keys lightly so we don't hide new fields.
    known = set(out) | set(keep_scalar) | set(_RESULT_LIST_KEYS) | {
        "messages",
        "schema",
        "schema_str",
        "sql_rules",
        "evidence",
        "few_shot_examples",
        "stream_message",
        "reasoning",
        "columns",
        "rows",
        "rows_preview",
        "keywords",
        "joins",
        "error",
    }
    extras = [k for k in state if k not in known]
    if extras:
        out["_extra_keys"] = extras[:50]
    return out


class StreamArtifactCollector:
    """Accumulate astream chunks into trajectory + final_state."""

    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self.custom_events: list[dict[str, Any]] = []
        self.final_state: dict[str, Any] | None = None
        self.errors: list[Any] = []

    def feed(self, item: Any) -> None:
        parsed = parse_stream_item(item)
        if parsed is None:
            return
        mode, data = parsed
        if mode == "error":
            self.errors.append(sanitize_value(data))
            if isinstance(data, dict):
                self.final_state = {"error": data}
            return
        if mode == "values" and isinstance(data, dict):
            self.final_state = data
            return
        if mode == "custom" and isinstance(data, dict):
            if len(self.custom_events) < _MAX_CUSTOM_EVENTS:
                self.custom_events.append(sanitize_value(data))
            return
        if mode == "updates" and isinstance(data, dict):
            for node_name, node_state in data.items():
                if not isinstance(node_state, dict):
                    # Some backends wrap as {node: partial}; accept non-dict as note.
                    self.steps.append(
                        {
                            "step": len(self.steps) + 1,
                            "node": str(node_name),
                            "stream_mode": "updates",
                            "summary": {"_raw": sanitize_value(node_state)},
                        }
                    )
                    continue
                self.steps.append(
                    {
                        "step": len(self.steps) + 1,
                        "node": str(node_name),
                        "stream_mode": "updates",
                        "summary": summarize_node_state(str(node_name), node_state),
                    }
                )
                # Keep a rolling merged view if values mode is missing.
                if self.final_state is None:
                    self.final_state = dict(node_state)
                elif isinstance(self.final_state, dict):
                    self.final_state = {**self.final_state, **node_state}

    def trajectory_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "steps": self.steps,
            "step_count": len(self.steps),
            "nodes": [s.get("node") for s in self.steps],
        }
        if self.custom_events:
            payload["custom_events"] = self.custom_events
            payload["custom_event_count"] = len(self.custom_events)
        if self.errors:
            payload["errors"] = self.errors
        return payload


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_case_replay_artifacts(
    case_dir: Path,
    *,
    collector: StreamArtifactCollector,
    agent_error: str | None = None,
) -> dict[str, str]:
    """Write trajectory.json + final_state.json; return relative artifact paths."""
    final = sanitize_final_state(collector.final_state)
    if agent_error and "agent_error" not in final:
        final["agent_error"] = agent_error
    traj = collector.trajectory_payload()
    write_json(case_dir / "trajectory.json", traj)
    write_json(case_dir / "final_state.json", final)
    return {
        "trajectory": "trajectory.json",
        "final_state": "final_state.json",
    }
