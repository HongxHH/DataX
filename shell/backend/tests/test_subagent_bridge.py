"""Tests for sub-agent SSE bridge helpers."""

from shell.backend.adapters.subagent_bridge import (
    DelegationAccumulator,
    agent_label_from_config_path,
    enrich_worker_tool_event,
    extract_sql_from_markdown,
    iter_subagent_progress_events,
    iter_subagent_state_events,
    tool_display_name,
)


def test_iter_subagent_progress_events_react_tool_hint():
    events = iter_subagent_progress_events(
        "↳ 正在调用工具\n",
        tool_call_id="plot-1",
        tool_name="sub_agent_tool",
    )
    stage = next(e for e in events if e["event"] == "stage")
    assert stage["data"]["hint"] == "正在调用工具"
    assert stage["data"]["tool_call_id"] == "plot-1"


def test_extract_sql_from_markdown():
    text = "结果:\n```sql\nSELECT 1\n```"
    assert extract_sql_from_markdown(text) == "SELECT 1"


def test_iter_subagent_progress_events_stage():
    content = "↳ Perceptor\n↳ Generator: sample\n"
    events = iter_subagent_progress_events(
        content,
        tool_call_id="call-1",
        tool_name="sub_agent_tool",
    )
    names = [e["event"] for e in events]
    assert "stage" in names
    assert "log" in names
    stage = next(e for e in events if e["event"] == "stage")
    assert stage["data"]["tool_call_id"] == "call-1"
    assert stage["data"]["scope"] == "subagent"


def test_agent_label_from_config_path():
    assert agent_label_from_config_path("E:/x/landcheck_document_recall.yaml") == "Document Recall"
    assert agent_label_from_config_path("/tmp/landcheck_nl2sql.yaml") == "Landcheck NL2SQL"
    assert agent_label_from_config_path("/tmp/landcheck_plot.yaml") == "Landcheck Plot"
    assert agent_label_from_config_path("/tmp/landcheck_report.yaml") == "Landcheck Report"


def test_iter_subagent_state_events_excerpts():
    events = iter_subagent_state_events(
        {
            "excerpts": [
                {
                    "source_path": "schema/landcheck_docs/field_glossary.md",
                    "start_line": 10,
                    "end_line": 14,
                    "excerpt": "建筑面积用 building_area",
                }
            ],
            "recall_path": "/ws/document_recall/default/recall_result.json",
        },
        tool_call_id="call-r",
        tool_name="sub_agent_tool",
        config_path="/repo/landcheck_document_recall.yaml",
    )
    kinds = [e["data"].get("kind") for e in events]
    assert "excerpts" in kinds
    assert events[0]["data"]["agent_label"] == "Document Recall"


def test_iter_subagent_state_events():
    events = iter_subagent_state_events(
        {
            "sql": "SELECT 2",
            "columns": ["a"],
            "rows_preview": [[1], [2]],
            "rows": [[1], [2], [3]],
            "row_count": 3,
            "preview_row_count": 2,
        },
        tool_call_id="call-2",
        tool_name="sub_agent_tool",
    )
    kinds = [e["data"].get("kind") for e in events]
    assert "sql" in kinds
    assert "table" in kinds
    table = next(e for e in events if e["data"].get("kind") == "table")
    assert table["data"]["row_count"] == 3
    assert table["data"]["preview_row_count"] == 2


def test_iter_subagent_state_events_infers_row_count_from_rows():
    events = iter_subagent_state_events(
        {
            "columns": ["name"],
            "rows_preview": [["a"]],
            "rows": [["a"], ["b"]],
        },
        tool_call_id="call-3",
        tool_name="sub_agent_tool",
    )
    table = next(e for e in events if e["data"].get("kind") == "table")
    assert table["data"]["row_count"] == 2
    assert table["data"]["preview_row_count"] == 1


def test_delegation_accumulator_tracks_tool_and_artifact():
    acc = DelegationAccumulator()
    acc.on_tool(
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "status": "running",
        }
    )
    acc.on_artifact(
        {
            "tool_call_id": "tc1",
            "kind": "sql",
            "sql": "SELECT 3",
        }
    )
    acc.on_artifact(
        {
            "tool_call_id": "tc1",
            "kind": "table",
            "columns": ["a"],
            "rows_preview": [[1]],
            "row_count": 10,
            "preview_row_count": 1,
        }
    )
    blocks = acc.finalize()
    assert len(blocks) == 1
    assert blocks[0]["sql"] == "SELECT 3"
    assert blocks[0]["row_count"] == 10
    assert blocks[0]["preview_row_count"] == 1
    assert blocks[0]["label"] == tool_display_name("sub_agent_tool")
    assert blocks[0]["status"] == "done"


def test_iter_subagent_progress_events_think_and_stage():
    content = (
        "↳ Perceptor\n"
        "↳ DA_THINK\tperceptor\t先看有哪些表\n"
        "↳ Generator\n"
        "↳ DA_DRAFT\tgenerator\tSELECT 1\n"
    )
    events = iter_subagent_progress_events(
        content,
        tool_call_id="call-1",
        tool_name="sub_agent_tool",
    )
    thinks = [e for e in events if e["event"] == "think"]
    stages = [e for e in events if e["event"] == "stage"]
    assert stages
    assert thinks
    assert thinks[0]["data"]["phase"] == "start"
    assert thinks[0]["data"]["scope"] == "subagent"
    assert thinks[0]["data"]["tool_call_id"] == "call-1"
    deltas = [e for e in thinks if e["data"]["phase"] == "delta"]
    assert deltas[0]["data"]["content"] == "先看有哪些表"
    assert deltas[0]["data"]["kind"] == "reasoning"
    draft = next(e for e in deltas if e["data"].get("kind") == "draft")
    assert draft["data"]["content"] == "SELECT 1"
    assert draft["data"]["node"] == "generator"


