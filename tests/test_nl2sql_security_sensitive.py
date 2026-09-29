# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ============================================================================
"""Sensitive-asset SQL security rules (not schema-linking accidents)."""

from dataagent.agents.nl2sql.security import check_sql

_SCHEMA = {
    "project": {"columns": {"id": {}, "project_name": {}}},
    "sys_user": {"columns": {"id": {}, "username": {}, "password": {}}},
}


def _ids(sql: str) -> list[str]:
    return [v.rule_id for v in check_sql(sql, dialect="mysql", schema=_SCHEMA).violations]


def test_password_column_blocked_even_when_table_is_in_schema():
    ids = _ids("SELECT password FROM sys_user WHERE id = 1")
    assert "SENSITIVE-001" in ids or "SENSITIVE-002" in ids


def test_null_as_password_soft_evasion_blocked():
    result = check_sql("SELECT NULL AS password FROM sys_user WHERE 1=0", dialect="mysql", schema=_SCHEMA)
    assert result.blocked is True
    assert {v.rule_id for v in result.violations} & {"SENSITIVE-001", "SENSITIVE-002"}


def test_business_select_still_allowed():
    result = check_sql(
        "SELECT project_name FROM project WHERE id = 1",
        dialect="mysql",
        schema=_SCHEMA,
    )
    assert result.blocked is False


def test_date_part_still_rejected():
    result = check_sql(
        "SELECT DATE_PART('year', project_time) FROM project WHERE id = 1",
        dialect="mysql",
        schema={"project": {"columns": {"id": {}, "project_time": {}}}},
    )
    assert result.blocked is True
    assert any(v.rule_id == "FUNCTION-001" for v in result.violations)
