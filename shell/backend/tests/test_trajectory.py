"""Tests for kernel OTel trajectory summarization."""

import json
from pathlib import Path

from shell.backend.session.trajectory import load_session_trajectory, load_trajectory_prompt


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
    assert main["chunk_index"] == 0
    assert main["role"] == "main"
    assert [ev["type"] for ev in main["events"]] == ["llm_start", "tool_start", "tool_end", "llm_end"]
    assert main["events"][0]["event_index"] == 0
    assert main["events"][1]["tool_name"] == "sub_agent_tool"
    assert main["events"][0]["prompt_messages"] == [{"role": "user", "content": "查房间"}]
    assert "prompt" not in main["events"][0]
    sub = payload["groups"][1]
    assert sub["sub_id"] == 1
    assert sub["run_id"] == 0
    assert sub["parent_tool_call_id"] == "c1"
    assert sub["events"][1]["is_error"] is True
    assert "parent_tool_call_id" not in main


def test_prompt_messages_keep_last_user_when_system_is_long(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    system = "S" * 5000
    user = "UNIQUE_USER_QUERY_XYZ"
    payload = {
        "role": "main",
        "events": [
            {
                "type": "llm_start",
                "model": "qwen-plus",
                "timestamp": 1,
                "input": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
        ],
    }
    (otel / "trajectory.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    event = load_session_trajectory(otel)["groups"][0]["events"][0]
    messages = event["prompt_messages"]
    assert "prompt" not in event
    assert event["prompt_truncated"] is True
    assert [item["role"] for item in messages] == ["system", "user"]
    assert messages[0]["truncated"] is True
    assert messages[0]["content"].startswith("S")
    assert len(messages[0]["content"]) <= 1201
    assert user not in messages[0]["content"]
    assert messages[1]["content"] == user
    assert "truncated" not in messages[1]


def test_non_message_prompt_stays_a_clipped_string(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    (otel / "trajectory.json").write_text(
        """
        {
          "role": "main",
          "events": [
            {"type": "llm_start", "model": "qwen", "timestamp": 1, "input": "plain prompt"}
          ]
        }
        """,
        encoding="utf-8",
    )
    event = load_session_trajectory(otel)["groups"][0]["events"][0]
    assert event["prompt"] == "plain prompt"
    assert "prompt_messages" not in event


def test_prompt_messages_flatten_text_parts(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    (otel / "trajectory.json").write_text(
        json.dumps(
            {
                "role": "main",
                "events": [
                    {
                        "type": "llm_start",
                        "model": "qwen",
                        "timestamp": 1,
                        "input": [
                            {
                                "role": "user",
                                "content": [{"type": "text", "text": "查房间"}],
                            }
                        ],
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    event = load_session_trajectory(otel)["groups"][0]["events"][0]
    assert event["prompt_messages"] == [{"role": "user", "content": "查房间"}]


def test_prompt_budget_keeps_last_user_among_many_messages(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    history = [{"role": "assistant", "content": "H" * 1200} for _ in range(6)]
    payload = {
        "role": "main",
        "events": [
            {
                "type": "llm_start",
                "model": "qwen",
                "timestamp": 1,
                "input": [*history, {"role": "user", "content": "KEEP_ME"}],
            }
        ],
    }
    (otel / "trajectory.json").write_text(json.dumps(payload), encoding="utf-8")
    event = load_session_trajectory(otel)["groups"][0]["events"][0]
    messages = event["prompt_messages"]
    assert messages[-1]["content"] == "KEEP_ME"
    assert "truncated" not in messages[-1]
    assert event["prompt_truncated"] is True
    assert messages[0]["truncated"] is True
    assert len(messages[0]["content"]) < 1200


def test_load_trajectory_prompt_returns_full_system(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    system = "S" * 5000
    user = "UNIQUE_USER_QUERY_XYZ"
    payload = {
        "role": "main",
        "events": [
            {
                "type": "llm_start",
                "model": "qwen-plus",
                "timestamp": 1,
                "input": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            }
        ],
    }
    (otel / "trajectory.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    summary = load_session_trajectory(otel)["groups"][0]["events"][0]
    detail = load_trajectory_prompt(
        otel,
        file="trajectory.json",
        event_index=summary["event_index"],
        chunk_index=0,
    )
    assert detail is not None
    assert detail["truncated"] is False
    assert detail["prompt_messages"][0]["content"] == system
    assert detail["prompt_messages"][1]["content"] == user
    assert "truncated" not in detail["prompt_messages"][0]


def test_load_trajectory_prompt_rejects_path_escape(tmp_path: Path):
    otel = tmp_path / ".otel"
    otel.mkdir()
    (otel / "trajectory.json").write_text('{"role":"main","events":[]}', encoding="utf-8")
    assert load_trajectory_prompt(otel, file="../trajectory.json", event_index=0) is None
    assert load_trajectory_prompt(otel, file="secret.json", event_index=0) is None
