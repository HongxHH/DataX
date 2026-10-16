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
from pathlib import Path

from tests.benchmark.resume_metrics.linking_aggregate import aggregate_linking_from_run
from tests.benchmark.resume_metrics.reuse_math import delta_reuse, summarize_reuse_trials


def _write_case(run_dir: Path, case_id: str, *, linked: list[str], expected: list[str], passed: bool) -> None:
    case_dir = run_dir / case_id
    case_dir.mkdir(parents=True)
    score = {
        "table_recall": {
            "expected": expected,
            "schema_linking": {
                "passed": passed,
                "linked": linked,
                "missing": [t for t in expected if t.lower() not in {x.lower() for x in linked}],
            },
        }
    }
    (case_dir / "score.json").write_text(json.dumps(score), encoding="utf-8")
    (case_dir / "state_meta.json").write_text(
        json.dumps({"schema_tables": linked}),
        encoding="utf-8",
    )


def test_aggregate_linking_b1_rate(tmp_path: Path) -> None:
    ids = ("a", "b", "c")
    _write_case(tmp_path, "a", linked=["room_info", "project"], expected=["room_info", "project"], passed=True)
    _write_case(tmp_path, "b", linked=["room_info"], expected=["room_info", "ref_enum"], passed=False)
    # missing score -> n/a
    (tmp_path / "c").mkdir()

    report = aggregate_linking_from_run(tmp_path, case_ids=ids, n_full=20)
    assert report["b1"]["passed"] == 1
    assert report["b1"]["total"] == 2
    assert report["b1"]["n_a"] == 1
    assert report["b1"]["rate"] == 0.5
    assert report["b1"]["rate_pct"] == 50.0
    assert report["b2"]["median"] == 0.925  # median of 1-2/20 and 1-1/20 -> 0.9 and 0.95


def test_delta_reuse_and_summary() -> None:
    assert abs(delta_reuse(1000.0, 600.0) - 0.4) < 1e-9
    summary = summarize_reuse_trials(
        cold_q2_ms=[1000.0, 1200.0, 1100.0],
        reuse_q2_ms=[600.0, 700.0, 650.0],
        reused_flags=[True, True, True],
        cold_msg_counts=[0, 0, 0],
        reuse_msg_counts=[4, 5, 4],
    )
    assert summary["c1"]["t_cold_q2_median_ms"] == 1100.0
    assert summary["c1"]["t_reuse_q2_median_ms"] == 650.0
    assert summary["c1"]["delta_pct"] == 40.9
    assert summary["c2"]["reused_workspace_rate"] == 1.0
    assert "下降" in (summary["resume_allowed_line"] or "")
