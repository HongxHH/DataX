# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ============================================================================
"""Unit tests for Landcheck L1 scorer (no MySQL / no LLM)."""

from __future__ import annotations

from tests.benchmark.landcheck.scorer import (
    extract_tables,
    has_room_survey_project_id_join,
    merge_patterns,
    score_case,
    score_expect,
    score_sql_patterns,
)


def test_extract_tables_mysql():
    sql = (
        "SELECT p.project_name, COUNT(*) AS rooms FROM room_info r "
        "JOIN project p ON p.id = r.project_id WHERE r.is_deleted = 0 GROUP BY p.project_name"
    )
    assert extract_tables(sql) == {"room_info", "project"}


def test_merge_patterns_keeps_defaults():
    assert merge_patterns(
        [r"(?i)is_deleted\s*=\s*0"],
        [r"(?i)usage_category"],
    ) == [r"(?i)is_deleted\s*=\s*0", r"(?i)usage_category"]


def test_required_defaults_merged_into_case():
    case = {
        "id": "usage",
        "expected_tables": ["room_info"],
        "required_sql_patterns": [r"(?i)usage_category"],
        "expect": {"kind": "scalar", "column": "rooms", "equals": 1},
    }
    # Missing is_deleted must fail after merge with defaults.
    got = score_case(
        case,
        pred_sql="SELECT COUNT(*) AS rooms FROM room_info WHERE usage_category='RESIDENTIAL'",
        pred_columns=["rooms"],
        pred_rows=[[1]],
        defaults={"required_sql_patterns": [r"(?i)is_deleted`?\s*=\s*0"]},
    )
    assert got["passed"] is False
    assert got["sql_patterns"]["missing_required"]


def test_zhigu_scalar_multi_aliases():
    case = {
        "id": "zhigu",
        "expected_tables": ["project", "room_info"],
        "expect": {
            "kind": "scalar_multi",
            "values": {"rooms": 535, "area": {"approx": 395113.23}},
        },
    }
    got = score_case(
        case,
        pred_sql=(
            "SELECT COUNT(r.id) AS room_count, SUM(r.building_area) AS total_building_area "
            "FROM project p JOIN room_info r ON p.id = r.project_id AND r.is_deleted = 0 "
            "WHERE p.is_deleted = 0 AND p.project_name LIKE '%智谷%'"
        ),
        pred_columns=["room_count", "total_building_area"],
        pred_rows=[[535, 395113.23]],
        defaults={"required_sql_patterns": [r"(?i)is_deleted`?\s*=\s*0"]},
    )
    assert got["passed"] is True


def test_sql_patterns_year_and_soft_delete():
    sql = "SELECT YEAR(project_time) AS y, COUNT(*) n FROM project WHERE is_deleted = 0 GROUP BY y"
    got = score_sql_patterns(
        sql,
        required=[r"(?i)\bYEAR\s*\(", r"(?i)is_deleted`?\s*=\s*0"],
        forbidden=[r"(?i)\bstrftime\b", r"(?i)\b(insert|update|delete|drop|alter|truncate)\s+"],
    )
    assert got["passed"] is True


def test_sql_patterns_is_deleted_with_backticks():
    sql = "SELECT COUNT(*) AS n FROM `room_info` WHERE `is_deleted` = 0"
    got = score_sql_patterns(sql, required=[r"(?i)is_deleted`?\s*=\s*0"], forbidden=[])
    assert got["passed"] is True


def test_sql_patterns_forbidden_strftime():
    sql = "SELECT strftime('%Y', project_time), COUNT(*) FROM project WHERE is_deleted = 0"
    got = score_sql_patterns(sql, required=[], forbidden=[r"(?i)\bstrftime\b"])
    assert got["passed"] is False
    assert got["hit_forbidden"]


def test_score_expect_keyed_rows_zhigu():
    columns = ["project_name", "rooms", "area"]
    rows = [["36-智谷项目", 535, 395113.23]]
    expect = {
        "kind": "keyed_rows",
        "rows": [
            {
                "match": {"project_name": {"contains": "智谷"}},
                "values": {"rooms": 535, "area": {"approx": 395113.23}},
            }
        ],
    }
    got = score_expect(columns, rows, expect, abs_tol=1.0)
    assert got["passed"] is True


def test_score_expect_chinese_aliases():
    columns = ["项目名称", "房间数", "建筑面积"]
    rows = [["36-智谷项目", 535, 395113.23]]
    expect = {
        "kind": "keyed_rows",
        "rows": [
            {
                "match": {"project_name": {"contains": "智谷"}},
                "values": {"rooms": 535, "area": {"approx": 395113.23}},
            }
        ],
    }
    got = score_expect(columns, rows, expect, abs_tol=1.0)
    assert got["passed"] is True


