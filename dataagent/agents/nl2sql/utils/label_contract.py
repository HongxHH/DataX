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
"""Deterministic NL2SQL contracts that must not rely on LLM-as-judge alone."""

from __future__ import annotations

import re
from typing import Any

LABEL_SCHEMA_MISSING = "LABEL-001"
LABEL_CASE_INSTEAD_OF_JOIN = "LABEL-002"

_ENUM_LABEL_HINTS = ("中文", "标签", "含义", "枚举", "字典")
_ENUM_TABLE_RE = re.compile(r"(?i)\b(?:ref_enum|\w+_enum)\b")
_CASE_RE = re.compile(r"(?i)\bCASE\b")


def question_needs_enum_labels(question: str) -> bool:
    """True when the question asks for code labels / dictionary text, not just codes."""
    text = str(question or "")
    return any(hint in text for hint in _ENUM_LABEL_HINTS)


def schema_has_enum_lookup(schema: dict[str, Any] | None) -> bool:
    """True when linked schema includes an enum dictionary table."""
    for name in (schema or {}):
        table = str(name).lower()
        if table == "ref_enum" or table.endswith("_enum"):
            return True
    return False


def check_enum_label_contract(
    *,
    question: str,
    schema: dict[str, Any] | None,
    sql: str,
) -> list[str]:
    """Return blocking issues when Chinese labels are required but contract is violated.

    - LABEL-001: question needs labels but schema has no enum lookup table (cannot be
      fixed by rewriting SQL alone; linking must expand).
    - LABEL-002: enum table is present but SQL hard-codes CASE instead of JOINing it.
    """
    if not question_needs_enum_labels(question):
        return []
    if not schema_has_enum_lookup(schema):
        return [
            f"{LABEL_SCHEMA_MISSING}: Question asks for Chinese/enum labels but the "
            "linked schema has no enum lookup table (e.g. ref_enum). Do not invent "
            "CASE mappings; schema linking must include the dictionary table."
        ]
    text = sql or ""
    if _CASE_RE.search(text) and not _ENUM_TABLE_RE.search(text):
        return [
            f"{LABEL_CASE_INSTEAD_OF_JOIN}: Enum lookup table is in schema; JOIN it for "
            "Chinese labels instead of hard-coded CASE mappings."
        ]
    return []


def has_blocking_label_schema_issue(issues: list[Any] | None) -> bool:
    """True when LABEL-001 is present (schema gap, not a rewrite-only bug)."""
    for item in issues or []:
        if str(item).startswith(LABEL_SCHEMA_MISSING):
            return True
    return False
