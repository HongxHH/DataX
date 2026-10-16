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
"""Pure helpers for resume metric C1 (reuse vs cold E2E)."""

from __future__ import annotations

import statistics
from typing import Any


def median_ms(values: list[float]) -> float | None:
    if not values:
        return None
    return float(statistics.median(values))


def delta_reuse(t_cold_ms: float, t_reuse_ms: float) -> float:
    """Return (t_cold - t_reuse) / t_cold. Raises if t_cold <= 0."""
    if t_cold_ms <= 0:
        raise ValueError("t_cold_ms must be > 0")
    return (t_cold_ms - t_reuse_ms) / t_cold_ms


def summarize_reuse_trials(
    *,
    cold_q2_ms: list[float],
    reuse_q2_ms: list[float],
    reused_flags: list[bool] | None = None,
    cold_msg_counts: list[int] | None = None,
    reuse_msg_counts: list[int] | None = None,
) -> dict[str, Any]:
    """Build C1 (+ C2 hints) from trial measurements (warmup already dropped)."""
    t_cold = median_ms(cold_q2_ms)
    t_reuse = median_ms(reuse_q2_ms)
    delta = None
    if t_cold is not None and t_reuse is not None and t_cold > 0:
        delta = delta_reuse(t_cold, t_reuse)

    reused_rate = None
    if reused_flags:
        reused_rate = round(sum(1 for x in reused_flags if x) / len(reused_flags), 4)

    return {
        "c1": {
            "symbol": "Delta_reuse",
            "k": min(len(cold_q2_ms), len(reuse_q2_ms)),
            "t_cold_q2_median_ms": None if t_cold is None else round(t_cold, 1),
            "t_reuse_q2_median_ms": None if t_reuse is None else round(t_reuse, 1),
            "delta": None if delta is None else round(delta, 4),
            "delta_pct": None if delta is None else round(delta * 100.0, 1),
            "cold_q2_ms": [round(x, 1) for x in cold_q2_ms],
            "reuse_q2_ms": [round(x, 1) for x in reuse_q2_ms],
        },
        "c2": {
            "reused_workspace_rate": reused_rate,
            "cold_message_counts": cold_msg_counts,
            "reuse_message_counts": reuse_msg_counts,
            "note": "reuse still spawns a new subprocess; gain is hydrate",
        },
        "resume_allowed_line": (
            None
            if delta is None
            else (
                f"同会话追问复用子 Agent 工作区，第 2 问端到端耗时较冷启动下降 "
                f"{round(delta * 100.0, 1)}%（中位，k={min(len(cold_q2_ms), len(reuse_q2_ms))}）"
            )
        ),
    }
