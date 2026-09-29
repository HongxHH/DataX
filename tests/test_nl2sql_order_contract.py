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
from dataagent.agents.nl2sql.utils.order_contract import (
    ORDER_KEY_MISMATCH,
    check_order_by_contract,
    order_by_primary_tokens,
    ranking_metric_from_question,
)


def test_ranking_metric_requires_rank_cue():
    assert ranking_metric_from_question("按房间数统计") is None
    assert ranking_metric_from_question("各项目按房间数排名取前 10") == "房间数"
    assert ranking_metric_from_question("按建筑面积排名取前 10") == "建筑面积"


def test_order_by_tokens():
    assert "total_building_area" in order_by_primary_tokens(
        "SELECT * FROM t ORDER BY total_building_area DESC LIMIT 10"
    )
    assert "room_count" in order_by_primary_tokens("SELECT * FROM t ORDER BY room_count DESC, area ASC")


def test_order_contract_ok():
    issues = check_order_by_contract(
        question="各项目给出房间数和建筑面积，按房间数排名取前 10",
        sql="SELECT project_name, room_count, area FROM t ORDER BY room_count DESC LIMIT 10",
    )
    assert issues == []


def test_order_contract_mismatch():
    issues = check_order_by_contract(
        question="各项目给出房间数和建筑面积，按房间数排名取前 10",
        sql="SELECT project_name, room_count, area FROM t ORDER BY total_building_area DESC LIMIT 10",
    )
    assert any(i.startswith(ORDER_KEY_MISMATCH) for i in issues)


def test_order_contract_skips_ambiguous():
    issues = check_order_by_contract(
        question="各项目给出房间数、测绘报告数和建筑面积排名取前 10",
        sql="SELECT * FROM t ORDER BY total_building_area DESC LIMIT 10",
    )
    assert issues == []
