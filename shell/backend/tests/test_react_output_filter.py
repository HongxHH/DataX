"""Tests for react adapter output_msg filtering and main-agent think/plan mapping."""

from dataagent.utils.constants import DEFAULT_USER_ID

from shell.backend.adapters.main_agent_bridge import (
    MAIN_AGENT_CUSTOM_TYPES,
    MainAgentStreamMapper,
    _should_stream_output_msg,
    format_tool_plan_hint,
    should_emit_plan,
)
from shell.backend.adapters.react import coerce_kernel_run_id, flex_turn_initial_state


def test_should_not_stream_tool_boilerplate():
    assert not _should_stream_output_msg("**sub_agent_tool 执行完成**")
    assert not _should_stream_output_msg(
        '**工具执行结果**\n```json\n{"ok": true}\n```'
    )
    assert not _should_stream_output_msg("**正在调用以下工具:** - **sub_agent_tool**")
    assert not _should_stream_output_msg("**正在调用以下工具:**\n\n- **sub_agent_tool**\n\n")


def test_should_stream_normal_answer():
    assert _should_stream_output_msg("当前一共有 42 个项目。")


def _events_of(items: list[dict], name: str) -> list[dict]:
    return [item for item in items if item.get("event") == name]


def test_reasoning_only_emits_think_not_token():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "content": "",
            "reasoning_content": "需要查库确认项目数量。",
        }
    )
    assert _events_of(events, "think")
    assert not _events_of(events, "token")
    think = _events_of(events, "think")
    assert think[0]["data"]["phase"] == "start"
    assert think[1]["data"]["phase"] == "delta"
    assert think[1]["data"]["content"] == "需要查库确认项目数量。"
    assert think[1]["data"]["scope"] == "main"


def test_filtered_tool_calls_emit_plan_not_token():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "content": "**正在调用以下工具:**\n\n- **sub_agent_tool**\n\n",
            "tool_calls": [
                {
                    "name": "sub_agent_tool",
                    "args": {"query": "当前有多少个项目？"},
                }
            ],
        }
    )
    assert not _events_of(events, "token")
    plans = _events_of(events, "plan")
    assert len(plans) == 1
    assert plans[0]["data"]["tools"][0]["name"] == "sub_agent_tool"
    assert "将委派 子 Agent" in plans[0]["data"]["hint"]
    assert "当前有多少个项目？" in plans[0]["data"]["hint"]


def test_plan_emits_think_end_so_next_round_can_restart():
    mapper = MainAgentStreamMapper()
    first = mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "reasoning_content": "需要查库确认项目数量。",
            "content": "**正在调用以下工具:**\n\n- **sub_agent_tool**\n\n",
            "tool_calls": [
                {
                    "name": "sub_agent_tool",
                    "args": {"query": "当前有多少个项目？"},
                }
            ],
        }
    )
    think = _events_of(first, "think")
    assert think[-1]["data"]["phase"] == "end"
    second = mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "reasoning_content": "经查询共 59 个。",
            "content": "当前共 59 个未删除的有效项目。",
        }
    )
    think2 = _events_of(second, "think")
    assert think2[0]["data"]["phase"] == "start"
    assert think2[1]["data"]["phase"] == "delta"
    assert think2[1]["data"]["content"] == "经查询共 59 个。"


def test_break_emits_think_end():
    mapper = MainAgentStreamMapper()
    mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "reasoning_content": "先规划。",
        }
    )
    events = mapper.iter_events({"type": "break", "node_name": "planner"})
    think = _events_of(events, "think")
    assert len(think) == 1
    assert think[0]["data"]["phase"] == "end"


def test_break_without_thinking_is_noop():
    mapper = MainAgentStreamMapper()
    assert mapper.iter_events({"type": "break"}) == []


def test_plan_hint_uses_config_path_label():
    tools, hint = format_tool_plan_hint(
        [
            {
                "name": "sub_agent_tool",
                "args": {
                    "query": "项目状态字段口径",
                    "config_path": "/repo/landcheck_document_recall.yaml",
                },
            }
        ]
    )
    assert tools[0]["label"] == "Document Recall"
    assert "Document Recall" in hint


def test_hidden_tools_do_not_emit_plan():
    assert not should_emit_plan([{"name": "glob", "args": {"pattern": "*"}}])
    assert not should_emit_plan([{"name": "bash", "args": {"command": "ls"}}])
    assert not should_emit_plan([{"name": "write_file", "args": {"path": "a.html"}}])
    assert not should_emit_plan([{"name": "create_plan", "args": {"introduction": "x"}}])
    assert not should_emit_plan([{"name": "request_human_feedback", "args": {"reason": "先确认"}}])
    tools, hint = format_tool_plan_hint(
        [
            {"name": "glob", "args": {"pattern": "*"}},
            {"name": "write_file", "args": {"path": "a.html"}},
            {"name": "sub_agent_tool", "args": {"query": "列出所有表"}},
        ]
    )
    assert [t["name"] for t in tools] == ["sub_agent_tool"]
    assert "glob" not in hint
    assert "write_file" not in hint


