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
"""Memory indexer: 将 session 记忆写入 MEMORY.md。

在 portraiter 之后调用，将当前 session 的 snapshot 信息写入 MEMORY.md。
同一 session_id 再次结束时替换原章节，避免索引腐烂。
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from loguru import logger

from dataagent.utils.runtime_paths import resolve_flex_session_memory_dir, resolve_user_root

_SNAPSHOT_LIST_FIELDS = (
    ("goals", "Goals"),
    ("decisions", "Decisions"),
    ("important_findings", "Findings"),
)


def _get_memory_md_path(user_id: str) -> Path:
    """返回 MEMORY.md 路径。"""
    return resolve_user_root(user_id=user_id) / ".memory" / "MEMORY.md"


def _load_snapshot(
    user_id: str,
    session_id: str,
    *,
    workspace: str | Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """加载当前 session 的 snapshot。"""
    snap_path = (
        resolve_flex_session_memory_dir(
            user_id=user_id,
            session_id=session_id,
            workspace=workspace,
            config=config,
        )
        / "snapshot.json"
    )
    if not snap_path.exists():
        return {}
    try:
        data = json.loads(snap_path.read_text(encoding="utf-8"))
        # 兼容旧格式（外层有 user_snapshot）和新格式（直接是 snapshot 内容）
        return data.get("user_snapshot") if "user_snapshot" in data else data
    except (OSError, json.JSONDecodeError):
        return {}


def _load_profile(user_id: str) -> dict[str, Any]:
    """加载用户 profile。"""
    profile_path = resolve_user_root(user_id=user_id) / ".memory" / "profile.json"
    if not profile_path.exists():
        return {}
    try:
        data = json.loads(profile_path.read_text(encoding="utf-8"))
        return data.get("user_profile", {})
    except (OSError, json.JSONDecodeError):
        return {}


def _format_list_field(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    items = [str(item).strip() for item in value if str(item).strip()]
    return "; ".join(items)


def _format_session_entry(session_id: str, snapshot: dict[str, Any]) -> str:
    """将一个 session 的 snapshot 格式化为 MEMORY.md 的一个章节。"""
    summary = str(snapshot.get("session_summary") or "No summary").strip() or "No summary"
    lines = [
        f"### {session_id}",
        f"- **Summary**: {summary}",
    ]
    for key, label in _SNAPSHOT_LIST_FIELDS:
        joined = _format_list_field(snapshot.get(key))
        if joined:
            lines.append(f"- **{label}**: {joined}")
    return "\n".join(lines)


def _replace_session_section(existing_content: str, session_id: str, new_entry: str) -> str | None:
    """Replace an existing ``### session_id`` section. Return None if missing."""
    pattern = rf"(?ms)^###\s+{re.escape(session_id)}\s*\n.*?(?=^###\s+|\Z)"
    if not re.search(pattern, existing_content):
        return None
    replacement = new_entry.rstrip() + "\n\n"
    return re.sub(pattern, replacement, existing_content, count=1)


def _insert_session_section(existing_content: str, user_id: str, new_entry: str) -> str:
    """Insert a new session section into MEMORY.md content."""
    if "# Session Summaries" in existing_content:
        pattern = r"(# Session Summaries\n\n)"
        replacement = r"\1" + new_entry + "\n\n"
        return re.sub(pattern, replacement, existing_content, count=1)
    if "# User Profile" in existing_content:
        return existing_content.rstrip() + "\n\n## Session Summaries\n\n" + new_entry + "\n"
    return f"# Memory for {user_id}\n\n## Session Summaries\n\n{new_entry}\n"


def _update_memory_md(user_id: str, session_id: str, snapshot: dict[str, Any]) -> None:
    """写入或替换当前 session 在 MEMORY.md 中的章节。"""
    memory_md_path = _get_memory_md_path(user_id)
    memory_md_path.parent.mkdir(parents=True, exist_ok=True)

    existing_content = ""
    if memory_md_path.exists():
        try:
            existing_content = memory_md_path.read_text(encoding="utf-8")
        except OSError:
            existing_content = ""

    new_entry = _format_session_entry(session_id, snapshot)
    replaced = _replace_session_section(existing_content, session_id, new_entry) if existing_content else None
    if replaced is not None:
        new_content = replaced
        action = "updated"
    else:
        new_content = _insert_session_section(existing_content, user_id, new_entry)
        action = "indexed"

    tmp = memory_md_path.with_suffix(".md.tmp")
    tmp.write_text(new_content, encoding="utf-8")
    tmp.replace(memory_md_path)
    logger.debug(f"[memory_indexer] {action} session {session_id}")


def update_memory_index(
    user_id: str,
    session_id: str,
    *,
    workspace: str | Path | None = None,
    config: Mapping[str, Any] | None = None,
) -> None:
    """入口函数：在 session 结束后调用，更新 MEMORY.md。"""
    if not user_id or not session_id:
        return

    try:
        snapshot = _load_snapshot(user_id, session_id, workspace=workspace, config=config)
        if not snapshot or not snapshot.get("session_summary"):
            logger.debug(f"[memory_indexer] no valid snapshot for session {session_id}")
            return
        _update_memory_md(user_id, session_id, snapshot)
    except Exception as e:
        logger.debug(f"[memory_indexer] failed to update MEMORY.md: {e}")
