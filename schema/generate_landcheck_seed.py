# Licensed under the Apache License, Version 2.0
"""Parse schema/schema.sql and emit Semantic Service bulk JSON for landcheck."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SQL_PATH = ROOT / "schema.sql"
OUT_PATH = ROOT / "landcheck_seed.json"

DB = "landcheck"
SOURCE = "mysql"
SKIP_COLUMNS = {("sys_user", "password")}

TYPE_MAP = [
    (r"^DATETIME", "timestamp"),
    (r"^DATE", "date"),
    (r"^BIGINT", "bigint"),
    (r"^INT", "int"),
    (r"^TINYINT", "tinyint"),
    (r"^DECIMAL", "numeric"),
    (r"^VARCHAR", "varchar"),
    (r"^CHAR", "char"),
    (r"^TEXT", "text"),
    (r"^JSON", "json"),
]

TABLE_LLM = {
    "project": "建设项目根表。问「某某项目」先用 project_name 模糊匹配。项目年份用 YEAR(project_time)。",
    "survey_report_info": "测绘报告，通常一栋一份。计容优先 total_buildable_area。禁止与 room_info 只按 project_id JOIN。",
    "room_info": "房间明细最大事实表。建筑面积用 building_area；用途用 usage_category 不要用常为空的 room_usage；计容用 floor_area_type='BUILDABLE'。挂某一栋必须用 survey_report_info_id。",
    "contract_info": "土地/房产合同。total_area 大部分为空，问面积不要用本合同面积，改用测绘或房间汇总。",
    "planning_review_form": "规划审查意见书主表，一个文件一份。",
    "planning_review_row": "规划审查明细行。挂 planning_review_form_id，不要只按 project_id 去乘房间。",
    "ref_enum": "枚举释义。翻译 usage_category / floor_area_type 等代码必须 JOIN 本表，并带 enum_group。",
    "sys_user": "系统用户。禁止查询 password 列。",
    "usage_config": "房间用途匹配规则。usage_pattern 是测绘原文，usage_category 是标准分类代码。",
}

JOINS: list[tuple[str, str, str, str, str, str, str]] = [
    # src_table, src_col, tgt_table, tgt_col, join_type, cardinality, intent
    ("file_archive", "project_id", "project", "id", "INNER JOIN", "N:1", "档案夹属于项目"),
    ("file_record", "project_id", "project", "id", "INNER JOIN", "N:1", "文件属于项目"),
    ("file_record", "archive_id", "file_archive", "id", "LEFT JOIN", "N:1", "文件归入档案夹"),
    ("upload_record", "file_id", "file_record", "id", "INNER JOIN", "N:1", "上传流水对应文件"),
    ("ocr_execution_result", "file_record_id", "file_record", "id", "INNER JOIN", "N:1", "OCR 记录对应文件"),
    ("contract_info", "project_id", "project", "id", "INNER JOIN", "N:1", "合同属于项目"),
    ("contract_info", "file_record_id", "file_record", "id", "LEFT JOIN", "N:1", "合同来源文件"),
    ("planning_review_form", "project_id", "project", "id", "INNER JOIN", "N:1", "规划审查主表属于项目"),
    ("planning_review_form", "file_record_id", "file_record", "id", "LEFT JOIN", "N:1", "规划审查来源文件"),
    ("planning_review_row", "project_id", "project", "id", "INNER JOIN", "N:1", "规划审查行属于项目"),
    ("planning_review_row", "planning_review_form_id", "planning_review_form", "id", "INNER JOIN", "N:1", "规划审查行挂主表"),
    ("project_party_survey_summary_form", "project_id", "project", "id", "INNER JOIN", "N:1", "甲方实测汇总属于项目"),
    ("survey_report_info", "project_id", "project", "id", "INNER JOIN", "N:1", "测绘报告属于项目"),
    ("survey_report_info", "file_record_id", "file_record", "id", "LEFT JOIN", "N:1", "测绘报告来源文件"),
    ("room_info", "project_id", "project", "id", "INNER JOIN", "N:1", "房间属于项目；项目级汇总可按此关联"),
    (
        "room_info",
        "survey_report_info_id",
        "survey_report_info",
        "id",
        "INNER JOIN",
        "N:1",
        "房间挂某一栋/某份测绘报告必须用此键，禁止只按 project_id 与测绘报告 JOIN",
    ),
    ("room_info", "file_record_id", "file_record", "id", "LEFT JOIN", "N:1", "房间来源文件"),
    ("unknown_usage_record", "project_id", "project", "id", "INNER JOIN", "N:1", "未知用途属于项目"),
    ("unknown_usage_record", "room_info_id", "room_info", "id", "LEFT JOIN", "N:1", "未知用途关联房间"),
    ("unknown_usage_record", "survey_report_info_id", "survey_report_info", "id", "LEFT JOIN", "N:1", "未知用途关联测绘报告"),
    ("station_message", "project_id", "project", "id", "LEFT JOIN", "N:1", "站内消息可选挂项目"),
    ("user_station_message_read", "message_id", "station_message", "id", "INNER JOIN", "N:1", "已读记录对应消息"),
    ("operation_audit_log", "project_id", "project", "id", "LEFT JOIN", "N:1", "审计日志可选挂项目"),
    ("project", "created_by", "sys_user", "id", "LEFT JOIN", "N:1", "项目创建人"),
]

ENUM_VALUES = [
    ("room_info", "usage_category", "RESIDENTIAL", "住宅"),
    ("room_info", "usage_category", "COMMERCIAL", "商业"),
    ("room_info", "usage_category", "MANAGEMENT", "物业管理"),
    ("room_info", "usage_category", "OTHER_BUILDABLE", "其他计容"),
    ("room_info", "usage_category", "COMMUNITY", "社区配套"),
    ("room_info", "usage_category", "OTHER_PUBLIC", "其他公建"),
    ("room_info", "usage_category", "UNKNOWN", "未知"),
    ("room_info", "floor_area_type", "BUILDABLE", "计容"),
    ("room_info", "floor_area_type", "NON_BUILDABLE", "非计容"),
    ("room_info", "floor_area_type", "UNKNOWN", "未知"),
]


def qn_table(table: str) -> str:
    return f"{DB}.{table}@{SOURCE}"


def qn_col(table: str, col: str) -> str:
    return f"{DB}.{table}.{col}@{SOURCE}"


def map_type(raw: str) -> str:
    u = raw.upper().strip()
    for pat, name in TYPE_MAP:
        if re.match(pat, u):
            return name
    return raw.split("(")[0].lower()


def parse_sql(text: str) -> list[dict]:
    tables: list[dict] = []
    pattern = re.compile(
        r"CREATE TABLE `([^`]+)`\s*\((.*?)\)\s*ENGINE=InnoDB.*?COMMENT='([^']*)'",
        re.S,
    )
    for table, body, table_comment in pattern.findall(text):
        pk: set[str] = set()
        pk_m = re.search(r"PRIMARY KEY \(([^)]+)\)", body)
        if pk_m:
            pk = {p.strip().strip("`") for p in pk_m.group(1).split(",")}
        columns: list[dict] = []
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            col_m = re.match(
                r"`([^`]+)`\s+(\S+(?:\([^)]+\))?)\s+.*COMMENT '([^']*)'",
                line,
            )
            if not col_m:
                continue
            name, typ, comment = col_m.groups()
            if (table, name) in SKIP_COLUMNS:
                continue
            columns.append(
                {
                    "name": name,
                    "valueType": map_type(typ),
                    "comment": comment,
                    "isPrimaryKey": name in pk,
                    "isForeignKey": "逻辑外键" in comment,
                }
            )
        tables.append({"name": table, "comment": table_comment, "columns": columns})
    return tables


def short_desc(comment: str) -> str:
    part = comment.split("。")[0].split("，")[0].strip()
    return part[:64] if part else comment[:64]


def build(tables: list[dict]) -> dict:
    entities: list[dict] = []
    relationships: list[dict] = []
    table_names = {t["name"] for t in tables}

    for t in tables:
        name = t["name"]
        col_desc = "; ".join(f"{c['name']}({c['valueType']}): {short_desc(c['comment'])}" for c in t["columns"])
        llm = TABLE_LLM.get(name, t["comment"])
        entities.append(
            {
                "typeName": "data_table",
                "attributes": {
                    "qualifiedName": qn_table(name),
                    "tableId": f"{DB}.{name}",
                    "name": name,
                    "databaseName": DB,
                    "schemaName": DB,
                    "tableName": name,
                    "tableNameEn": name,
                    "sourceType": SOURCE,
                    "tableNameCh": short_desc(t["comment"]),
                    "tableDescription": t["comment"],
                    "llmContext": llm,
                    "layer": "DWD",
                    "entityType": "PhysicalTable",
                    "columnDescriptions": col_desc,
                    "status": "Active",
                },
            }
        )
        for c in t["columns"]:
            entities.append(
                {
                    "typeName": "data_column",
                    "attributes": {
                        "qualifiedName": qn_col(name, c["name"]),
                        "tableId": f"{DB}.{name}",
                        "dbNameEn": DB,
                        "name": c["name"],
                        "tableNameEn": name,
                        "columnNameEn": c["name"],
                        "valueType": c["valueType"],
                        "isPrimaryKey": c["isPrimaryKey"],
                        "isForeignKey": c["isForeignKey"],
                        "columnDescription": c["comment"],
                        "columnDescriptionShort": short_desc(c["comment"]),
                        "columnNameDesc": short_desc(c["comment"]),
                        "llmContext": c["comment"],
                        "status": "Active",
                    },
                }
            )
            relationships.append(
                {
                    "typeName": "table_has_column",
                    "end1": {
                        "typeName": "data_column",
                        "uniqueAttributes": {"qualifiedName": qn_col(name, c["name"])},
                    },
                    "end2": {
                        "typeName": "data_table",
                        "uniqueAttributes": {"qualifiedName": qn_table(name)},
                    },
                }
            )

    for src_t, src_c, tgt_t, tgt_c, join_type, card, intent in JOINS:
        if src_t not in table_names or tgt_t not in table_names:
            continue
        expr = f"{{source}}.{src_c} = {{target}}.{tgt_c}"
        relationships.append(
            {
                "typeName": "table_join_relationship",
                "end1": {"typeName": "data_table", "uniqueAttributes": {"qualifiedName": qn_table(src_t)}},
                "end2": {"typeName": "data_table", "uniqueAttributes": {"qualifiedName": qn_table(tgt_t)}},
                "attributes": {
                    "join_type": join_type,
                    "expression": expr,
                    "cardinality": card,
                    "intent": intent,
                },
            }
        )
        relationships.append(
            {
                "typeName": "column_join_relationship",
                "end1": {
                    "typeName": "data_column",
                    "uniqueAttributes": {"qualifiedName": qn_col(src_t, src_c)},
                },
                "end2": {
                    "typeName": "data_column",
                    "uniqueAttributes": {"qualifiedName": qn_col(tgt_t, tgt_c)},
                },
                "attributes": {
                    "join_type": join_type.replace(" ", "_"),
                    "expression": expr,
                    "intent": intent,
                },
            }
        )

    relationships.append(
        {
            "typeName": "table_join_relationship",
            "end1": {"typeName": "data_table", "uniqueAttributes": {"qualifiedName": qn_table("room_info")}},
            "end2": {"typeName": "data_table", "uniqueAttributes": {"qualifiedName": qn_table("ref_enum")}},
            "attributes": {
                "join_type": "LEFT JOIN",
                "expression": "{source}.usage_category = {target}.enum_code AND {target}.enum_group = 'usage_category'",
                "cardinality": "N:1",
                "intent": "房间用途代码翻译为中文；必须带 enum_group='usage_category'",
            },
        }
    )

    for table, col, code, label in ENUM_VALUES:
        qn = f"{DB}.{table}.{col}.value.{code}@{SOURCE}"
        entities.append(
            {
                "typeName": "data_column_value",
                "attributes": {
                    "qualifiedName": qn,
                    "value": code,
                    "description": f"{label}（库内存代码 {code}，中文为{label}）",
                    "columnNameEn": col,
                    "tableNameEn": table,
                    "dbNameEn": DB,
                    "valueType": "enum",
                    "status": "Active",
                },
            }
        )
        relationships.append(
            {
                "typeName": "column_has_value",
                "end1": {
                    "typeName": "data_column",
                    "uniqueAttributes": {"qualifiedName": qn_col(table, col)},
                },
                "end2": {"typeName": "data_column_value", "uniqueAttributes": {"qualifiedName": qn}},
            }
        )

    sql_shots = [
        {
            "sqlId": "landcheck_zhigu_rooms",
            "query": "智谷项目有多少房间、建筑面积多少",
            "intent": "按项目名模糊匹配后汇总房间数与建筑面积，必须过滤软删除",
            "expression": (
                "SELECT p.project_name, COUNT(*) AS rooms, ROUND(SUM(r.building_area), 2) AS area "
                "FROM room_info r JOIN project p ON p.id = r.project_id "
                "WHERE r.is_deleted = 0 AND p.is_deleted = 0 AND p.project_name LIKE '%智谷%' "
                "GROUP BY p.project_name"
            ),
            "relatedTables": ["room_info", "project"],
        },
        {
            "sqlId": "landcheck_usage_stats",
            "query": "按用途和计容类型统计房间数和建筑面积",
            "intent": "用途用 usage_category，中文标签 LEFT JOIN ref_enum",
            "expression": (
                "SELECT r.usage_category, e.enum_label, r.floor_area_type, COUNT(*) AS rooms, "
                "ROUND(SUM(r.building_area), 2) AS area FROM room_info r "
                "LEFT JOIN ref_enum e ON e.enum_group = 'usage_category' AND e.enum_code = r.usage_category "
                "WHERE r.is_deleted = 0 "
                "GROUP BY r.usage_category, e.enum_label, r.floor_area_type ORDER BY rooms DESC"
            ),
            "relatedTables": ["room_info", "ref_enum"],
        },
        {
            "sqlId": "landcheck_project_rooms_surveys_subquery",
            "query": "各项目房间数、测绘报告数、建筑面积排名",
            "intent": "项目级同时统计房间和测绘报告必须用相关子查询，禁止 room_info 与 survey_report_info 只按 project_id JOIN",
            "expression": (
                "SELECT p.project_name, "
                "(SELECT COUNT(*) FROM room_info r WHERE r.project_id = p.id AND r.is_deleted = 0) AS rooms, "
                "(SELECT COUNT(*) FROM survey_report_info s WHERE s.project_id = p.id AND s.is_deleted = 0) AS surveys, "
                "(SELECT ROUND(SUM(building_area), 2) FROM room_info r WHERE r.project_id = p.id AND r.is_deleted = 0) AS area "
                "FROM project p WHERE p.is_deleted = 0 ORDER BY rooms DESC LIMIT 10"
            ),
            "relatedTables": ["project", "room_info", "survey_report_info"],
        },
        {
            "sqlId": "landcheck_buildable_area",
            "query": "各项目计容面积是多少",
            "intent": "计容优先汇总 survey_report_info.total_buildable_area，不要用 contract_info.total_area",
            "expression": (
                "SELECT p.project_name, ROUND(SUM(s.total_buildable_area), 2) AS buildable_area "
                "FROM survey_report_info s JOIN project p ON p.id = s.project_id "
                "WHERE s.is_deleted = 0 AND p.is_deleted = 0 "
                "GROUP BY p.project_name ORDER BY buildable_area DESC"
            ),
            "relatedTables": ["survey_report_info", "project"],
        },
    ]
    for shot in sql_shots:
        entities.append(
            {
                "typeName": "sql_process",
                "attributes": {
                    "qualifiedName": f"sql.{shot['sqlId']}@{SOURCE}",
                    "sqlId": shot["sqlId"],
                    "name": shot["sqlId"],
                    "expression": shot["expression"],
                    "intent": shot["intent"],
                    "query": shot["query"],
                    "relatedTables": shot["relatedTables"],
                    "relatedTableIds": [qn_table(t) for t in shot["relatedTables"]],
                    "status": "Active",
                },
            }
        )

    entities.append(
        {
            "typeName": "metric_group",
            "attributes": {
                "qualifiedName": "survey",
                "name": "测绘核对指标",
                "groupCode": "survey",
                "groupPath": "/测绘核对",
                "level": 0,
                "domain": "landcheck",
                "description": "房产测绘核对常用指标",
                "llmContext": "房间数、建筑面积、计容面积等测绘核对指标",
                "status": "Active",
            },
        }
    )
    metrics = [
        {
            "code": "room_count",
            "name": "房间数",
            "formula": "COUNT(*)",
            "sql": "SELECT COUNT(*) FROM room_info WHERE is_deleted = 0",
            "unit": "间",
            "synonyms": ["房间数量", "户数"],
            "desc": "有效房间行数，必须 is_deleted=0",
            "table": "room_info",
        },
        {
            "code": "building_area_sum",
            "name": "建筑面积",
            "formula": "SUM(building_area)",
            "sql": "SELECT SUM(building_area) FROM room_info WHERE is_deleted = 0",
            "unit": "m²",
            "synonyms": ["建筑面积合计", "实测建筑面积"],
            "desc": "房间建筑面积合计，列是 room_info.building_area",
            "table": "room_info",
        },
        {
            "code": "buildable_area",
            "name": "计容面积",
            "formula": "SUM(total_buildable_area) 或 SUM(building_area) WHERE floor_area_type='BUILDABLE'",
            "sql": "SELECT SUM(total_buildable_area) FROM survey_report_info WHERE is_deleted = 0",
            "unit": "m²",
            "synonyms": ["计容", "计容积率面积"],
            "desc": "计容优先用测绘报告 total_buildable_area，房间侧用 floor_area_type='BUILDABLE'",
            "table": "survey_report_info",
        },
    ]
    for m in metrics:
        entities.append(
            {
                "typeName": "metric_instance",
                "attributes": {
                    "qualifiedName": m["code"],
                    "name": m["name"],
                    "instanceCode": m["code"],
                    "metricName": m["name"],
                    "metricCode": m["code"],
                    "subjectEntity": "room",
                    "aggregationType": "SUM" if "SUM" in m["formula"] else "COUNT",
                    "calculationFormula": m["formula"],
                    "sqlSnippet": m["sql"],
                    "unit": m["unit"],
                    "synonyms": m["synonyms"],
                    "description": m["desc"],
                    "dataType": "DECIMAL",
                    "llmContext": m["desc"],
                    "status": "Active",
                },
            }
        )
        relationships.append(
            {
                "typeName": "metric_instance_belongs_group",
                "end1": {"typeName": "metric_group", "uniqueAttributes": {"qualifiedName": "survey"}},
                "end2": {"typeName": "metric_instance", "uniqueAttributes": {"qualifiedName": m["code"]}},
            }
        )
        relationships.append(
            {
                "typeName": "metric_instance_realized_in_table",
                "end1": {"typeName": "metric_instance", "uniqueAttributes": {"qualifiedName": m["code"]}},
                "end2": {"typeName": "data_table", "uniqueAttributes": {"qualifiedName": qn_table(m["table"])}},
            }
        )

    terms = [
        ("buildable", "计容", ["计容积率", "计容面积"], "计容对应 floor_area_type=BUILDABLE 或 survey_report_info.total_buildable_area，不要用 contract_info.total_area。"),
        ("building_area", "建筑面积", ["建面"], "建筑面积对应 room_info.building_area。"),
        ("usage", "用途", ["房屋用途", "使用功能"], "统计用途用 room_info.usage_category，不要用常为空的 room_usage；中文查 ref_enum。"),
    ]
    for code, name, syn, ctx in terms:
        entities.append(
            {
                "typeName": "semantic_term",
                "attributes": {
                    "qualifiedName": f"term.{code}@landcheck",
                    "name": name,
                    "domain": "landcheck",
                    "synonyms": syn,
                    "llmContext": ctx,
                    "status": "Active",
                },
            }
        )

    return {"entities": entities, "relationships": relationships}


def main() -> None:
    tables = parse_sql(SQL_PATH.read_text(encoding="utf-8"))
    if not tables:
        raise SystemExit(f"no tables parsed from {SQL_PATH}")
    payload = build(tables)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    n_table = sum(1 for e in payload["entities"] if e["typeName"] == "data_table")
    n_col = sum(1 for e in payload["entities"] if e["typeName"] == "data_column")
    print(f"wrote {OUT_PATH} tables={n_table} columns={n_col} entities={len(payload['entities'])} rels={len(payload['relationships'])}")


if __name__ == "__main__":
    main()
