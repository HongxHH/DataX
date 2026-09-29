"""Map NL2SQL schema-contract refusals to user-facing Chinese."""

from __future__ import annotations

from typing import Any

SCHEMA_CONTRACT_USER_MESSAGE = "当前可用的数据表不足以正确回答该问题，请换个问法或联系管理员补全语义目录后再试。"

_CONTRACT_MARKERS = (
    "nl2sql-meta-003",
    "schemacontracterror",
    "当前 schema 不足以正确回答该问题",
    "linked schema is missing the enum lookup",
    "missing the enum lookup table",
)


def is_schema_contract_error(*parts: Any) -> bool:
    blob = " ".join(str(part or "") for part in parts).strip()
    if not blob:
        return False
    lowered = blob.lower()
    return any(marker in lowered for marker in _CONTRACT_MARKERS)


def schema_contract_user_message(*parts: Any) -> str | None:
    if not is_schema_contract_error(*parts):
        return None
    return SCHEMA_CONTRACT_USER_MESSAGE
