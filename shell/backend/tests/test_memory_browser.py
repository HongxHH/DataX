"""Tests for read-only memory desk helpers."""

from pathlib import Path

from shell.backend.session import memory_browser as mb


def test_list_catalog_reads_snapshots_and_memory_md(tmp_path: Path, monkeypatch):
    user = tmp_path / "u1"
    sess = user / "sess-a" / ".memory"
    sess.mkdir(parents=True)
    (sess / "snapshot.json").write_text(
        '{"session_summary": "查了房间数", "goals": ["住房"], "important_findings": ["59套"]}',
        encoding="utf-8",
    )
    mem = user / ".memory"
    mem.mkdir()
    (mem / "MEMORY.md").write_text("# Memory\n### sess-a\n摘要\n", encoding="utf-8")
    (mem / "profile.json").write_text('{"user_profile": {"identity": "测试"}}', encoding="utf-8")

    monkeypatch.setattr(mb, "resolve_user_root", lambda user_id="u1", config=None: user)
    monkeypatch.setattr(
        mb,
        "resolve_flex_session_memory_dir",
        lambda user_id=None, session_id=None, workspace=None, config=None: user / str(session_id) / ".memory",
    )

    catalog = mb.list_memory_catalog(user_id="u1", current_session_id="sess-a")
    assert catalog["has_memory_md"] is True
    assert catalog["has_profile"] is True
    assert len(catalog["sessions"]) == 1
    assert catalog["sessions"][0]["session_id"] == "sess-a"
    assert catalog["sessions"][0]["is_current"] is True
    assert "房间" in catalog["sessions"][0]["session_summary"]

    snap = mb.load_session_snapshot(user_id="u1", session_id="sess-a")
    assert snap is not None
    assert snap["snapshot"]["goals"] == ["住房"]

    md = mb.load_memory_markdown(user_id="u1")
    assert md is not None and "sess-a" in md["content"]

    profile = mb.load_user_profile(user_id="u1")
    assert profile is not None and profile["profile"]["identity"] == "测试"


def test_trial_recall_marks_would_pack(tmp_path: Path, monkeypatch):
    sessions = [
        {"session_id": "a", "search_text": "西湖 项目 房间 总数"},
        {"session_id": "b", "search_text": "完全无关的内容"},
    ]
    monkeypatch.setattr(mb, "_collect_recall_sessions", lambda user_id, current: sessions)
    monkeypatch.setattr(mb, "_keyword_relevance", lambda query, doc: 0.8 if "西湖" in doc else 0.0)
    monkeypatch.setattr(
        mb,
        "_build_cross_session_memory",
        lambda sessions, query, top_k=3, max_chars=1500: ("### a\n西湖\n", 1),
    )
    result = mb.trial_cross_session_recall("西湖房间", user_id="u1", current_session_id="now")
    assert result["hit_count"] == 1
    assert result["hits"][0]["session_id"] == "a"
    assert result["hits"][0]["would_pack"] is True
    assert result["hits"][0]["reject_reason"] is None
    assert result["hits"][1]["would_pack"] is False
    assert result["hits"][1]["reject_reason"] == "below_threshold"
    assert result["miss_summary"] == ""
    assert result["threshold"] == 0.01
    assert isinstance(result["query_tokens"], list)


def test_trial_recall_miss_summary_empty_library(monkeypatch):
    monkeypatch.setattr(mb, "_collect_recall_sessions", lambda user_id, current: [])
    monkeypatch.setattr(mb, "_build_cross_session_memory", lambda *args, **kwargs: ("", 0))
    result = mb.trial_cross_session_recall("西湖房间", user_id="u1", current_session_id="now")
    assert result["hit_count"] == 0
    assert result["hits"] == []
    assert "没有可检索" in result["miss_summary"]


def test_trial_recall_miss_summary_below_threshold(monkeypatch):
    sessions = [{"session_id": "a", "search_text": "完全无关的内容"}]
    monkeypatch.setattr(mb, "_collect_recall_sessions", lambda user_id, current: sessions)
    monkeypatch.setattr(mb, "_keyword_relevance", lambda query, doc: 0.0)
    monkeypatch.setattr(mb, "_build_cross_session_memory", lambda *args, **kwargs: ("", 0))
    result = mb.trial_cross_session_recall("abcdefghijk", user_id="u1", current_session_id="now")
    assert result["hit_count"] == 0
    assert result["hits"][0]["reject_reason"] == "below_threshold"
    assert "低于阈值" in result["miss_summary"]


def test_trial_recall_outside_top_k(monkeypatch):
    sessions = [{"session_id": f"s{i}", "search_text": "西湖"} for i in range(5)]
    monkeypatch.setattr(mb, "_collect_recall_sessions", lambda user_id, current: sessions)
    monkeypatch.setattr(mb, "_keyword_relevance", lambda query, doc: 0.5)
    monkeypatch.setattr(
        mb,
        "_build_cross_session_memory",
        lambda sessions, query, top_k=3, max_chars=1500: ("### s0\n西湖\n", 3),
    )
    result = mb.trial_cross_session_recall("西湖", user_id="u1", current_session_id="now")
    packed = [hit for hit in result["hits"] if hit["would_pack"]]
    leftover = [hit for hit in result["hits"] if not hit["would_pack"]]
    assert len(packed) == 3
    assert leftover
    assert all(hit["reject_reason"] == "outside_top_k" for hit in leftover)
