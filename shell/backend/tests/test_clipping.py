"""Tests for thinking tail clip and plan_prep checkpoint-first trim."""

from shell.backend.session.clipping import (
    PLAN_PREP_MAX,
    clip_thinking_tail,
    trim_plan_prep,
)


def test_clip_thinking_tail_keeps_latest_tokens():
    tail = "最新结论：YEAR 被拒后正在改写"
    text = "H" * 80 + "x" * 2000 + tail
    clipped = clip_thinking_tail(text, 2000)
    assert clipped.startswith("…")
    assert clipped.endswith(tail)
    assert len(clipped) == 2000
    assert "H" not in clipped


def test_clip_thinking_tail_short_unchanged():
    assert clip_thinking_tail("短推理", 2000) == "短推理"
    assert clip_thinking_tail("", 2000) == ""


def test_trim_plan_prep_keeps_checkpoints():
    items = [
        "正在规划…",
        "跨会话记忆：未命中",
        *[f"正在等待规划模型返回…{index}" for index in range(22)],
        "问句已改写为 西湖项目房间数",
    ]
    trimmed = trim_plan_prep(items, PLAN_PREP_MAX)
    assert len(trimmed) == PLAN_PREP_MAX
    assert "跨会话记忆：未命中" in trimmed
    assert "问句已改写为 西湖项目房间数" in trimmed
    assert "正在规划…" not in trimmed


def test_trim_plan_prep_caps_overflowing_checkpoints():
    items = [f"问句已改写为 版本{index}" for index in range(PLAN_PREP_MAX + 3)]
    items.insert(0, "正在规划…")
    trimmed = trim_plan_prep(items, PLAN_PREP_MAX)
    assert len(trimmed) == PLAN_PREP_MAX
    assert "正在规划…" not in trimmed
    assert trimmed[0] == "问句已改写为 版本3"
    assert trimmed[-1] == f"问句已改写为 版本{PLAN_PREP_MAX + 2}"
