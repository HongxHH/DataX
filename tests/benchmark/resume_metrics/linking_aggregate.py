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
"""Aggregate B1/B2 linking metrics from an existing L1 run directory."""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

from tests.benchmark.resume_metrics.constants import B1_CASE_IDS, METRIC_CARD_VERSION


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _linked_from_score(score: dict[str, Any]) -> list[str] | None:
    linking = ((score.get("table_recall") or {}) if isinstance(score.get("table_recall"), dict) else {}).get(
        "schema_linking"
    )
    if not isinstance(linking, dict):
        return None
    linked = linking.get("linked")
    if linked is None:
        return None
    return [str(x) for x in linked]


def _linking_passed(score: dict[str, Any]) -> bool | None:
    linking = ((score.get("table_recall") or {}) if isinstance(score.get("table_recall"), dict) else {}).get(
        "schema_linking"
    )
    if not isinstance(linking, dict) or "passed" not in linking:
        return None
    return bool(linking.get("passed"))


def _schema_tables_from_meta(meta: dict[str, Any] | None) -> list[str] | None:
    if not meta:
        return None
    tables = meta.get("schema_tables")
    if tables is None:
        return None
    return [str(x) for x in tables]


def median_or_none(values: list[float]) -> float | None:
    if not values:
        return None
    return float(statistics.median(values))


def aggregate_linking_from_run(
    run_dir: Path,
    *,
    case_ids: tuple[str, ...] | list[str] = B1_CASE_IDS,
    n_full: int | None = None,
) -> dict[str, Any]:
    """Build B1 (+ optional B2) report from ``<run>/<case_id>/score.json``."""
    cases: list[dict[str, Any]] = []
    b1_considered = 0
    b1_passed = 0
    b1_na = 0
    reduce_ratios: list[float] = []

    for case_id in case_ids:
        case_dir = run_dir / case_id
        score = _read_json(case_dir / "score.json")
        meta = _read_json(case_dir / "state_meta.json")
        row: dict[str, Any] = {"case_id": case_id, "score_path": str(case_dir / "score.json")}
        if score is None:
            row["b1"] = "n/a"
            row["reason"] = "missing_score_json"
            b1_na += 1
            cases.append(row)
            continue

        passed = _linking_passed(score)
        linked = _linked_from_score(score)
        if linked is None:
            # Fall back to state_meta schema_tables (same source L1 uses for linked_tables).
            linked = _schema_tables_from_meta(meta)
            if linked is not None and score.get("table_recall"):
                # Recompute ⊆ against expected in score if present.
                expected = ((score.get("table_recall") or {}) if isinstance(score.get("table_recall"), dict) else {}).get(
                    "expected"
                ) or []
                want = {str(t).lower() for t in expected if t}
                got = {str(t).lower() for t in linked if t}
                if want:
                    passed = want.issubset(got)
                    row["b1_source"] = "state_meta.schema_tables"
                else:
                    passed = None
            else:
                passed = None

        if passed is None:
            row["b1"] = "n/a"
            row["reason"] = "missing_schema_linking"
            row["linked_tables"] = linked
            b1_na += 1
            cases.append(row)
            continue

        b1_considered += 1
        if passed:
            b1_passed += 1
        row["b1"] = "pass" if passed else "fail"
        row["linked_tables"] = linked
        row["linked_count"] = len(linked or [])

        if n_full and n_full > 0 and linked is not None:
            ratio = 1.0 - (len(linked) / float(n_full))
            row["s_reduce"] = round(ratio, 4)
            reduce_ratios.append(ratio)
        cases.append(row)

    b1_rate = round(b1_passed / b1_considered, 4) if b1_considered else None
    s_median = median_or_none(reduce_ratios)
    return {
        "metric_card_version": METRIC_CARD_VERSION,
        "metric": "B",
        "run_dir": str(run_dir.resolve()),
        "case_ids": list(case_ids),
        "b1": {
            "symbol": "R_link",
            "passed": b1_passed,
            "total": b1_considered,
            "n_a": b1_na,
            "rate": b1_rate,
            "rate_pct": None if b1_rate is None else round(b1_rate * 100.0, 1),
        },
        "b2": {
            "symbol": "S_reduce",
            "n_full": n_full,
            "n_cases_with_ratio": len(reduce_ratios),
            "median": None if s_median is None else round(s_median, 4),
            "median_pct": None if s_median is None else round(s_median * 100.0, 1),
            "note": "optional; resume default off-screen",
        },
        "cases": cases,
        "resume_allowed_line": (
            None
            if b1_rate is None
            else (
                f"在 Landcheck linking 子集（{b1_considered} 题）上，"
                f"感知阶段必含表召回率 {round(b1_rate * 100.0, 1)}%"
            )
        ),
    }
