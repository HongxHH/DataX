from shell.backend.session.live_span import append_live_span, normalize_live_span


def test_normalize_live_span_strips_prompt_and_rewrites_ids():
    span = normalize_live_span(
        {
            "kind": "tool",
            "phase": "end",
            "name": "execute_sql",
            "tool_call_id": "inner",
            "parent_tool_call_id": "parent",
            "input": "SELECT secret",
            "content": "nope",
            "duration_ms": 12,
            "failed": True,
        }
    )
    assert span is not None
    assert span["tool_call_id"] == "parent"
    assert span["inner_tool_call_id"] == "inner"
    assert span["failed"] is True
    assert "input" not in span
    assert "content" not in span


def test_normalize_rejects_unknown_kind():
    assert normalize_live_span({"kind": "note", "phase": "start"}) is None


def test_append_live_span_caps_length():
    spans: list[dict] = [{"n": i} for i in range(80)]
    append_live_span(spans, {"n": 80})
    assert len(spans) == 80
    assert spans[0]["n"] == 1
    assert spans[-1]["n"] == 80
