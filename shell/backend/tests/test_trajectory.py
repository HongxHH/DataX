"""Tests for kernel OTel trajectory summarization."""

from pathlib import Path

from shell.backend.session.trajectory import load_session_trajectory


def test_missing_otel_dir_returns_empty(tmp_path: Path):
    assert load_session_trajectory(tmp_path / "missing") == {"groups": []}


def test_corrupt_and_tmp_files_are_skipped(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    (otel / "trajectory.json.tmp.12_1").write_text("{", encoding="utf-8")
    (otel / "trajectory.tmp.json").write_text("{", encoding="utf-8")
    (otel / "trajectory.json").write_text("{not json", encoding="utf-8")
    assert load_session_trajectory(otel) == {"groups": []}


def test_summarizes_main_and_subagent_tool_spans(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    (otel / "trajectory.json").write_text(
        """
        [
          {
            "role": "main",
            "run_id": 0,
            "round_index": 0,
            "events": [
              {"type": "llm_start", "model": "qwen-plus", "timestamp": 1, "input": [{"role": "user", "content": "查房间"}]},
              {"type": "tool_start", "tool_name": "sub_agent_tool", "tool_call_id": "c1", "timestamp": 2, "arguments": "{\\"query\\": \\"房间数\\"}"},
              {"type": "tool_end", "tool_call_id": "c1", "timestamp": 3, "result": "ok"},
              {"type": "llm_end", "timestamp": 4, "content": "已委派"}
            ]
          }
        ]
        """,
        encoding="utf-8",
    )
    (otel / "trajectory_1_0.json").write_text(
        """
        {
          "role": "sub-agent",
          "run_id": 0,
          "round_index": 0,
          "parent_tool_call_id": "c1",
          "events": [
            {"type": "tool_start", "tool_name": "execute_sql", "tool_call_id": "s1", "timestamp": 2.5},
            {"type": "tool_end", "tool_call_id": "s1", "timestamp": 2.8, "is_error": true, "result": "denied"}
          ]
        }
        """,
        encoding="utf-8",
    )
    payload = load_session_trajectory(otel)
    assert len(payload["groups"]) == 2
    main = payload["groups"][0]
    assert main["file"] == "trajectory.json"
    assert main["role"] == "main"
    assert [ev["type"] for ev in main["events"]] == ["llm_start", "tool_start", "tool_end", "llm_end"]
    assert main["events"][1]["tool_name"] == "sub_agent_tool"
    assert "查房间" in main["events"][0]["prompt"]
    sub = payload["groups"][1]
    assert sub["sub_id"] == 1
    assert sub["run_id"] == 0
    assert sub["parent_tool_call_id"] == "c1"
    assert sub["events"][1]["is_error"] is True
    assert "parent_tool_call_id" not in main
