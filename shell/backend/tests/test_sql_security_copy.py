"""SQL hard-gate copy mapping and Landcheck readonly vs write/DDL checks."""

from pathlib import Path

import yaml

from dataagent.agents.nl2sql.security import check_sql
from shell.backend.adapters.sql_security_copy import (
    SQL_SECURITY_USER_MESSAGE,
    is_sql_security_error,
    sql_security_user_message,
)
from shell.backend.adapters.subagent_bridge import enrich_worker_tool_event
from shell.backend.app import _user_facing_error_text

_LANDCHECK_SCHEMA = {
    "lc_project": {"columns": {"id": {}, "name": {}, "created_at": {}}},
    "lc_building": {"columns": {"id": {}, "project_id": {}, "usage": {}}},
}

_READONLY_SQL = [
    "SELECT id, name FROM lc_project WHERE id = 1",
    "SELECT COUNT(*) FROM lc_project",
    "SELECT id FROM lc_project WHERE id = 1",
    "SELECT name FROM lc_project WHERE id = 1 ORDER BY id",
    "SELECT project_id, COUNT(*) FROM lc_building GROUP BY project_id",
    "SELECT a.id FROM lc_project a WHERE a.id = 1",
    "SELECT id FROM lc_project LIMIT 10",
    "SELECT MAX(id), MIN(id) FROM lc_project",
    "SELECT id FROM lc_project WHERE name IS NOT NULL",
    "SELECT id FROM lc_project WHERE created_at >= '2020-01-01'",
    "SELECT COALESCE(name, '') FROM lc_project WHERE id = 1",
    "SELECT CASE WHEN id = 1 THEN 1 ELSE 0 END FROM lc_project WHERE id = 1",
    "SELECT b.id FROM lc_building b INNER JOIN lc_project p ON b.project_id = p.id WHERE p.id = 1",
    "SELECT usage FROM lc_building WHERE project_id = 1",
    "SELECT id FROM lc_project WHERE id = 1 UNION ALL SELECT id FROM lc_building WHERE id = 1",
    "SELECT id FROM (SELECT id FROM lc_project WHERE id = 1) t",
]

_WRITE_DDL_SQL = [
    "INSERT INTO lc_project (id, name) VALUES (1, 'x')",
    "UPDATE lc_project SET name = 'x' WHERE id = 1",
    "DELETE FROM lc_project WHERE id = 1",
    "DROP TABLE lc_project",
    "ALTER TABLE lc_project ADD COLUMN note VARCHAR(20)",
    "CREATE TABLE lc_tmp (id INT)",
    "TRUNCATE TABLE lc_project",
    "REPLACE INTO lc_project (id, name) VALUES (1, 'x')",
]


def test_landcheck_nl2sql_yaml_enables_sql_security():
    path = Path("dataagent/core/flex/examples/landcheck_nl2sql.yaml")
    config = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert config["CORE"]["validator"]["sql_security_enabled"] is True


def test_readonly_samples_mostly_pass():
    blocked = [sql for sql in _READONLY_SQL if check_sql(sql, dialect="mysql", schema=_LANDCHECK_SCHEMA).blocked]
    assert len(_READONLY_SQL) >= 15
    pass_rate = 1 - (len(blocked) / len(_READONLY_SQL))
    assert pass_rate >= 0.9, f"readonly pass_rate={pass_rate:.2f} blocked={blocked}"


def test_write_and_ddl_are_always_blocked():
    for sql in _WRITE_DDL_SQL:
        result = check_sql(sql, dialect="mysql", schema=_LANDCHECK_SCHEMA)
        assert result.blocked is True, sql


def test_shell_maps_security_error_without_echoing_sql():
    raw = "SQLSecurityValidationError: Blocked by SQL security rules: SQL-001\nINSERT INTO lc_project VALUES (1)"
    mapped = sql_security_user_message(raw)
    assert mapped == SQL_SECURITY_USER_MESSAGE
    assert "INSERT" not in mapped
    assert "lc_project" not in mapped
    extra = enrich_worker_tool_event({"error": raw, "status": "error"})
    assert extra["error"] == SQL_SECURITY_USER_MESSAGE
    assert _user_facing_error_text(raw) == SQL_SECURITY_USER_MESSAGE
    assert not is_sql_security_error("SQL 服务调用失败 NL2SQL-SQL-001")
