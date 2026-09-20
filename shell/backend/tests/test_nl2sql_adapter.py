"""Tests for in-process NL2SQL custom progress mapping."""

from dataagent.agents.nl2sql.nodes.base_nl2sql_node import DA_DRAFT, DA_THINK
from shell.backend.adapters.nl2sql import iter_nl2sql_custom_events


def test_iter_nl2sql_custom_think_start_then_delta():
    events, node, draft = iter_nl2sql_custom_events(
        {"type": "nl2sql_progress", "kind": DA_THINK, "node": "generator", "delta": "why"},
        last_think_node=None,
        draft_sql="",
    )
    assert node == "generator"
    assert draft == ""
    assert [e["event"] for e in events] == ["think", "think"]
    assert events[0]["data"]["phase"] == "start"
    assert events[0]["data"]["scope"] == "subagent"
    assert events[1]["data"]["phase"] == "delta"
    assert events[1]["data"]["content"] == "why"


def test_iter_nl2sql_custom_think_same_node_skips_second_start():
    first, node, draft = iter_nl2sql_custom_events(
        {"type": "nl2sql_progress", "kind": DA_THINK, "node": "generator", "delta": "a"},
        last_think_node=None,
        draft_sql="",
    )
    second, node, draft = iter_nl2sql_custom_events(
        {"type": "nl2sql_progress", "kind": DA_THINK, "node": "generator", "delta": "b"},
        last_think_node=node,
        draft_sql=draft,
    )
    assert [e["data"]["phase"] for e in first] == ["start", "delta"]
    assert [e["data"]["phase"] for e in second] == ["delta"]
    assert second[0]["data"]["content"] == "b"


def test_iter_nl2sql_custom_draft_accumulates_sql():
    events, _node, draft = iter_nl2sql_custom_events(
        {"type": "nl2sql_progress", "kind": DA_DRAFT, "node": "generator", "delta": "SEL"},
        last_think_node=None,
        draft_sql="",
    )
    more, _node, draft = iter_nl2sql_custom_events(
        {"type": "nl2sql_progress", "kind": DA_DRAFT, "node": "generator", "delta": "ECT 1"},
        last_think_node=None,
        draft_sql=draft,
    )
    assert events[0]["event"] == "artifact"
    assert events[0]["data"]["sql"] == "SEL"
    assert more[0]["data"]["sql"] == "SELECT 1"
    assert draft == "SELECT 1"


def test_iter_nl2sql_custom_ignores_other_types():
    events, node, draft = iter_nl2sql_custom_events(
        {"type": "progress_hint", "hint": "x"},
        last_think_node="generator",
        draft_sql="SELECT 1",
    )
    assert events == []
    assert node == "generator"
    assert draft == "SELECT 1"
