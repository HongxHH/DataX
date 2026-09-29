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
"""Deterministic ORDER BY alignment with explicit「按 X」ranking questions."""

from __future__ import annotations

import re

ORDER_KEY_MISMATCH = "ORDER-001"

_RANK_HINT_RE = re.compile(r"(排名|取前\s*\d+|前\s*\d+|top\s*\d+)", re.IGNORECASE)
_BY_METRIC_RE = re.compile(
    r"按\s*(房间数|间数|建筑面积|面积|测绘报告数|报告数|报告份数)",
)

# Question metric phrase → tokens that may appear in ORDER BY (alias / expr / column).
_METRIC_ORDER_TOKENS: dict[str, frozenset[str]] = {
    "房间数": frozenset({"rooms", "room", "room_count", "roomcnt", "房间数", "间数"}),
    "间数": frozenset({"rooms", "room", "room_count", "roomcnt", "房间数", "间数"}),
    "建筑面积": frozenset(
        {"area", "building_area", "buildingarea", "total_building_area", "面积", "建筑面积"}
    ),
    "面积": frozenset(
        {"area", "building_area", "buildingarea", "total_building_area", "面积", "建筑面积"}
    ),
    "测绘报告数": frozenset(
        {"surveys", "survey", "survey_count", "survey_report_count", "报告数", "测绘报告数", "报告份数"}
    ),
    "报告数": frozenset(
        {"surveys", "survey", "survey_count", "survey_report_count", "报告数", "测绘报告数", "报告份数"}
    ),
    "报告份数": frozenset(
        {"surveys", "survey", "survey_count", "survey_report_count", "报告数", "测绘报告数", "报告份数"}
    ),
}

_ORDER_BY_RE = re.compile(r"(?is)\bORDER\s+BY\s+(.+?)(?:\bLIMIT\b|\bOFFSET\b|\bFETCH\b|;|$)")


def ranking_metric_from_question(question: str) -> str | None:
    """Return the explicit「按 X」metric when the question also asks to rank / take top-N."""
    text = str(question or "")
    if not _RANK_HINT_RE.search(text):
        return None
    match = _BY_METRIC_RE.search(text)
    if not match:
        return None
    return match.group(1)


def _normalize_token(text: str) -> str:
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", str(text).strip().lower(), flags=re.UNICODE)


def order_by_primary_tokens(sql: str) -> list[str]:
    """Extract normalized tokens from the first ORDER BY key (before ASC/DESC / commas)."""
    match = _ORDER_BY_RE.search(sql or "")
    if not match:
        return []
    clause = match.group(1).strip()
    first = clause.split(",")[0].strip()
    first = re.sub(r"(?i)\s+(ASC|DESC)\s*$", "", first).strip()
    # Drop function wrappers lightly: ORDER BY SUM(building_area) → building_area still visible.
    parts = re.findall(r"[\w\u4e00-\u9fff]+", first, flags=re.UNICODE)
    return [_normalize_token(p) for p in parts if _normalize_token(p)]


def check_order_by_contract(*, question: str, sql: str) -> list[str]:
    """Return issues when question says「按 X 排名」but ORDER BY is a different metric.

    Skip when the question has no explicit「按 X」+ ranking cue (ambiguous cases stay LLM/scorer).
    """
    metric = ranking_metric_from_question(question)
    if not metric:
        return []
    allowed = _METRIC_ORDER_TOKENS.get(metric) or frozenset()
    tokens = order_by_primary_tokens(sql)
    if not tokens:
        return [
            f"{ORDER_KEY_MISMATCH}: Question ranks by {metric} but SQL has no ORDER BY."
        ]
    if any(tok in allowed for tok in tokens):
        return []
    return [
        f"{ORDER_KEY_MISMATCH}: Question ranks by {metric} but ORDER BY uses "
        f"{'/'.join(tokens)}; expected one of {sorted(allowed)}."
    ]
