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
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dataagent.actions.tools.context import ToolExecutionContext
from dataagent.actions.tools.local_tool.sandbox import get_current_sandbox


def _recall_run_dir(cm: Any) -> Path:
    guard = get_current_sandbox()
    workspace = guard.workspace_root or Path.cwd().resolve()
    recall_id = "default"
    if cm is not None:
        recall_id = cm.get("DOCUMENT_RECALL.run_id") or "default"
    return workspace / "document_recall" / str(recall_id)


def _max_recall_entries(cm: Any) -> int:
    if cm is None:
        return 0
    raw = cm.get("DOCUMENT_RECALL.max_entries")
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        return 0
    return limit if limit > 0 else 0


def _json_entry_files(entries_dir: Path) -> list[Path]:
    if not entries_dir.is_dir():
        return []
    files: list[tuple[int, str, Path]] = []
    for path in entries_dir.iterdir():
        if not (path.is_file() and path.suffix == ".json"):
            continue
        try:
            files.append((path.stat().st_mtime_ns, path.name, path))
        except OSError:
            continue
    files.sort()
    return [path for _, _, path in files]


def _json_entry_count(entries_dir: Path) -> int:
    return len(_json_entry_files(entries_dir))


def _keep_oldest_entries(entries_dir: Path, limit: int, keep_path: Path) -> bool:
    """Trim newest JSON files until ``limit`` remain. Return whether ``keep_path`` survived."""
    extras = _json_entry_files(entries_dir)[limit:]
    for extra in extras:
        extra.unlink(missing_ok=True)
    return keep_path.is_file()


def save_recall_entry(
    source_path: str,
    start_line: int,
    end_line: int,
    relevance: str,
    excerpt: str,
    *,
    _tool_context: ToolExecutionContext,
) -> dict[str, Any]:
    """保存一条文档召回摘录到 workspace。

    每找到一个与查询相关的段落就调用一次，可以并行调用。条目最终通过 merge_recall_results 整合。

    Args:
        source_path (str): 文档路径
        start_line (int): 摘录起始行号
        end_line (int): 摘录结束行号
        relevance (str): 与查询的语义关联说明（一句话）
        excerpt (str): 原文摘录（保持原意，不要改写）

    Returns:
        dict with original_msg, frontend_msg, and data.entry_file
    """
    cm = _tool_context.config_manager
    run_dir = _recall_run_dir(cm)
    entries_dir = run_dir / "recall_entries"
    entries_dir.mkdir(parents=True, exist_ok=True)

    limit = _max_recall_entries(cm)
    if limit and _json_entry_count(entries_dir) >= limit:
        msg = f"摘录已达上限 {limit} 条，请立即调用 merge_recall_results，不要继续 save_recall_entry"
        return {
            "original_msg": msg,
            "frontend_msg": msg,
            "data": {"entry_file": None, "skipped": True},
        }

    entry = {
        "source_path": source_path,
        "start_line": start_line,
        "end_line": end_line,
        "relevance": relevance,
        "excerpt": excerpt,
    }

    entry_path = entries_dir / f"{uuid.uuid4().hex[:8]}.json"
    entry_path.write_text(json.dumps(entry, ensure_ascii=False, indent=2), encoding="utf-8")
    if limit and not _keep_oldest_entries(entries_dir, limit, entry_path):
        msg = f"摘录已达上限 {limit} 条，请立即调用 merge_recall_results，不要继续 save_recall_entry"
        return {
            "original_msg": msg,
            "frontend_msg": msg,
            "data": {"entry_file": None, "skipped": True},
        }

    msg = f"已保存摘录: {source_path} L{start_line}-L{end_line}"
    return {
        "original_msg": msg,
        "frontend_msg": msg,
        "data": {"entry_file": str(entry_path)},
    }


def merge_recall_results(
    summary: str,
    *,
    _tool_context: ToolExecutionContext,
) -> dict[str, Any]:
    """合并所有已保存的摘录条目，生成最终的召回结果 JSON 文件。

    必须在所有 save_recall_entry 调用完成后执行一次。

    Args:
        summary (str): 召回摘要，包含搜索文档数、相关文档数、关键发现等

    Returns:
        dict with original_msg, frontend_msg, and data.output_path + data.num_entries
    """
    cm = _tool_context.config_manager
    run_dir = _recall_run_dir(cm)
    entries_dir = run_dir / "recall_entries"

    if not entries_dir.is_dir():
        return {
            "original_msg": "没有待合并的召回条目（recall_entries/ 目录不存在，可能已经合并过了）",
            "frontend_msg": "没有待合并的召回条目",
            "data": {"output_path": None, "num_entries": 0},
        }
    output_path = run_dir / "recall_result.json"

    entries: list[dict[str, Any]] = []
    for f in sorted(entries_dir.iterdir()):
        if f.suffix == ".json":
            try:
                entries.append(json.loads(f.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                continue

    if not entries:
        entries_dir.rmdir()
        return {
            "original_msg": "recall_entries/ 中没有有效的 JSON 条目文件",
            "frontend_msg": "没有有效的召回条目",
            "data": {"output_path": None, "num_entries": 0},
        }

    result = {
        "timestamp": datetime.now(UTC).isoformat(),
        "summary": summary,
        "num_entries": len(entries),
        "entries": entries,
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # 清理临时条目文件
    if entries_dir.is_dir():
        for f in entries_dir.iterdir():
            if f.suffix == ".json":
                f.unlink(missing_ok=True)
        entries_dir.rmdir()

    msg = f"召回结果已整合到 {output_path}\n共 {len(entries)} 条摘录\n摘要：{summary}"
    return {
        "original_msg": msg,
        "frontend_msg": msg,
        "data": {"output_path": str(output_path), "num_entries": len(entries)},
    }