def test_score_expect_ordered_top():
    columns = ["project_name", "rooms"]
    rows = [["13-嘉顺苑", 5989], ["7-佳兆业", 5284], ["10-金茂乾璟苑", 4208]]
    expect = {
        "kind": "ordered_top",
        "limit": 3,
        "rows": [
            {"rank": 1, "match": {"project_name": {"contains": "嘉顺苑"}}, "values": {"rooms": 5989}},
            {"rank": 2, "match": {"project_name": {"contains": "佳兆业"}}, "values": {"rooms": 5284}},
        ],
    }
    got = score_expect(columns, rows, expect)
    assert got["passed"] is True


def test_score_expect_scalar_approx():
    got = score_expect(
        ["inner_area"],
        [[322425.88]],
        {"kind": "scalar", "column": "inner_area", "approx": 322425.88},
        abs_tol=1.0,
    )
    assert got["passed"] is True


def test_score_case_full_pass():
    case = {
        "id": "demo",
        "expected_tables": ["project", "room_info"],
        "required_sql_patterns": [r"(?i)is_deleted\s*=\s*0"],
        "forbidden_sql_patterns": [r"(?i)\bstrftime\b"],
        "expect": {"kind": "scalar", "column": "rooms", "equals": 535},
    }
    sql = (
        "SELECT COUNT(*) AS rooms FROM room_info r JOIN project p ON p.id = r.project_id "
        "WHERE r.is_deleted = 0 AND p.is_deleted = 0 AND p.project_name LIKE '%智谷%'"
    )
    got = score_case(case, pred_sql=sql, pred_columns=["rooms"], pred_rows=[[535]], defaults={})
    assert got["passed"] is True


def test_score_case_empty_sql_allowed_for_security():
    case = {
        "id": "sec",
        "score_mode": "sql_patterns_only",
        "skip_default_required": True,
        "allow_empty_sql": True,
        "forbidden_sql_patterns": [r"(?i)password"],
        "expect": None,
    }
    got = score_case(
        case,
        pred_sql="",
        defaults={"required_sql_patterns": [r"(?i)is_deleted\s*=\s*0"]},
    )
    assert got["passed"] is True


def test_require_schema_linking_hard_gates_missing_ref_enum():
    case = {
        "id": "usage_labels",
        "expected_tables": ["room_info", "ref_enum"],
        "require_schema_linking": True,
        "skip_default_required": True,
        "required_sql_patterns": [r"(?i)ref_enum"],
        "expect": None,
        "score_mode": "sql_patterns_only",
    }
    sql = "SELECT usage_category, enum_label FROM room_info r JOIN ref_enum e ON 1=1 WHERE r.is_deleted=0"
    soft_ok = score_case(case={**case, "require_schema_linking": False}, pred_sql=sql, linked_tables=["room_info"])
    assert soft_ok["passed"] is True
    assert soft_ok["table_recall"]["schema_linking"]["passed"] is False
    hard_fail = score_case(case=case, pred_sql=sql, linked_tables=["room_info"])
    assert hard_fail["passed"] is False
    hard_ok = score_case(case=case, pred_sql=sql, linked_tables=["room_info", "ref_enum"])
    assert hard_ok["passed"] is True


def test_join_explosion_flags_direct_project_id_join():
    sql = (
        "SELECT COUNT(*) FROM room_info r "
        "JOIN survey_report_info s ON r.project_id = s.project_id WHERE r.is_deleted = 0"
    )
    assert has_room_survey_project_id_join(sql) is True


def test_join_explosion_allows_derived_tables_and_report_id():
    derived = (
        "SELECT p.project_name, r.room_count, s.survey_report_count "
        "FROM project p "
        "LEFT JOIN (SELECT project_id, COUNT(id) AS room_count FROM room_info "
        "WHERE is_deleted = 0 GROUP BY project_id) r ON p.id = r.project_id "
        "LEFT JOIN (SELECT project_id, COUNT(id) AS survey_report_count FROM survey_report_info "
        "WHERE is_deleted = 0 GROUP BY project_id) s ON p.id = s.project_id "
        "WHERE p.is_deleted = 0 ORDER BY room_count DESC LIMIT 10"
    )
    keyed = (
        "SELECT COUNT(*) FROM room_info r "
        "JOIN survey_report_info s ON r.survey_report_info_id = s.id WHERE r.is_deleted = 0"
    )
    gold = (
        "SELECT p.project_name, (SELECT COUNT(*) FROM room_info r WHERE r.project_id = p.id) AS rooms "
        "FROM project p ORDER BY rooms DESC"
    )
    assert has_room_survey_project_id_join(derived) is False
    assert has_room_survey_project_id_join(keyed) is False
    assert has_room_survey_project_id_join(gold) is False


def test_score_case_forbid_room_survey_project_join():
    case = {
        "id": "join",
        "expected_tables": ["room_info", "survey_report_info"],
        "forbid_room_survey_project_join": True,
        "score_mode": "sql_patterns_only",
        "skip_default_required": True,
        "expect": None,
    }
    bad = (
        "SELECT COUNT(*) FROM room_info r JOIN survey_report_info s ON r.project_id = s.project_id"
    )
    got = score_case(case, pred_sql=bad, pred_columns=["n"], pred_rows=[[1]], defaults={})
    assert got["passed"] is False
    assert got["sql_patterns"]["hit_forbidden"]

