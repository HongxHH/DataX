"""Shared clip/trim helpers for session persist. Keep tails; never drop checkpoints first."""

from __future__ import annotations

CHECKPOINT_PREFIXES = ("问句已改写为 ", "跨会话记忆：")
PLAN_PREP_MAX = 20
STAGES_MAX = 20
LOGS_MAX = 50
MAIN_THINKING_MAX = 2000
WORKBENCH_THINKING_MAX = 8000
SUB_THINKING_MAX = 2000


def clip_thinking_tail(text: str, max_len: int) -> str:
    """Keep the latest thinking tokens. Matches frontend ``clipThinkingTail``."""
    if not text or len(text) <= max_len:
        return text
    return "…" + text[-(max_len - 1) :]


def is_prep_checkpoint(text: str) -> bool:
    trimmed = str(text).strip()
    return any(trimmed.startswith(prefix) for prefix in CHECKPOINT_PREFIXES)


def trim_plan_prep(items: list[str] | None, limit: int = PLAN_PREP_MAX) -> list[str]:
    """Keep all rewrite/recall checkpoints; drop oldest heartbeats when over the window."""
    if not items:
        return []
    texts = [str(item) for item in items]
    if len(texts) <= limit:
        return texts
    checkpoints = [index for index, text in enumerate(texts) if is_prep_checkpoint(text)]
    heartbeats = [index for index, text in enumerate(texts) if not is_prep_checkpoint(text)]
    if len(checkpoints) >= limit:
        keep = set(checkpoints[-limit:])
    else:
        keep = set(checkpoints)
        keep.update(heartbeats[-(limit - len(checkpoints)) :])
    return [text for index, text in enumerate(texts) if index in keep]
