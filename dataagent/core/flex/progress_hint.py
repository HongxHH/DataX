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
"""Shared FlexAgent astream custom events (progress hints and query rewrite).

Planner must not import from ``flex.agent`` (node → agent layering).
"""

from typing import Any


def progress_hint_payload(hint: str, *, node: str = "planner") -> dict[str, Any]:
    return {
        "type": "progress_hint",
        "node_name": node,
        "hint": hint,
        "stage": "planning",
    }


def progress_hint_event(hint: str, *, node: str = "planner") -> tuple[str, dict[str, Any]]:
    """图启动前无 LangGraph writer，由 FlexAgent 直接 yield custom 事件。"""
    return ("custom", progress_hint_payload(hint, node=node))


def context_rewrite_event(state: dict[str, Any] | None) -> tuple[str, dict[str, Any]] | None:
    """Yield a custom event when the rewriter actually changed ``user_query``."""
    if not isinstance(state, dict):
        return None
    raw = str(state.get("raw_user_query") or "").strip()
    rewritten = str(state.get("user_query") or "").strip()
    if not raw or not rewritten or raw == rewritten:
        return None
    return (
        "custom",
        {
            "type": "context_rewrite",
            "raw_user_query": raw,
            "user_query": rewritten,
        },
    )


_RECALL_STATUSES = frozenset({"disabled", "empty", "hit"})
_RECALL_PREVIEW_MAX = 200


def _clip_recall_preview(text: str) -> str:
    compact = " ".join(str(text or "").split())
    if not compact:
        return ""
    if len(compact) <= _RECALL_PREVIEW_MAX:
        return compact
    return compact[: _RECALL_PREVIEW_MAX - 1] + "…"


def cross_session_recall_event(state: dict[str, Any] | None) -> tuple[str, dict[str, Any]] | None:
    """Yield a compact recall result for the shell prep log. Never the full memory blob."""
    if not isinstance(state, dict):
        return None
    meta = state.get("cross_session_recall_meta")
    if not isinstance(meta, dict):
        return None
    status = str(meta.get("status") or "").strip()
    if status not in _RECALL_STATUSES:
        return None
    try:
        hit_count = int(meta.get("hit_count") or 0)
    except (TypeError, ValueError):
        hit_count = 0
    payload: dict[str, Any] = {
        "type": "cross_session_recall",
        "status": status,
        "hit_count": hit_count,
    }
    preview = _clip_recall_preview(str(meta.get("preview") or ""))
    if preview:
        payload["preview"] = preview
    return ("custom", payload)
