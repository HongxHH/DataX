"""Tests for SSE process snapshot persistence helpers."""

from shell.backend.protocol.events import ShellEventType
from shell.backend.session.process_snapshot import ProcessSnapshot


def test_snapshot_splits_main_and_workbench_thinking():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.THINK,
        {"scope": "main", "phase": "delta", "content": "规划中"},
    )
    snap.ingest(
        ShellEventType.THINK,
        {"scope": "subagent", "phase": "delta", "content": "先看表"},
    )
    snap.ingest(
        ShellEventType.THINK,
        {"scope": "subagent", "tool_call_id": "c1", "phase": "delta", "content": "委派思考"},
    )
    kwargs = snap.persist_kwargs()
    assert kwargs["main_thinking"] == "规划中"
    assert kwargs["thinking"] == "先看表"
    assert "委派思考" not in kwargs["thinking"]


def test_snapshot_records_plan_prep_from_planning_stage():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.STAGE,
        {"stage": "planning", "hint": "正在规划…", "label": "正在规划…"},
    )
    snap.ingest(
        ShellEventType.STAGE,
        {"stage": "planning", "hint": "正在解析问题中的指代（可能调用模型）…"},
    )
    snap.ingest(
        ShellEventType.STAGE,
        {"stage": "generating", "hint": "正在生成 SQL"},
    )
    kwargs = snap.persist_kwargs()
    assert kwargs["plan_prep"] == [
        "正在规划…",
        "正在解析问题中的指代（可能调用模型）…",
    ]
    stages = kwargs["stages"]
    assert stages[-1]["stage"] == "generating"
    assert all(s["status"] == "done" for s in stages)


def test_snapshot_plan_and_logs():
    snap = ProcessSnapshot()
    snap.ingest(ShellEventType.PLAN, {"hint": "将委派 NL2SQL", "tools": [{"name": "sub_agent_tool"}]})
    snap.ingest(ShellEventType.LOG, {"message": "表结构感知完成", "level": "info"})
    snap.ingest(ShellEventType.LOG, {"message": "ignored", "tool_call_id": "x"})
    snap.ingest(ShellEventType.ARTIFACT, {"kind": "sql", "sql": "SELECT 1"})
    kwargs = snap.persist_kwargs()
    assert kwargs["plan_hint"] == "将委派 NL2SQL"
    assert kwargs["plan_tools"] == [{"name": "sub_agent_tool"}]
    assert kwargs["logs"] == [{"message": "表结构感知完成", "level": "info"}]
    assert kwargs["sql"] == "SELECT 1"


def test_snapshot_records_rewritten_query():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.CONTEXT,
        {"raw": "那个项目", "rewritten": "西湖项目房间数"},
    )
    snap.ingest(ShellEventType.CONTEXT, {"raw": "西湖项目房间数", "rewritten": "西湖项目房间数"})
    kwargs = snap.persist_kwargs()
    assert kwargs["rewritten_query"] == "西湖项目房间数"
    assert kwargs["plan_prep"] == ["问句已改写为 西湖项目房间数"]


def test_snapshot_persist_kwargs_can_keep_active_stages():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.STAGE,
        {"stage": "planning", "hint": "正在规划…"},
    )
    running = snap.persist_kwargs(finalize_stages=False)
    assert running["stages"][0]["status"] == "active"
    done = snap.persist_kwargs(finalize_stages=True)
    assert done["stages"][0]["status"] == "done"


def test_snapshot_records_compact_spans():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.SPAN,
        {
            "kind": "llm",
            "phase": "end",
            "name": "qwen-plus",
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "duration_ms": 1500,
            "input": "secret",
        },
    )
    spans = snap.persist_kwargs()["otel_spans"]
    assert spans[0]["name"] == "qwen-plus"
    assert spans[0]["usage"]["input_tokens"] == 10
    assert "input" not in spans[0]
    assert "secret" not in str(spans)