def test_parse_da_progress_line_decodes_newlines():
    from shell.backend.adapters.subagent_bridge import parse_da_progress_line

    parsed = parse_da_progress_line("DA_THINK\tgenerator\tline1\\nline2")
    assert parsed is not None
    kind, node, delta = parsed
    assert kind == "reasoning"
    assert node == "generator"
    assert delta == "line1\nline2"


def test_delegation_accumulator_ignores_local_tools():
    acc = DelegationAccumulator()
    acc.ingest_shell_event(
        "tool",
        {
            "tool_call_id": "wf1",
            "tool_name": "write_file",
            "status": "success",
        },
    )
    acc.ingest_shell_event(
        "tool",
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "status": "success",
        },
    )
    blocks = acc.finalize()
    assert [block["tool_call_id"] for block in blocks] == ["tc1"]


def test_delegation_accumulator_snapshot_keeps_running():
    acc = DelegationAccumulator()
    acc.on_tool(
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "status": "start",
        }
    )
    acc.on_stage(
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "stage": "generating",
            "hint": "正在生成 SQL",
        }
    )
    live = acc.snapshot()
    assert live[0]["status"] == "running"
    assert live[0]["started_at"]
    assert live[0]["stages"][0]["status"] == "active"
    live[0]["label"] = "mutated"
    assert acc.snapshot()[0]["label"] != "mutated"
    done = acc.finalize()
    assert done[0]["status"] == "done"
    assert done[0]["ended_at"]


def test_delegation_accumulator_finalize_interrupted_marks_error():
    acc = DelegationAccumulator()
    acc.on_tool(
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "status": "running",
        }
    )
    acc.on_stage(
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "stage": "validating",
            "hint": "正在校验 SQL",
        }
    )
    started = acc.snapshot()[0]["started_at"]
    acc._blocks["tc1"]["started_at"] = started - 9 * 60_000
    blocks = acc.finalize(interrupted=True)
    assert blocks[0]["status"] == "error"
    assert blocks[0]["error"] == "已运行 9 分钟后连接中断"
    assert blocks[0]["ended_at"]
    assert blocks[0]["stages"][0]["status"] == "done"


def test_delegation_accumulator_finalize_interrupted_keeps_existing_error():
    acc = DelegationAccumulator()
    acc.on_tool(
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "status": "error",
            "error": "生成过程被中断",
        }
    )
    blocks = acc.finalize(interrupted=True)
    assert blocks[0]["status"] == "error"
    assert "被中断" in blocks[0]["error"]


def test_delegation_accumulator_captures_sub_thinking():
    acc = DelegationAccumulator()
    acc.ingest_shell_event(
        "think",
        {
            "tool_call_id": "tc1",
            "tool_name": "sub_agent_tool",
            "phase": "start",
            "content": "",
        },
    )
    acc.ingest_shell_event(
        "think",
        {
            "tool_call_id": "tc1",
            "phase": "delta",
            "content": "先过滤项目",
        },
    )
    blocks = acc.finalize()
    assert blocks[0]["sub_thinking"] == "先过滤项目"


def test_enrich_worker_tool_event_maps_busy_and_sub_id():
    extra = enrich_worker_tool_event(
        {
            "summary": "subagent 3 is already running; create a new subagent instead of reusing it",
            "tool_args": {"sub_id": 3, "query": "再拆一次"},
        }
    )
    assert extra["sub_id"] == 3
    assert "resumed" not in extra
    assert extra["worker_busy"] is True
    assert extra["status"] == "error"
    assert "换一个新的 worker" in extra["error"]


def test_enrich_worker_tool_event_passes_through_kernel_resumed():
    extra = enrich_worker_tool_event(
        {"sub_id": 9, "resumed": False, "status": "success"},
        {"sub_id": 9, "query": "q"},
    )
    assert extra["sub_id"] == 9
    assert extra["resumed"] is False


def test_accumulator_records_worker_reuse():
    acc = DelegationAccumulator()
    acc.ingest_shell_event(
        "tool",
        {
            "tool_call_id": "c1",
            "tool_name": "sub_agent_tool",
            "status": "success",
            "sub_id": 2,
            "resumed": True,
        },
    )
    blocks = acc.snapshot()
    assert blocks[0]["sub_id"] == 2
    assert blocks[0]["resumed"] is True


def test_accumulator_records_llm_span_tokens():
    acc = DelegationAccumulator()
    acc.ingest_shell_event(
        "span",
        {
            "kind": "llm",
            "phase": "start",
            "name": "qwen-plus",
            "parent_tool_call_id": "c1",
            "sub_id": 3,
        },
    )
    acc.ingest_shell_event(
        "span",
        {
            "kind": "llm",
            "phase": "end",
            "name": "qwen-plus",
            "parent_tool_call_id": "c1",
            "duration_ms": 2400,
            "usage": {"input_tokens": 100, "output_tokens": 20},
        },
    )
    block = acc.snapshot()[0]
    assert block["tool_call_id"] == "c1"
    assert block["sub_id"] == 3
    assert block["llm_running"] is False
    assert block["last_llm_ms"] == 2400
    assert block["input_tokens"] == 100
    assert block["output_tokens"] == 20
