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
from dataagent.agents.nl2sql.utils.label_contract import (
    LABEL_CASE_INSTEAD_OF_JOIN,
    LABEL_SCHEMA_MISSING,
    any_blocking_label_schema_issue,
    check_enum_label_contract,
    has_blocking_label_schema_issue,
    schema_has_enum_lookup,
)


def test_schema_has_enum_lookup():
    assert schema_has_enum_lookup({"room_info": {}, "ref_enum": {}}) is True
    assert schema_has_enum_lookup({"room_info": {}, "usage_config": {}}) is False


def test_label_contract_ok_with_join():
    issues = check_enum_label_contract(
        question="按用途统计房间数，给出用途代码和中文标签",
        schema={"room_info": {}, "ref_enum": {}},
        sql=(
            "SELECT r.usage_category, e.enum_label, COUNT(*) "
            "FROM room_info r LEFT JOIN ref_enum e "
            "ON e.enum_group='usage_category' AND e.enum_code=r.usage_category "
            "WHERE r.is_deleted=0 GROUP BY r.usage_category, e.enum_label"
        ),
    )
    assert issues == []


def test_label_contract_missing_schema_blocks():
    issues = check_enum_label_contract(
        question="按用途统计房间数，给出用途代码和中文标签",
        schema={"room_info": {}},
        sql="SELECT usage_category, CASE usage_category WHEN 'RESIDENTIAL' THEN '住宅' END FROM room_info",
    )
    assert any(i.startswith(LABEL_SCHEMA_MISSING) for i in issues)
    assert has_blocking_label_schema_issue(issues) is True


def test_label_contract_case_when_enum_present():
    issues = check_enum_label_contract(
        question="按用途统计，给出中文标签",
        schema={"room_info": {}, "ref_enum": {}},
        sql="SELECT usage_category, CASE usage_category WHEN 'RESIDENTIAL' THEN '住宅' END AS 标签 FROM room_info",
    )
    assert any(i.startswith(LABEL_CASE_INSTEAD_OF_JOIN) for i in issues)
    assert has_blocking_label_schema_issue(issues) is False


def test_label_contract_skips_when_no_label_ask():
    issues = check_enum_label_contract(
        question="按用途和计容类型统计房间数",
        schema={"room_info": {}},
        sql="SELECT usage_category, COUNT(*) FROM room_info GROUP BY usage_category",
    )
    assert issues == []


def test_any_blocking_label_schema_issue_detects_label_001_only():
    assert any_blocking_label_schema_issue(
        [{"issues": [f"{LABEL_SCHEMA_MISSING}: missing ref_enum"]}, {"issues": []}]
    )
    assert not any_blocking_label_schema_issue(
        [{"issues": [f"{LABEL_CASE_INSTEAD_OF_JOIN}: use JOIN"]}, {"issues": []}]
    )
    assert not any_blocking_label_schema_issue([])
