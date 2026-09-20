"""Map NL2SQL SQL-security refusals to user-facing Chinese without echoing SQL."""

from __future__ import annotations

from typing import Any

SQL_SECURITY_USER_MESSAGE = "该查询被安全规则拦截，只允许只读 SELECT。请改问后再试。"

_SECURITY_MARKERS = (
    "nl2sql-sec-001",
    "blocked by sql security",
    "生成的 sql 未通过安全校验",
    "sqlsecurityvalidationerror",
    "only read-only select queries are allowed",
    "sql security rules",
)


def is_sql_security_error(*parts: Any) -> bool:
    blob = " ".join(str(part or "") for part in parts).strip()
    if not blob:
        return False
    lowered = blob.lower()
    return any(marker in lowered for marker in _SECURITY_MARKERS)


def sql_security_user_message(*parts: Any) -> str | None:
    """Return Chinese copy when the blob is a security block; never echo SQL."""
    if not is_sql_security_error(*parts):
        return None
    return SQL_SECURITY_USER_MESSAGE