def test_snapshot_records_main_context_usage_and_ignores_sub():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.CONTEXT_USAGE,
        {
            "used_input_tokens": 100,
            "context_window": 131072,
            "history": "restore",
            "content": "prompt",
        },
    )
    snap.ingest(
        ShellEventType.CONTEXT_USAGE,
        {
            "used_input_tokens": 50,
            "history": "compressed",
            "compress_kind": "ir",
            "sub_id": 2,
        },
    )
    snap.ingest(
        ShellEventType.CONTEXT_USAGE,
        {
            "used_input_tokens": 9000,
            "history": "compressed",
            "compress_kind": "fold",
            "compress_token_limit": 32768,
        },
    )
    kwargs = snap.persist_kwargs()
    usage = kwargs["context_usage"]
    assert usage["used_input_tokens"] == 9000
    assert usage["history"] == "compressed"
    assert usage["compress_kind"] == "fold"
    assert "content" not in usage
    assert "sub_id" not in usage


def test_snapshot_records_main_and_sub_prompt_inventories():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.PROMPT_INVENTORY,
        {
            "ir_summary_count": 1,
            "workers": [{"sub_id": 11, "artifact_count": 2, "has_error": False, "last_query": "secret"}],
            "ir_summaries": [{"tool": "sub_agent_tool", "nodes": ["Table"], "path": "/tmp/x"}],
            "content": "prompt",
        },
    )
    snap.ingest(
        ShellEventType.PROMPT_INVENTORY,
        {"ir_summary_count": 3, "workers": [], "sub_id": 2, "ir_summaries": [{"tool": "execute_sql", "path": "/tmp/ir"}]},
    )
    snap.ingest(
        ShellEventType.PROMPT_INVENTORY,
        {"ir_summary_count": 0, "workers": [], "sub_id": 2},
    )
    snap.ingest(
        ShellEventType.PROMPT_INVENTORY,
        {"ir_summary_count": 2, "skill_count": 3, "has_plan": True, "workers": []},
    )
    kwargs = snap.persist_kwargs()
    inventory = kwargs["prompt_inventory"]
    assert inventory["ir_summary_count"] == 2
    assert inventory["skill_count"] == 3
    assert inventory["has_plan"] is True
    assert inventory["workers"] == []
    assert "content" not in inventory
    assert "sub_id" not in inventory
    assert "secret" not in str(inventory)
    subs = kwargs["sub_prompt_inventories"]
    assert subs["2"]["ir_summary_count"] == 0
    assert subs["2"]["sub_id"] == 2
    assert "path" not in str(subs)


def test_snapshot_keeps_thinking_tail_and_prep_checkpoints():
    snap = ProcessSnapshot()
    snap.ingest(
        ShellEventType.THINK,
        {"scope": "main", "phase": "delta", "content": "H" * 80 + "x" * 2000},
    )
    snap.ingest(
        ShellEventType.THINK,
        {"scope": "main", "phase": "delta", "content": "最新结论：YEAR 被拒后正在改写"},
    )
    snap.ingest(ShellEventType.STAGE, {"stage": "planning", "hint": "正在规划…"})
    snap.ingest(
        ShellEventType.STAGE,
        {"stage": "planning", "hint": "跨会话记忆：未命中"},
    )
    for index in range(22):
        snap.ingest(
            ShellEventType.STAGE,
            {"stage": "planning", "hint": f"正在等待规划模型返回…{index}"},
        )
    snap.ingest(
        ShellEventType.CONTEXT,
        {"raw": "那个项目", "rewritten": "西湖项目房间数"},
    )
    kwargs = snap.persist_kwargs()
    assert kwargs["main_thinking"].startswith("…")
    assert kwargs["main_thinking"].endswith("最新结论：YEAR 被拒后正在改写")
    assert "H" not in kwargs["main_thinking"]
    assert "跨会话记忆：未命中" in kwargs["plan_prep"]
    assert "问句已改写为 西湖项目房间数" in kwargs["plan_prep"]
    assert "正在规划…" not in kwargs["plan_prep"]
    assert len(kwargs["plan_prep"]) == 20
