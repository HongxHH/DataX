"""Persist NL2SQL query results to workspace files for plot/report sub-agents."""

from __future__ import annotations

import csv
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from dataagent.utils.log import logger
from dataagent.utils.runtime_paths import SUBAGENT_OUTPUT_DIR_ENV

MAX_PERSIST_ROWS = 10_000  # HAZARD: 上限写死；超大结果静默截断，调用方只靠 persist_truncated 感知。
# 与 landcheck_nl2sql.yaml 的 executor.preview_limit: 50 对齐（不是 constants 里的默认 5）。
PREVIEW_LIMIT_NOTE = "对话预览约 50 行；落盘 CSV 为查询全量（最多 10000 行）。"


def resolve_persist_workspace(workspace: str | Path | None) -> Path | None:
    """Prefer parent ``subagent_output`` (env), then the given workspace directory."""
    shared = os.getenv(SUBAGENT_OUTPUT_DIR_ENV, "").strip()
    if shared:
        return Path(shared).expanduser().resolve()
    if workspace is None or not str(workspace).strip():
        return None
    return Path(workspace).expanduser().resolve()


def coerce_result_rows(rows: Any) -> list[Any]:
    """Normalize driver/preview rows to a list. ``fetchall()`` may return a tuple of tuples."""
    if rows is None or isinstance(rows, (str, bytes, bytearray)):
        return []
    if isinstance(rows, Sequence):
        return list(rows)
    return []


def rows_for_persist(rows: Any, rows_preview: Any = None) -> list[Any]:
    """Prefer full ``rows``; fall back to preview so Plot never receives a header-only CSV."""
    coerced = coerce_result_rows(rows)
    return coerced if coerced else coerce_result_rows(rows_preview)


def persist_nl2sql_result(
    *,
    sql: str,
    columns: list[str] | None,
    rows: Any,
    workspace: str | Path | None,
    run_id: Any = 0,
    sub_id: Any = None,
) -> dict[str, Any]:
    """Write ``nl2sql/<run_id>[_<sub_id>]/query.sql`` and ``result.csv`` under workspace.

    Preview row counts stay in graph state; this writes the full ``rows`` sequence
    up to ``MAX_PERSIST_ROWS``. Missing workspace (and no shared output dir) or empty SQL skips persist.

    A positive worker ``sub_id`` is required when sharing ``subagent_output``
    (env ``DATAAGENT_SUBAGENT_OUTPUT_DIR``) so parallel workers cannot silently
    share ``nl2sql/<run_id>/``. Standalone NL2SQL (no shared dir, ``sub_id`` 0)
    still writes ``nl2sql/<run_id>/``.
    """
    sql_text = str(sql or "").strip()
    root = resolve_persist_workspace(workspace)
    if not sql_text or root is None:
        return {}
    worker = _positive_sub_id(sub_id)
    shared = os.getenv(SUBAGENT_OUTPUT_DIR_ENV, "").strip()
    if worker is None and shared:
        raise ValueError(
            f"nl2sql persist requires a positive worker sub_id when sharing subagent_output, got {sub_id!r}"
        )
    run_dir = root / "nl2sql" / persist_run_stamp(run_id, worker)
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        logger.warning("nl2sql persist: cannot create {}: {}", run_dir, exc)
        return {}

    sql_path = run_dir / "query.sql"
    csv_path = run_dir / "result.csv"
    col_names = [str(c) for c in columns] if isinstance(columns, list) and columns else []
    raw_rows = coerce_result_rows(rows)
    truncated = len(raw_rows) > MAX_PERSIST_ROWS
    written_rows = raw_rows[:MAX_PERSIST_ROWS]
    if not col_names and written_rows:
        width = len(written_rows[0]) if isinstance(written_rows[0], (list, tuple)) else 1
        col_names = [f"col_{i}" for i in range(width)]

    try:
        sql_path.write_text(f"{sql_text}\n", encoding="utf-8")
        with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            if col_names:
                writer.writerow(col_names)
            for row in written_rows:
                if isinstance(row, (list, tuple)):
                    writer.writerow([_cell(v) for v in row])
                else:
                    writer.writerow([_cell(row)])
    except OSError as exc:
        logger.warning("nl2sql persist: write failed in {}: {}", run_dir, exc)
        return {}

    payload: dict[str, Any] = {
        "sql_path": str(sql_path),
        "csv_path": str(csv_path),
        "persist_row_count": len(written_rows),
        "persist_truncated": truncated,
    }
    logger.info(
        "nl2sql persist: sql={} csv={} rows={} truncated={}",
        sql_path,
        csv_path,
        len(written_rows),
        truncated,
    )
    return payload


def persist_run_stamp(run_id: Any, sub_id: Any = None) -> str:
    """Directory name under ``nl2sql/``; append a positive worker ``sub_id`` when present."""
    stamp = str(run_id if run_id is not None else 0)
    worker = _positive_sub_id(sub_id)
    if worker is None:
        return stamp
    return f"{stamp}_{worker}"


def _positive_sub_id(sub_id: Any) -> int | None:
    if sub_id is None:
        return None
    text = str(sub_id).strip()
    if not text:
        return None
    try:
        value = int(text)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def persist_summary_line(payload: dict[str, Any]) -> str:
    """One-line planner-visible note about persisted files."""
    csv_path = str(payload.get("csv_path") or "").strip()
    sql_path = str(payload.get("sql_path") or "").strip()
    if not csv_path:
        return ""
    count = payload.get("persist_row_count")
    extra = "（已截断到上限 10000 行）" if payload.get("persist_truncated") else ""
    row_bit = f"共 {count} 行{extra}" if isinstance(count, int) else "已落盘"
    return (
        f"查询结果已落盘：CSV `{csv_path}`，SQL `{sql_path}`，{row_bit}。"
        f"{PREVIEW_LIMIT_NOTE}"
    )


def _cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value)
