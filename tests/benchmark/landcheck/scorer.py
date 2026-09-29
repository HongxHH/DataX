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
"""Score Landcheck L1 NL2SQL predictions against golden expectations."""

from __future__ import annotations

import re
from typing import Any

import sqlglot
from sqlglot import exp

# Common NL2SQL aliases (EN / CN) → canonical metric keys used in expect specs.
_COLUMN_SYNONYMS: dict[str, set[str]] = {
    "n": {"n", "cnt", "count", "total", "num", "数量", "总数", "个数"},
    "rooms": {"rooms", "room", "room_count", "roomcnt", "cnt", "count", "n", "数量", "房间数", "间数"},
    "area": {"area", "building_area", "buildingarea", "面积", "建筑面积"},
    "inner_area": {"inner_area", "innerarea", "套内", "套内面积"},
    "buildable_area": {"buildable_area", "buildablearea", "total_buildable_area", "计容面积", "计容"},
    "surveys": {"surveys", "survey", "survey_count", "报告数", "测绘报告数", "报告份数"},
    "y": {"y", "yr", "year", "年份", "年"},
    "project_name": {"project_name", "project", "name", "项目", "项目名称", "项目名"},
    "usage_category": {"usage_category", "usage", "用途", "用途代码"},
    "floor_area_type": {"floor_area_type", "floorareatype", "计容类型"},
}


def normalize_col(name: str) -> str:
    """Normalize a column label; keep ASCII + CJK letters/digits."""
    text = str(name).strip().lower()
    text = re.sub(r"[^\w\u4e00-\u9fff]+", "", text, flags=re.UNICODE)
    return text


def extract_tables(sql: str) -> set[str]:
    """Return lower-case base table names referenced by SQL."""
    if not sql or not str(sql).strip():
        return set()
    tables: set[str] = set()
    try:
        trees = sqlglot.parse(sql, read="mysql")
    except Exception:
        return set()
    for tree in trees:
        if tree is None:
            continue
        for table in tree.find_all(exp.Table):
            name = table.name
            if name:
                tables.add(str(name).lower())
    return tables


def _base_table_name(source: Any) -> str | None:
    if isinstance(source, exp.Table) and source.name:
        return str(source.name).lower()
    return None


def _eq_column_pairs(on_expr: exp.Expression | None) -> list[tuple[str, str, str, str]]:
    """Return (left_table, left_col, right_table, right_col) for equality predicates."""
    if on_expr is None:
        return []
    pairs: list[tuple[str, str, str, str]] = []
    for node in on_expr.find_all(exp.EQ):
        left, right = node.this, node.expression
        if not isinstance(left, exp.Column) or not isinstance(right, exp.Column):
            continue
        pairs.append(
            (
                str(left.table or "").lower(),
                str(left.name or "").lower(),
                str(right.table or "").lower(),
                str(right.name or "").lower(),
            )
        )
    return pairs


def has_room_survey_project_id_join(sql: str) -> bool:
    """True when base tables room_info and survey_report_info are joined only on project_id.

    Uses SQLGlot AST (not a wide regex) so pre-aggregated derived tables are not
    false-positives. Enable per case via ``forbid_room_survey_project_join``.
    """
    if not sql or not str(sql).strip():
        return False
    try:
        trees = sqlglot.parse(sql, read="mysql")
    except Exception:
        return False
    fact = {"room_info", "survey_report_info"}
    for tree in trees:
        if tree is None:
            continue
        alias_to_table: dict[str, str] = {}
        for table in tree.find_all(exp.Table):
            name = str(table.name or "").lower()
            if not name:
                continue
            alias_to_table[name] = name
            alias = str(table.alias or "").lower()
            if alias:
                alias_to_table[alias] = name
        for join in tree.find_all(exp.Join):
            using = join.args.get("using")
            if using:
                using_names = {str(getattr(ident, "name", ident)).lower() for ident in using}
                right_name = _base_table_name(join.this)
                select = join.find_ancestor(exp.Select)
                left_name = None
                if select is not None and select.args.get("from"):
                    left_name = _base_table_name(select.args["from"].this)
                if {left_name, right_name} == fact and using_names == {"project_id"}:
                    return True
                continue
            on_expr = join.args.get("on")
            involved: set[str] = set()
            project_eq = False
            row_key = False
            for lt, lc, rt, rc in _eq_column_pairs(on_expr):
                t_left = alias_to_table.get(lt, lt)
                t_right = alias_to_table.get(rt, rt)
                involved.update({t_left, t_right} & fact)
                cols = {lc, rc}
                if "project_id" in cols:
                    project_eq = True
                if cols & {"id", "survey_report_info_id"}:
                    row_key = True
            if involved == fact and project_eq and not row_key:
                return True
    return False


