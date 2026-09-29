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
from dataagent.agents.nl2sql.nodes.perceptor import enum_lookup_table_ids, enum_tables_reachable_from_hits
from dataagent.agents.nl2sql.security.rules import SENSITIVE_TABLE_NAMES
from dataagent.agents.nl2sql.utils.label_contract import question_needs_enum_labels


def test_question_needs_enum_labels_only_when_asked():
    assert question_needs_enum_labels("按用途统计房间数，给出用途代码和中文标签") is True
    assert question_needs_enum_labels("按用途和计容类型统计房间数和建筑面积") is False
    assert question_needs_enum_labels("住宅用途的房间有多少间") is False


def test_enum_lookup_table_ids_finds_ref_enum_not_sys_user():
    catalog = {
        "landcheck.room_info": "房间明细",
        "landcheck.ref_enum": "枚举字典表（代码→中文标签）",
        "landcheck.sys_user": "系统用户",
        "landcheck.usage_config": "用途匹配配置",
        "landcheck.code_dict": "业务字典：存库代码对应中文含义",
    }
    found = {tid.split(".", 1)[-1] for tid in enum_lookup_table_ids(catalog)}
    assert "ref_enum" in found
    assert "code_dict" in found
    assert "sys_user" not in found
    assert "usage_config" not in found
    assert "sys_user" in SENSITIVE_TABLE_NAMES


def test_enum_tables_reachable_from_hits_via_column_join():
    joins = [
        {
            "src": "landcheck.room_info.usage_category",
            "target_column": ["landcheck.ref_enum.enum_code"],
        }
    ]

    def _ids(join_entry):
        src = str(join_entry.get("src") or "")
        targets = join_entry.get("target_column") or []
        out: list[str] = []
        for column_id in (src, *targets):
            parts = str(column_id).split(".")
            if len(parts) == 3:
                out.append(f"{parts[0]}.{parts[1]}")
        return out

    hits = {"landcheck.room_info"}
    found = enum_tables_reachable_from_hits(hits, joins, _ids)
    assert found == {"landcheck.ref_enum"}
    assert enum_tables_reachable_from_hits(set(), joins, _ids) == set()
    assert enum_tables_reachable_from_hits({"landcheck.project"}, joins, _ids) == set()
