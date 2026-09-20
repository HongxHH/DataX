"""Tests for session JSON persistence of process fields."""

from shell.backend.session.store import (
    allocate_kernel_run_id,
    append_assistant_message,
    append_user_message,
    create_session,
    delete_session,
    get_session,
    list_sessions,
    resolve_chat_query,
    upsert_assistant_message,
)


def test_append_assistant_message_persists_process_fields(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    append_assistant_message(
        session["id"],
        "查询完成",
        sql="SELECT 1",
        thinking="why this sql",
        main_thinking="need count",
        plan_hint="委派查询",
        plan_prep=["正在规划…", "正在启动规划节点…"],
        stages=[{"stage": "generating", "label": "正在生成 SQL", "status": "done"}],
        logs=[{"message": "表结构感知完成", "level": "info"}],
        delegations=[
            {
                "tool_call_id": "c1",
                "sub_thinking": "x" * 3000,
                "logs": [{"message": str(i)} for i in range(60)],
            }
        ],
    )
    loaded = get_session(session["id"])
    assert loaded is not None
    msg = loaded["messages"][-1]
    assert msg["thinking"] == "why this sql"
    assert msg["main_thinking"] == "need count"
    assert msg["plan_hint"] == "委派查询"
    assert msg["plan_prep"] == ["正在规划…", "正在启动规划节点…"]
    assert msg["stages"][0]["stage"] == "generating"
    assert msg["logs"][0]["message"] == "表结构感知完成"
    assert len(msg["delegations"][0]["sub_thinking"]) == 2000
    assert msg["delegations"][0]["sub_thinking"].startswith("…")
    assert msg["delegations"][0]["sub_thinking"].endswith("x" * 10)
    assert len(msg["delegations"][0]["logs"]) == 50


def test_delete_session_removes_json(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    assert delete_session(session["id"]) is True
    assert get_session(session["id"]) is None
    assert delete_session(session["id"]) is False


def test_upsert_assistant_replaces_running_turn(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    append_user_message(session["id"], "画图")
    upsert_assistant_message(
        session["id"],
        "处理中…",
        status="running",
        turn_started_at=1000,
        plan_hint="委派 Plot",
        delegations=[{"tool_call_id": "p1", "label": "Landcheck Plot", "status": "running"}],
    )
    upsert_assistant_message(
        session["id"],
        "已完成",
        status="done",
        turn_started_at=1000,
        turn_ended_at=2500,
        plan_hint="委派 Plot",
        delegations=[{"tool_call_id": "p1", "label": "Landcheck Plot", "status": "done"}],
    )
    loaded = get_session(session["id"])
    assert loaded is not None
    assistants = [m for m in loaded["messages"] if m.get("role") == "assistant"]
    assert len(assistants) == 1
    assert assistants[0]["content"] == "已完成"
    assert assistants[0]["status"] == "done"
    assert assistants[0]["turn_ended_at"] == 2500
    assert assistants[0]["delegations"][0]["status"] == "done"


def test_ensure_session_does_not_leave_orphan_uuid(tmp_path, monkeypatch):
    from shell.backend.session.store import ensure_session

    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    ensure_session("fixed-session-id", title="定点会话")
    files = sorted(p.name for p in tmp_path.glob("*.json"))
    assert files == ["fixed-session-id.json"]
    loaded = get_session("fixed-session-id")
    assert loaded is not None
    assert loaded["title"] == "定点会话"


def test_resolve_chat_query_react_uses_raw_query(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    append_user_message(session["id"], "西湖项目有多少房间")
    append_assistant_message(session["id"], "共 12 间")
    follow_up = "那个项目按用途拆一下"
    assert resolve_chat_query("react", session["id"], follow_up) == follow_up
    nl2sql_query = resolve_chat_query("nl2sql", session["id"], follow_up)
    assert "以下是同一会话中的对话历史" in nl2sql_query
    assert follow_up in nl2sql_query


def test_append_assistant_persists_rewritten_query(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    append_assistant_message(session["id"], "查询完成", rewritten_query="西湖项目按用途统计房间数")
    loaded = get_session(session["id"])
    assert loaded is not None
    assert loaded["messages"][-1]["rewritten_query"] == "西湖项目按用途统计房间数"


def test_append_assistant_persists_context_usage_for_list(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    append_assistant_message(
        session["id"],
        "查询完成",
        context_usage={
            "used_input_tokens": 12400,
            "context_window": 131072,
            "compress_token_limit": 32768,
            "history": "restore",
            "parts": {"system": 40, "history": 30, "user": 10, "other": 20, "prompt": "secret"},
            "content": "secret",
        },
    )
    loaded = get_session(session["id"])
    assert loaded is not None
    usage = loaded["context_usage"]
    assert usage["used_input_tokens"] == 12400
    assert usage["history"] == "restore"
    assert usage["parts"] == {"system": 40, "history": 30, "user": 10, "other": 20}
    assert "content" not in usage
    assert "prompt" not in usage["parts"]
    assert loaded["messages"][-1]["context_usage"]["used_input_tokens"] == 12400
    listed = list_sessions()
    assert listed[0]["context_usage"]["used_input_tokens"] == 12400
    assert listed[0]["context_usage"]["context_window"] == 131072
    assert listed[0]["context_usage"]["history"] == "restore"
    append_assistant_message(
        session["id"],
        "子代理快照不应覆盖会话占用",
        context_usage={"used_input_tokens": 9, "history": "compressed", "compress_kind": "ir", "sub_id": 2},
    )
    loaded_after_sub = get_session(session["id"])
    assert loaded_after_sub is not None
    assert loaded_after_sub["context_usage"]["used_input_tokens"] == 12400
    assert "sub_id" not in (list_sessions()[0].get("context_usage") or {})


def test_append_assistant_persists_prompt_inventory_on_message_not_list(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    append_assistant_message(
        session["id"],
        "查询完成",
        prompt_inventory={
            "ir_summary_count": 1,
            "skill_count": 2,
            "has_plan": True,
            "workers": [{"sub_id": 11, "artifact_count": 1, "has_error": False, "last_query": "secret"}],
            "ir_summaries": [{"tool": "sub_agent_tool", "nodes": ["Table"], "path": "/tmp/x"}],
            "content": "secret prompt",
        },
    )
    loaded = get_session(session["id"])
    assert loaded is not None
    inventory = loaded["messages"][-1]["prompt_inventory"]
    assert inventory["ir_summary_count"] == 1
    assert inventory["workers"] == [{"sub_id": 11, "artifact_count": 1, "has_error": False}]
    assert inventory["ir_summaries"] == [{"tool": "sub_agent_tool", "nodes": ["Table"]}]
    assert "content" not in inventory
    assert "secret" not in str(inventory)
    assert "prompt_inventory" not in list_sessions()[0]
    append_assistant_message(
        session["id"],
        "子代理清单不应写入主消息",
        prompt_inventory={"ir_summary_count": 0, "workers": [], "sub_id": 8},
    )
    loaded_after_sub = get_session(session["id"])
    assert loaded_after_sub is not None
    assert "prompt_inventory" not in loaded_after_sub["messages"][-1]


def test_append_assistant_keeps_thinking_tail_and_prep_checkpoints(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    tail = "最新结论：YEAR 被拒后正在改写"
    append_assistant_message(
        session["id"],
        "查询完成",
        main_thinking="H" * 80 + "x" * 2000 + tail,
        thinking="W" * 80 + "y" * 8000 + "工作台尾部",
        plan_prep=[
            "正在规划…",
            "跨会话记忆：未命中",
            *[f"正在等待规划模型返回…{index}" for index in range(22)],
            "问句已改写为 西湖项目房间数",
        ],
    )
    loaded = get_session(session["id"])
    assert loaded is not None
    msg = loaded["messages"][-1]
    assert msg["main_thinking"].startswith("…")
    assert msg["main_thinking"].endswith(tail)
    assert len(msg["main_thinking"]) == 2000
    assert "H" not in msg["main_thinking"]
    assert msg["thinking"].endswith("工作台尾部")
    assert msg["thinking"].startswith("…")
    assert "跨会话记忆：未命中" in msg["plan_prep"]
    assert "问句已改写为 西湖项目房间数" in msg["plan_prep"]
    assert "正在规划…" not in msg["plan_prep"]
    assert len(msg["plan_prep"]) == 20


def test_allocate_kernel_run_id_increments_per_turn(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    sid = session["id"]
    assert allocate_kernel_run_id(sid) == 0
    assert allocate_kernel_run_id(sid) == 1
    assert allocate_kernel_run_id(sid) == 2
    loaded = get_session(sid)
    assert loaded is not None
    assert loaded["next_kernel_run_id"] == 3


def test_allocate_kernel_run_id_skips_legacy_user_turns(tmp_path, monkeypatch):
    monkeypatch.setattr("shell.backend.session.store.SESSIONS_DIR", tmp_path)
    session = create_session()
    sid = session["id"]
    append_user_message(sid, "你好")
    append_assistant_message(sid, "我是助手")
    append_user_message(sid, "查询2024年有多少个项目")
    assert allocate_kernel_run_id(sid) == 2
    assert allocate_kernel_run_id(sid) == 3