def test_planner_stream_reasoning_then_content():
    mapper = MainAgentStreamMapper()
    start = mapper.iter_events({"type": "planner_stream", "phase": "start", "node_name": "planner"})
    assert start[0]["data"]["phase"] == "start"
    deltas = mapper.iter_events(
        {
            "type": "planner_stream",
            "phase": "reasoning",
            "node_name": "planner",
            "content": "思考片段",
        }
    )
    assert _events_of(deltas, "think")[0]["data"]["phase"] == "delta"
    content_events = mapper.iter_events(
        {
            "type": "planner_stream",
            "phase": "content",
            "node_name": "planner",
            "content": "最终结论",
        }
    )
    assert _events_of(content_events, "think")[0]["data"]["phase"] == "end"
    assert _events_of(content_events, "token")[0]["data"]["content"] == "最终结论"


def test_progress_hint_maps_to_main_stage():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "progress_hint",
            "node_name": "planner",
            "hint": "正在解析问题中的指代（可能调用模型）…",
            "stage": "planning",
        }
    )
    stages = _events_of(events, "stage")
    assert len(stages) == 1
    assert stages[0]["data"]["hint"] == "正在解析问题中的指代（可能调用模型）…"
    assert stages[0]["data"]["scope"] == "main"
    assert stages[0]["data"]["node"] == "planner"
    assert "progress_hint" in MAIN_AGENT_CUSTOM_TYPES


def test_progress_hint_empty_is_noop():
    mapper = MainAgentStreamMapper()
    assert mapper.iter_events({"type": "progress_hint", "hint": "  "}) == []


def test_context_rewrite_maps_to_context_event():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "context_rewrite",
            "raw_user_query": "那个项目的房间数",
            "user_query": "西湖项目的房间数",
        }
    )
    contexts = _events_of(events, "context")
    assert len(contexts) == 1
    assert contexts[0]["data"]["raw"] == "那个项目的房间数"
    assert contexts[0]["data"]["rewritten"] == "西湖项目的房间数"
    assert "context_rewrite" in MAIN_AGENT_CUSTOM_TYPES


def test_context_usage_maps_and_strips_prompt():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "context_usage",
            "used_input_tokens": 12400,
            "context_window": 131072,
            "compress_token_limit": 32768,
            "history": "restore",
            "content": "secret prompt",
            "messages": ["do not copy"],
        }
    )
    usages = _events_of(events, "context_usage")
    assert len(usages) == 1
    data = usages[0]["data"]
    assert data["used_input_tokens"] == 12400
    assert data["context_window"] == 131072
    assert data["history"] == "restore"
    assert "content" not in data
    assert "messages" not in data
    assert "secret prompt" not in str(data)
    assert "context_usage" in MAIN_AGENT_CUSTOM_TYPES


def test_context_usage_keeps_parts_and_drops_unknown_part_keys():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "context_usage",
            "used_input_tokens": 100,
            "history": "restore",
            "parts": {"system": 40, "history": 30, "user": 10, "other": 20, "prompt": "secret"},
        }
    )
    data = _events_of(events, "context_usage")[0]["data"]
    assert data["parts"] == {"system": 40, "history": 30, "user": 10, "other": 20}
    assert "prompt" not in data["parts"]
    assert "secret" not in str(data)


def test_context_usage_invalid_or_sub_is_still_forwarded_when_valid():
    mapper = MainAgentStreamMapper()
    assert mapper.iter_events({"type": "context_usage", "history": "restore"}) == []
    events = mapper.iter_events(
        {
            "type": "context_usage",
            "used_input_tokens": 80,
            "history": "compressed",
            "compress_kind": "fold",
            "sub_id": 3,
        }
    )
    usages = _events_of(events, "context_usage")
    assert usages[0]["data"]["sub_id"] == 3
    assert usages[0]["data"]["compress_kind"] == "fold"


def test_prompt_inventory_maps_and_strips_prompt_text():
    mapper = MainAgentStreamMapper()
    events = mapper.iter_events(
        {
            "type": "prompt_inventory",
            "ir_summary_count": 1,
            "skill_count": 2,
            "has_plan": True,
            "has_memory": True,
            "ir_unpacked": False,
            "recall": "hit",
            "workers": [
                {
                    "sub_id": 11,
                    "artifact_count": 2,
                    "has_error": False,
                    "last_query": "secret query",
                }
            ],
            "ir_summaries": [
                {
                    "tool": "sub_agent_tool",
                    "nodes": ["Table", "File", "../etc/passwd"],
                    "path": "/tmp/secret.csv",
                }
            ],
            "content": "secret prompt",
            "last_answer": "secret answer",
        }
    )
    items = _events_of(events, "prompt_inventory")
    assert len(items) == 1
    data = items[0]["data"]
    assert data["ir_summary_count"] == 1
    assert data["workers"] == [{"sub_id": 11, "artifact_count": 2, "has_error": False}]
    assert data["ir_summaries"] == [{"tool": "sub_agent_tool", "nodes": ["Table", "File"]}]
    assert data["skill_count"] == 2
    assert data["has_plan"] is True
    assert data["has_memory"] is True
    assert "ir_unpacked" not in data
    assert data["recall"] == "hit"
    assert "content" not in data
    assert "last_query" not in str(data)
    assert "secret" not in str(data)
    assert "prompt_inventory" in MAIN_AGENT_CUSTOM_TYPES


