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
"""Cross-session memory recall hook.

检索历史 session 的 summary，注入到当前 state["cross_session_memory"]，
供 planner 在构建 prompt 时使用。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import jieba
from loguru import logger

from dataagent.core.cbb.runtime import Runtime
from dataagent.core.flex.hooks.agent_turn import is_subagent
from dataagent.core.flex.workflow.state import FlexState
from dataagent.utils.constants import DEFAULT_CROSS_SESSION_RECALL_MAX_CHARS, DEFAULT_CROSS_SESSION_RECALL_TOP_K
from dataagent.utils.runtime_paths import resolve_flex_session_memory_dir, resolve_user_root


def _load_memory_index(user_id: str) -> Path | None:
    """返回 MEMORY.md 路径，若不存在返回 None。"""
    memory_md = resolve_user_root(user_id=user_id) / ".memory" / "MEMORY.md"
    return memory_md if memory_md.exists() else None


def _parse_sessions_from_memory_md(memory_md: Path, current_session_id: str) -> list[dict[str, Any]]:
    """解析 MEMORY.md，提取各 session 的 summary 信息（排除当前 session）。"""
    sessions = []
    try:
        content = memory_md.read_text(encoding="utf-8")
    except OSError:
        return sessions

    # 按 ### session_id 分割
    parts = re.split(r"^###\s+", content, flags=re.MULTILINE)
    for part in parts[1:]:  # 跳过第一部分（标题等）
        lines = part.split("\n")
        session_id = lines[0].strip()
        if not session_id or session_id == current_session_id:
            continue

        session_info = {"session_id": session_id, "search_text": ""}
        # 收集该 session 下所有文本
        for line in lines[1:]:
            if line.startswith("### ") or line.startswith("# "):
                break
            session_info["search_text"] += line + "\n"

        sessions.append(session_info)

    return sessions


def _snapshot_search_text(snap: dict[str, Any]) -> str:
    def _join(value: Any) -> str:
        if isinstance(value, list):
            return " ".join(str(item) for item in value if item)
        return str(value or "").strip()

    return " ".join(
        [
            str(snap.get("session_summary") or "").strip(),
            _join(snap.get("goals")),
            _join(snap.get("decisions")),
            _join(snap.get("important_findings")),
        ]
    ).strip()


def _load_sessions_from_directories(user_id: str, current_session_id: str) -> list[dict[str, Any]]:
    """回退方案：直接扫描 session 目录，加载 snapshot.json。"""
    sessions = []
    user_root = resolve_user_root(user_id=user_id)
    if not user_root.exists():
        return sessions

    try:
        for session_dir in user_root.iterdir():
            if not session_dir.is_dir() or session_dir.name == current_session_id:
                continue
            snapshot_path = (
                resolve_flex_session_memory_dir(user_id=user_id, session_id=session_dir.name) / "snapshot.json"
            )
            if not snapshot_path.exists():
                continue
            try:
                data = json.loads(snapshot_path.read_text(encoding="utf-8"))
                # 兼容旧格式（外层有 user_snapshot）和新格式（直接是 snapshot 内容）
                snap = data.get("user_snapshot") if "user_snapshot" in data else data
                if not isinstance(snap, dict):
                    continue
                search_text = _snapshot_search_text(snap)
                if not search_text:
                    continue
                sessions.append({"session_id": session_dir.name, "search_text": search_text})
            except (OSError, json.JSONDecodeError):
                continue
    except OSError:
        pass

    return sessions


def _collect_recall_sessions(user_id: str, current_session_id: str) -> list[dict[str, Any]]:
    """合并 snapshot 目录与 MEMORY.md：有 snapshot 用 snapshot，否则用索引摘要。"""
    by_id: dict[str, dict[str, Any]] = {}
    for session in _load_sessions_from_directories(user_id, current_session_id):
        by_id[session["session_id"]] = session
    memory_md = _load_memory_index(user_id)
    if memory_md:
        for session in _parse_sessions_from_memory_md(memory_md, current_session_id):
            if str(session.get("search_text") or "").strip():
                by_id.setdefault(session["session_id"], session)
    return list(by_id.values())


def _tokenize(text: str) -> set[str]:
    """分词：中文用 jieba，英文按空格分词（转小写去重）。"""
    if not text:
        return set()
    text = text.lower()
    tokens = set()
    for word in jieba.cut(text):
        word = word.strip()
        if word:
            tokens.add(word)
    return tokens


def _keyword_relevance(query: str, doc_text: str) -> float:
    """计算关键词重叠度：|query_tokens ∩ doc_tokens| / |query_tokens|"""
    if not query or not doc_text:
        return 0.0
    query_tokens = _tokenize(query)
    doc_tokens = _tokenize(doc_text)
    if not query_tokens:
        return 0.0
    return len(query_tokens & doc_tokens) / len(query_tokens)


_RECALL_META_KEY = "cross_session_recall_meta"
_PREVIEW_MAX = 200


def _clip_preview(text: str, limit: int = _PREVIEW_MAX) -> str:
    compact = " ".join(str(text or "").split())
    if not compact:
        return ""
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "…"


def _set_recall_meta(
    state: FlexState,
    status: str,
    *,
    hit_count: int = 0,
    preview: str = "",
) -> None:
    meta: dict[str, Any] = {"status": status, "hit_count": int(hit_count)}
    clipped = _clip_preview(preview)
    if clipped:
        meta["preview"] = clipped
    state[_RECALL_META_KEY] = meta


def _build_cross_session_memory(
    sessions: list[dict[str, Any]], query: str, top_k: int = 3, max_chars: int = 1500
) -> tuple[str, int]:
    """根据相关度排序，返回 top-k session 的 markdown 文本和命中段数。"""
    if not sessions:
        return "", 0

    scored = [(s, _keyword_relevance(query, s["search_text"])) for s in sessions]
    scored.sort(key=lambda x: x[1], reverse=True)

    parts = []
    for session, score in scored[:top_k]:
        if score < 0.01:
            continue
        text = session["search_text"][:max_chars]
        parts.append(f"### {session['session_id']}\n{text}\n")

    return ("\n".join(parts), len(parts)) if parts else ("", 0)


def cross_session_recall(state: FlexState, runtime: Runtime) -> FlexState:
    """Pre-hook：检索历史 session 的 summary，写入 state["cross_session_memory"]。"""
    if is_subagent(state):
        return state

    user_id = str(state.get("user_id") or "").strip()
    session_id = str(state.get("session_id") or "").strip()
    query = str(state.get("user_query") or "").strip()

    if not user_id or not session_id or not query:
        _set_recall_meta(state, "empty")
        return state

    # 检查配置：enable_cross_session_recall（缺 per-Agent ConfigManager 时 fail-fast）
    enabled = runtime.get_config("CROSS_SESSION_RECALL.enable", True)
    if not enabled:
        _set_recall_meta(state, "disabled")
        return state

    try:
        sessions = _collect_recall_sessions(user_id, session_id)

        if not sessions:
            _set_recall_meta(state, "empty")
            return state

        top_k = DEFAULT_CROSS_SESSION_RECALL_TOP_K
        max_chars = DEFAULT_CROSS_SESSION_RECALL_MAX_CHARS
        try:
            top_k = int(runtime.get_config("CROSS_SESSION_RECALL.top_k", DEFAULT_CROSS_SESSION_RECALL_TOP_K))
            max_chars = int(
                runtime.get_config("CROSS_SESSION_RECALL.max_chars_per_session", DEFAULT_CROSS_SESSION_RECALL_MAX_CHARS)
            )
        except Exception as e:
            logger.debug(f"[cross_session_recall] config error: {e}")

        cross_memory, hit_count = _build_cross_session_memory(sessions, query, top_k=top_k, max_chars=max_chars)
        if cross_memory:
            state["cross_session_memory"] = cross_memory
            _set_recall_meta(state, "hit", hit_count=hit_count, preview=cross_memory)
            logger.debug(f"[cross_session_recall] injected {len(sessions)} sessions, top {top_k}")
        else:
            _set_recall_meta(state, "empty")

    except Exception as e:
        logger.debug(f"[cross_session_recall] skipped: {e}")
        _set_recall_meta(state, "empty")

    return state
