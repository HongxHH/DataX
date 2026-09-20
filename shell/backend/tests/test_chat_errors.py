from dataagent.core.workspace.lock import WorkspaceBusyError

from shell.backend.app import _user_facing_error_text, _user_facing_stream_error


def test_user_facing_stream_error_maps_common_failures():
    assert "语义层" in _user_facing_stream_error(RuntimeError("SemanticService 400 queryVector is null"))
    assert "超时" in _user_facing_stream_error(TimeoutError("read timed out"))
    assert _user_facing_stream_error(RuntimeError("boom")).startswith("生成失败：")


def test_user_facing_stream_error_maps_workspace_busy():
    busy = WorkspaceBusyError.from_workspace("/tmp/session-ws")
    assert "工作区正被占用" in _user_facing_stream_error(busy)
    assert "工作区正被占用" in _user_facing_error_text("Session workspace is busy: /tmp/session-ws")


def test_user_facing_error_maps_worker_busy():
    assert "换一个新的 worker" in _user_facing_error_text(
        "subagent 3 is already running; create a new subagent instead of reusing it"
    )


def test_user_facing_error_maps_sql_security_without_sql():
    raw = "Blocked by SQL security rules: SQL-001 DELETE FROM lc_project"
    text = _user_facing_error_text(raw)
    assert "只允许只读 SELECT" in text
    assert "DELETE" not in text


def test_user_facing_error_keeps_connection_interrupt_copy():
    msg = "已运行 9 分钟后连接中断"
    assert _user_facing_error_text(msg) == msg

