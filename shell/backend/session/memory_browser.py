"""Read-only cross-session memory catalog for the shell memory desk."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from dataagent.core.flex.hooks.cross_session_recall import (
    _build_cross_session_memory,
    _collect_recall_sessions,
    _keyword_relevance,
    _tokenize,
)
from dataagent.utils.constants import (
    DEFAULT_CROSS_SESSION_RECALL_MAX_CHARS,
    DEFAULT_CROSS_SESSION_RECALL_TOP_K,
    DEFAULT_USER_ID,
)
from dataagent.utils.runtime_paths import resolve_flex_session_memory_dir, resolve_user_root

# Keep in lockstep with kernel `_build_cross_session_memory` score skip.
_RECALL_SCORE_THRESHOLD = 0.01

_SNAPSHOT_LIST_FIELDS = (
    "session_summary",
    "goals",
    "constraints",
    "decisions",
    "important_findings",
    "artifacts",
)


def list_memory_catalog(
    *,
    user_id: str = DEFAULT_USER_ID,
    current_session_id: str | None = None,
) -> dict[str, Any]:
    """List session snapshots + whether MEMORY.md / profile exist."""
    root = resolve_user_root(user_id=user_id)
    sessions: list[dict[str, Any]] = []
    if root.exists():
        for path in root.iterdir():
            if not path.is_dir() or path.name.startswith("."):
                continue
            entry = _session_list_entry(user_id, path.name, current_session_id)
            if entry is not None:
                sessions.append(entry)
        sessions.sort(key=lambda item: (-(item.get("mtime") or 0.0), str(item.get("session_id") or "")))
    memory_dir = root / ".memory"
    return {
        "user_id": user_id,
        "sessions": sessions,
        "has_memory_md": (memory_dir / "MEMORY.md").is_file(),
        "has_profile": (memory_dir / "profile.json").is_file(),
    }


def load_session_snapshot(*, user_id: str = DEFAULT_USER_ID, session_id: str) -> dict[str, Any] | None:
    """Return normalized snapshot fields for one session, or None if missing."""
    sid = _safe_session_id(session_id)
    if sid is None:
        return None
    path = resolve_flex_session_memory_dir(user_id=user_id, session_id=sid) / "snapshot.json"
    snap = _read_snapshot(path)
    if snap is None:
        return None
    return {
        "kind": "snapshot",
        "session_id": sid,
        "path": str(path),
        "snapshot": _public_snapshot(snap),
    }


def load_memory_markdown(*, user_id: str = DEFAULT_USER_ID) -> dict[str, Any] | None:
    """Return MEMORY.md text when present."""
    path = resolve_user_root(user_id=user_id) / ".memory" / "MEMORY.md"
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    return {"kind": "memory_md", "path": str(path), "content": text}


def load_user_profile(*, user_id: str = DEFAULT_USER_ID) -> dict[str, Any] | None:
    """Return profile.json payload when present."""
    path = resolve_user_root(user_id=user_id) / ".memory" / "profile.json"
    payload = _read_json(path)
    if payload is None:
        return None
    profile = payload.get("user_profile") if isinstance(payload, dict) else None
    if not isinstance(profile, dict):
        profile = payload if isinstance(payload, dict) else {}
    return {"kind": "profile", "path": str(path), "profile": profile}


def trial_cross_session_recall(
    query: str,
    *,
    user_id: str = DEFAULT_USER_ID,
    current_session_id: str | None = None,
    top_k: int = DEFAULT_CROSS_SESSION_RECALL_TOP_K,
    max_chars: int = DEFAULT_CROSS_SESSION_RECALL_MAX_CHARS,
) -> dict[str, Any]:
    """Score historical sessions with the same keyword overlap the kernel uses."""
    q = str(query or "").strip()
    k = max(0, int(top_k))
    if not q:
        return {
            "query": "",
            "hits": [],
            "packed": "",
            "hit_count": 0,
            "top_k": k,
            "max_chars": max_chars,
            "query_tokens": [],
            "threshold": _RECALL_SCORE_THRESHOLD,
            "miss_summary": "问句为空。",
        }
    current = _safe_session_id(current_session_id) or ""
    sessions = _collect_recall_sessions(user_id, current)
    query_tokens = _sorted_tokens(q)
    ranked = [(session, float(_keyword_relevance(q, str(session.get("search_text") or "")))) for session in sessions]
    ranked.sort(key=lambda item: (-item[1], str(item[0].get("session_id") or "")))
    would_pack: set[str] = set()
    for session, score in ranked[:k]:
        if score < _RECALL_SCORE_THRESHOLD:
            continue
        sid = str(session.get("session_id") or "")
        if sid:
            would_pack.add(sid)
    hits = []
    for session, score in ranked:
        sid = str(session.get("session_id") or "")
        packed = sid in would_pack
        hits.append(
            {
                "session_id": sid,
                "score": round(score, 4),
                "would_pack": packed,
                "preview": _clip(str(session.get("search_text") or ""), 160),
                "overlap_tokens": _overlap_tokens(q, str(session.get("search_text") or "")),
                "reject_reason": None if packed else _reject_reason(score),
            }
        )
    packed, hit_count = _build_cross_session_memory(sessions, q, top_k=k, max_chars=max_chars)
    return {
        "query": q,
        "top_k": k,
        "max_chars": max_chars,
        "hit_count": hit_count,
        "hits": hits,
        "packed": packed,
        "query_tokens": query_tokens,
        "threshold": _RECALL_SCORE_THRESHOLD,
        "miss_summary": _miss_summary(sessions, ranked, hit_count, k),
    }


def _session_list_entry(user_id: str, session_id: str, current_session_id: str | None) -> dict[str, Any] | None:
    path = resolve_flex_session_memory_dir(user_id=user_id, session_id=session_id) / "snapshot.json"
    snap = _read_snapshot(path)
    if snap is None:
        return None
    summary = str(snap.get("session_summary") or "").strip()
    return {
        "kind": "snapshot",
        "session_id": session_id,
        "is_current": bool(current_session_id) and session_id == current_session_id,
        "session_summary": summary,
        "goals_count": _list_len(snap.get("goals")),
        "decisions_count": _list_len(snap.get("decisions")),
        "findings_count": _list_len(snap.get("important_findings")),
        "mtime": _mtime(path),
    }


def _public_snapshot(snap: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in _SNAPSHOT_LIST_FIELDS:
        value = snap.get(key)
        if key == "session_summary":
            out[key] = str(value or "")
        elif isinstance(value, list):
            out[key] = [str(item) for item in value if str(item).strip()]
        else:
            out[key] = []
    return out


def _read_snapshot(path: Path) -> dict[str, Any] | None:
    payload = _read_json(path)
    if not isinstance(payload, dict):
        return None
    snap = payload.get("user_snapshot") if "user_snapshot" in payload else payload
    return snap if isinstance(snap, dict) else None


def _read_json(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _safe_session_id(value: str | None) -> str | None:
    text = str(value or "").strip()
    if not text or any(part in text for part in ("..", "/", "\\")):
        return None
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", text):
        return None
    return text


def _list_len(value: Any) -> int:
    return len(value) if isinstance(value, list) else 0


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _clip(text: str, limit: int) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "…"


def _sorted_tokens(text: str) -> list[str]:
    return sorted(_tokenize(text))


def _overlap_tokens(query: str, doc_text: str) -> list[str]:
    return sorted(_tokenize(query) & _tokenize(doc_text))


def _reject_reason(score: float) -> str:
    if score < _RECALL_SCORE_THRESHOLD:
        return "below_threshold"
    return "outside_top_k"


def _miss_summary(
    sessions: list[dict[str, Any]],
    ranked: list[tuple[dict[str, Any], float]],
    hit_count: int,
    top_k: int,
) -> str:
    if hit_count > 0:
        return ""
    if not sessions:
        return "没有可检索的历史会话（当前会话除外）。"
    above = sum(1 for _session, score in ranked if score >= _RECALL_SCORE_THRESHOLD)
    if above == 0:
        return f"分词后与历史 snapshot 的关键词重叠均低于阈值 {_RECALL_SCORE_THRESHOLD}。"
    return f"有会话超过阈值，但未进入 top_k={top_k}。"
