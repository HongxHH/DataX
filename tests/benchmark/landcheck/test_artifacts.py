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
"""Unit tests for Landcheck L1 replay artifacts (no MySQL / no LLM)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from tests.benchmark.landcheck.artifacts import (
    StreamArtifactCollector,
    parse_stream_item,
    sanitize_final_state,
    summarize_node_state,
    write_case_replay_artifacts,
)


@dataclass
class _FakeResult:
    id: int
    sql: str
    score: float = 0.9
    issues: list[str] | None = None
    prompt: str = "x" * 500
    columns: list[str] | None = None
    rows: list[tuple] | None = None


def test_parse_stream_modes():
    assert parse_stream_item({"sql": "SELECT 1"}) == ("values", {"sql": "SELECT 1"})
    assert parse_stream_item(("updates", {"generator": {"sql": "A"}})) == (
        "updates",
        {"generator": {"sql": "A"}},
    )
    assert parse_stream_item((None, "values", {"sql": "B"})) == ("values", {"sql": "B"})
    assert parse_stream_item({"error": {"message": "boom"}}) == ("error", {"message": "boom"})


def test_collector_builds_named_steps(tmp_path: Path):
    c = StreamArtifactCollector()
    c.feed(("updates", {"perceptor": {"schema": {"project": {}, "room_info": {}}, "keywords": ["智谷"]}}))
    c.feed(("updates", {"generator": {"sql": "SELECT 1", "generation_results": [_FakeResult(0, "SELECT 1")]}}))
    c.feed(("values", {"sql": "SELECT 1", "schema": {"project": {"columns": ["id"]}}, "llm_total_tokens": 12}))
    c.feed(("custom", {"type": "think", "text": "draft"}))

    assert [s["node"] for s in c.steps] == ["perceptor", "generator"]
    assert c.steps[1]["summary"]["sql"] == "SELECT 1"
    assert c.steps[1]["summary"]["generation_results"][0]["prompt_chars"] == 500
    assert c.final_state and c.final_state["sql"] == "SELECT 1"
    assert c.custom_events

    paths = write_case_replay_artifacts(tmp_path, collector=c)
    traj = json.loads((tmp_path / paths["trajectory"]).read_text(encoding="utf-8"))
    final = json.loads((tmp_path / paths["final_state"]).read_text(encoding="utf-8"))
    assert traj["step_count"] == 2
    assert traj["nodes"] == ["perceptor", "generator"]
    assert final["sql"] == "SELECT 1"
    assert final["schema"]["tables"]["project"]["columns"] == ["id"]
    assert final["llm_total_tokens"] == 12


def test_sanitize_final_state_truncates_results():
    state = {
        "question": "q",
        "sql": "SELECT 1",
        "schema": {"t": {"columns": [{"name": "a"}, {"name": "b"}]}},
        "execution_results": [_FakeResult(1, "SELECT 1", rows=[(i,) for i in range(50)], columns=["n"])],
        "messages": ["ignored-in-full"],
    }
    out = sanitize_final_state(state)
    assert out["schema"]["tables"]["t"]["columns"] == ["a", "b"]
    assert out["execution_results"][0]["row_count"] == 50
    assert len(out["execution_results"][0]["rows"]) == 20


def test_summarize_validator():
    summary = summarize_node_state(
        "validator",
        {"validation_results": [_FakeResult(0, "SELECT 1", score=0.5, issues=["bad"])], "security_sql_approved": True},
    )
    assert summary["security_sql_approved"] is True
    assert summary["validation_results"][0]["issues"] == ["bad"]