def test_prompt_inventory_invalid_or_sub_is_still_forwarded_when_valid():
    mapper = MainAgentStreamMapper()
    assert mapper.iter_events({"type": "prompt_inventory"}) == []
    events = mapper.iter_events(
        {
            "type": "prompt_inventory",
            "ir_summary_count": 0,
            "workers": [],
            "sub_id": 4,
        }
    )
    items = _events_of(events, "prompt_inventory")
    assert items[0]["data"]["sub_id"] == 4
    assert items[0]["data"]["workers"] == []
    assert items[0]["data"]["ir_summary_count"] == 0


def test_context_rewrite_same_query_is_noop():
    mapper = MainAgentStreamMapper()
    assert (
        mapper.iter_events(
            {
                "type": "context_rewrite",
                "raw_user_query": "列出所有项目",
                "user_query": "列出所有项目",
            }
        )
        == []
    )


def test_cross_session_recall_maps_to_stage_hint():
    mapper = MainAgentStreamMapper()
    hit = mapper.iter_events(
        {
            "type": "cross_session_recall",
            "status": "hit",
            "hit_count": 2,
            "preview": "西湖项目 2025 新建",
        }
    )
    stages = _events_of(hit, "stage")
    assert len(stages) == 1
    assert stages[0]["data"]["hint"] == "跨会话记忆：命中 2 段 · 西湖项目 2025 新建"
    assert "cross_session_recall" in MAIN_AGENT_CUSTOM_TYPES

    empty = mapper.iter_events({"type": "cross_session_recall", "status": "empty"})
    assert _events_of(empty, "stage")[0]["data"]["hint"] == "跨会话记忆：未命中"

    skipped = mapper.iter_events({"type": "cross_session_recall", "status": "disabled"})
    assert _events_of(skipped, "stage")[0]["data"]["hint"] == "跨会话记忆：已跳过"


def test_cross_session_recall_unknown_status_is_noop():
    mapper = MainAgentStreamMapper()
    assert mapper.iter_events({"type": "cross_session_recall", "status": "nope"}) == []


def test_initial_stage_is_planning():
    mapper = MainAgentStreamMapper()
    event = mapper.initial_stage_event()
    assert event["event"] == "stage"
    assert event["data"]["hint"] == "正在规划…"
    assert event["data"]["scope"] == "main"


def test_output_msg_content_ends_thinking_then_token():
    mapper = MainAgentStreamMapper()
    mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "reasoning_content": "先想后答。",
        }
    )
    events = mapper.iter_events(
        {
            "type": "output_msg",
            "node_name": "planner",
            "content": "一共有 59 个项目。",
        }
    )
    phases = [e["data"]["phase"] for e in _events_of(events, "think")]
    assert phases == ["end"]
    tokens = _events_of(events, "token")
    assert len(tokens) == 1
    assert tokens[0]["data"]["content"] == "一共有 59 个项目。"


def test_second_thinking_round_emits_start_again():
    mapper = MainAgentStreamMapper()
    mapper.iter_events({"type": "output_msg", "reasoning_content": "第一轮"})
    mapper.iter_events({"type": "break"})
    events = mapper.iter_events({"type": "output_msg", "reasoning_content": "第二轮"})
    think = _events_of(events, "think")
    assert think[0]["data"]["phase"] == "start"
    assert think[1]["data"]["content"] == "第二轮"


def test_node_update_stage_mapping():
    mapper = MainAgentStreamMapper()
    planner = mapper.node_update_stage("planner")
    assert planner is not None
    assert planner["data"]["hint"] == "正在规划…"
    executor = mapper.node_update_stage("executor")
    assert executor is not None
    assert executor["data"]["hint"] == "正在执行工具…"
    assert mapper.node_update_stage("unknown_node") is None


def test_flex_turn_initial_state_carries_run_id():
    state = flex_turn_initial_state("查询2024年有多少个项目", "sess-1", 2)
    assert state["run_id"] == 2
    assert state["session_id"] == "sess-1"
    assert state["user_query"] == "查询2024年有多少个项目"
    assert state["raw_user_query"] == "查询2024年有多少个项目"
    assert state["user_id"] == DEFAULT_USER_ID


def test_coerce_kernel_run_id_rejects_invalid():
    assert coerce_kernel_run_id(None) == 0
    assert coerce_kernel_run_id(-1) == 0
    assert coerce_kernel_run_id("3") == 3
    assert coerce_kernel_run_id("nope") == 0


def test_sse_encode_appends_flush_comment():
    from shell.backend.protocol.events import SSE_FLUSH, SSE_PADDING, sse_encode

    encoded = sse_encode("think", {"content": "用户", "phase": "delta"})
    assert encoded.startswith("event: think\n")
    assert encoded.endswith(SSE_FLUSH)
    assert SSE_PADDING.startswith(":")
    assert len(SSE_PADDING) > 8000