def merge_patterns(defaults: list[str] | None, overrides: list[str] | None) -> list[str]:
    """Merge default + case patterns, de-dupe, preserve order."""
    out: list[str] = []
    for item in list(defaults or []) + list(overrides or []):
        if item and item not in out:
            out.append(item)
    return out


_SQL_STRING_LITERAL_RE = re.compile(
    r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`",
    re.DOTALL,
)


def strip_sql_string_literals(sql: str) -> str:
    """Remove quoted string/identifier literals so forbidden checks ignore prose."""
    return _SQL_STRING_LITERAL_RE.sub("''", sql or "")


def score_sql_patterns(
    sql: str,
    *,
    required: list[str] | None = None,
    forbidden: list[str] | None = None,
    allow_empty: bool = False,
) -> dict[str, Any]:
    text = sql or ""
    if not text.strip():
        if allow_empty:
            return {"passed": True, "missing_required": [], "hit_forbidden": [], "empty_sql": True}
        return {
            "passed": False,
            "missing_required": list(required or []),
            "hit_forbidden": [],
            "empty_sql": True,
        }

    # Required patterns look at full SQL (e.g. is_deleted=0). Forbidden patterns
    # ignore string literals so refusal prose like 'no password column' is not a hit,
    # while AS password / sys_user identifiers still match.
    structural = strip_sql_string_literals(text)
    missing = [p for p in (required or []) if not re.search(p, text)]
    hit = [p for p in (forbidden or []) if re.search(p, structural)]
    return {
        "passed": not missing and not hit,
        "missing_required": missing,
        "hit_forbidden": hit,
        "empty_sql": False,
    }


def score_table_recall(
    expected: list[str] | None,
    predicted_sql: str,
    *,
    linked_tables: list[str] | None = None,
) -> dict[str, Any]:
    """SQL table recall; optionally also score schema-linking candidate coverage."""
    want = {t.lower() for t in (expected or []) if t}
    got = extract_tables(predicted_sql)
    missing = sorted(want - got) if want else []
    linking: dict[str, Any] | None = None
    if linked_tables is not None and want:
        linked = {t.lower() for t in linked_tables if t}
        link_missing = sorted(want - linked)
        linking = {
            "passed": not link_missing,
            "linked": sorted(linked),
            "missing": link_missing,
        }
    return {
        "passed": not missing,
        "expected": sorted(want),
        "predicted": sorted(got),
        "missing": missing,
        "schema_linking": linking,
    }


def _as_number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _match_cell(actual: Any, spec: Any) -> bool:
    if isinstance(spec, dict):
        if "contains" in spec:
            return str(spec["contains"]) in str(actual or "")
        if "equals" in spec:
            return _values_equal(actual, spec["equals"], abs_tol=float(spec.get("abs_tol", 0)))
        if "approx" in spec:
            return _values_equal(actual, spec["approx"], abs_tol=float(spec.get("abs_tol", 1.0)))
        if "min" in spec:
            num = _as_number(actual)
            return num is not None and num >= float(spec["min"])
        if "max" in spec:
            num = _as_number(actual)
            return num is not None and num <= float(spec["max"])
        return False
    return _values_equal(actual, spec, abs_tol=0.0)


def _values_equal(actual: Any, expected: Any, *, abs_tol: float) -> bool:
    a_num = _as_number(actual)
    e_num = _as_number(expected)
    if a_num is not None and e_num is not None:
        return abs(a_num - e_num) <= abs_tol
    return str(actual).strip() == str(expected).strip()


def _row_dicts(columns: list[str], rows: list[list[Any]]) -> list[dict[str, Any]]:
    keys = [normalize_col(c) for c in columns]
    out: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {}
        for i, key in enumerate(keys):
            if not key:
                key = f"_col{i}"
            if i < len(row):
                item[key] = row[i]
        if len(row) == 1 and "value" not in item:
            item["value"] = row[0]
        out.append(item)
    return out


def _alias_candidates(name: str) -> list[str]:
    key = normalize_col(name)
    aliases = {key, name.strip().lower()}
    for canon, group in _COLUMN_SYNONYMS.items():
        norm_group = {normalize_col(x) for x in group}
        if key == canon or key in norm_group:
            aliases.add(canon)
            aliases |= norm_group
    return [a for a in aliases if a]


def _find_column(row: dict[str, Any], aliases: list[str]) -> Any:
    candidates: list[str] = []
    for alias in aliases:
        candidates.extend(_alias_candidates(alias))
    # de-dupe
    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    for key in ordered:
        if key in row:
            return row[key]
    for key in ordered:
        for row_key, value in row.items():
            if key and key in row_key:
                return value
    return None


def _row_matches(row: dict[str, Any], match_spec: dict[str, Any] | None) -> bool:
    if not match_spec:
        return True
    for col, spec in match_spec.items():
        actual = _find_column(row, [col])
        if actual is None:
            return False
        if not _match_cell(actual, spec if isinstance(spec, dict) else {"equals": spec}):
            return False
    return True


def _check_values(row: dict[str, Any], values: dict[str, Any], abs_tol: float) -> list[str]:
    errors: list[str] = []
    for col, spec in (values or {}).items():
        actual = _find_column(row, [col])
        if actual is None:
            errors.append(f"missing column `{col}`")
            continue
        effective = spec
        if isinstance(spec, dict) and "approx" in spec and "abs_tol" not in spec:
            effective = {**spec, "abs_tol": abs_tol}
        elif not isinstance(spec, dict):
            if isinstance(spec, float) or (isinstance(spec, str) and "." in spec):
                effective = {"approx": spec, "abs_tol": abs_tol}
            else:
                effective = {"equals": spec}
        if not _match_cell(actual, effective):
            errors.append(f"`{col}` expected {spec!r}, got {actual!r}")
    return errors


def score_expect(
    columns: list[str],
    rows: list[list[Any]],
    expect: dict[str, Any] | None,
    *,
    abs_tol: float = 1.0,
) -> dict[str, Any]:
    if expect is None:
        return {"passed": True, "skipped": True, "errors": []}

    kind = expect.get("kind")
    table = _row_dicts(columns, rows)
    errors: list[str] = []

    if kind == "scalar":
        col = expect.get("column") or "n"
        if not table:
            return {"passed": False, "skipped": False, "errors": ["empty result"]}
        actual = _find_column(table[0], [col, "value"])
        if actual is None:
            errors.append(f"missing scalar column `{col}`")
            return {"passed": False, "skipped": False, "errors": errors}
        if "equals" in expect:
            target = expect["equals"]
            if isinstance(target, dict):
                spec = dict(target)
                if "approx" in spec and "abs_tol" not in spec:
                    spec["abs_tol"] = abs_tol
                ok = _match_cell(actual, spec)
            else:
                ok = _values_equal(actual, target, abs_tol=0.0 if isinstance(target, int) else abs_tol)
        elif "approx" in expect:
            ok = _match_cell(
                actual,
                {"approx": expect["approx"], "abs_tol": float(expect.get("abs_tol", abs_tol))},
            )
        else:
            return {"passed": False, "skipped": False, "errors": ["scalar expect missing equals/approx"]}
        if not ok:
            errors.append(f"scalar `{col}` expected {expect.get('equals', expect.get('approx'))!r}, got {actual!r}")
        return {"passed": not errors, "skipped": False, "errors": errors}

    if kind == "scalar_multi":
        if not table:
            return {"passed": False, "skipped": False, "errors": ["empty result"]}
        errors.extend(_check_values(table[0], expect.get("values") or {}, abs_tol))
        return {"passed": not errors, "skipped": False, "errors": errors}

    if kind == "keyed_rows":
        for spec in expect.get("rows") or []:
            match = spec.get("match") or {}
            candidates = [r for r in table if _row_matches(r, match)]
            if not candidates:
                errors.append(f"no row matched {match!r}")
                continue
            errors.extend(_check_values(candidates[0], spec.get("values") or {}, abs_tol))
        return {"passed": not errors, "skipped": False, "errors": errors}

    if kind == "ordered_top":
        limit = int(expect.get("limit") or 1)
        head = table[:limit]
        for spec in expect.get("rows") or []:
            rank = int(spec.get("rank") or 1)
            if rank < 1 or rank > len(head):
                errors.append(f"rank {rank} out of range (got {len(head)} rows)")
                continue
            row = head[rank - 1]
            if not _row_matches(row, spec.get("match")):
                errors.append(f"rank {rank} row match failed: {spec.get('match')!r}, got {row!r}")
            errors.extend(_check_values(row, spec.get("values") or {}, abs_tol))
        return {"passed": not errors, "skipped": False, "errors": errors}

    return {"passed": False, "skipped": False, "errors": [f"unknown expect.kind={kind!r}"]}


def score_case(
    case: dict[str, Any],
    *,
    pred_sql: str,
    pred_columns: list[str] | None = None,
    pred_rows: list[list[Any]] | None = None,
    defaults: dict[str, Any] | None = None,
    linked_tables: list[str] | None = None,
) -> dict[str, Any]:
    """Score one case. Caller supplies executed pred result when needed."""
    defaults = defaults or {}
    abs_tol = float(case.get("numeric_abs_tol", defaults.get("numeric_abs_tol", 1.0)))
    required = merge_patterns(
        defaults.get("required_sql_patterns"),
        case.get("required_sql_patterns"),
    )
    forbidden = merge_patterns(
        defaults.get("forbidden_sql_patterns"),
        case.get("forbidden_sql_patterns"),
    )
    if case.get("skip_default_required"):
        required = list(case.get("required_sql_patterns") or [])

    allow_empty = bool(case.get("allow_empty_sql", False))
    pattern = score_sql_patterns(
        pred_sql,
        required=required,
        forbidden=forbidden,
        allow_empty=allow_empty,
    )
    if case.get("forbid_room_survey_project_join") and has_room_survey_project_id_join(pred_sql):
        pattern = dict(pattern)
        hits = list(pattern.get("hit_forbidden") or [])
        hits.append("room_info ⋈ survey_report_info ON project_id")
        pattern["hit_forbidden"] = hits
        pattern["passed"] = False
    tables = score_table_recall(
        case.get("expected_tables"),
        pred_sql,
        linked_tables=linked_tables,
    )

    score_mode = case.get("score_mode") or "full"
    expect_result: dict[str, Any]
    if score_mode == "sql_patterns_only":
        expect_result = {"passed": True, "skipped": True, "errors": []}
    else:
        if pred_columns is None or pred_rows is None:
            expect_result = {
                "passed": False,
                "skipped": False,
                "errors": ["missing executed prediction result"],
            }
        else:
            expect_result = score_expect(
                pred_columns,
                pred_rows,
                case.get("expect"),
                abs_tol=abs_tol,
            )

    # Table recall from SQL is hard-gate; schema-linking miss is reported but soft
    # unless case explicitly sets require_schema_linking.
    linking = tables.get("schema_linking")
    linking_ok = True
    if case.get("require_schema_linking") and linking is not None:
        linking_ok = bool(linking.get("passed"))

    passed = bool(pattern["passed"] and tables["passed"] and expect_result["passed"] and linking_ok)
    return {
        "case_id": case.get("id"),
        "passed": passed,
        "sql_patterns": pattern,
        "table_recall": tables,
        "execution": expect_result,
        "pred_sql": pred_sql,
    }
