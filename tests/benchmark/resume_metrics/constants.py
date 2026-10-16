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
"""Frozen ids / prompts for resume metric cards v0.1."""

from __future__ import annotations

METRIC_CARD_VERSION = "v0.1"

# B1 case set from tests/benchmark/resume_metric_cards.md
B1_CASE_IDS: tuple[str, ...] = (
    "lc_zhigu_rooms_area",
    "lc_project_rooms_surveys_rank",
    "lc_project_rooms_surveys_rank_by_area",
    "lc_jasy_rooms_surveys",
    "lc_usage_category_stats",
    "lc_usage_and_floor_area_type",
    "lc_buildable_rooms_area",
    "lc_project_buildable_area",
    "lc_residential_rooms",
)

# C1 Job-path script (Q2 depends on Q1 project context).
REUSE_Q1 = "智谷项目有多少房间？"
REUSE_Q2 = "它的建筑面积一共多少？"

DEFAULT_REUSE_K = 5
DEFAULT_REUSE_WARMUP = 1
DEFAULT_REUSE_TIMEOUT_SEC = 300
