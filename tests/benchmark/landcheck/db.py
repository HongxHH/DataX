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
"""MySQL helpers for Landcheck L1 eval."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Any


@dataclass(frozen=True)
class MysqlSettings:
    host: str
    port: int
    user: str
    password: str
    database: str


def load_mysql_settings() -> MysqlSettings:
    """Load connection settings from env, with schema/README defaults."""
    return MysqlSettings(
        host=os.getenv("MYSQL_HOST", "127.0.0.1"),
        port=int(os.getenv("MYSQL_PORT", "3306")),
        user=os.getenv("MYSQL_USER", "root"),
        password=os.getenv("MYSQL_PASSWORD", "root"),
        database=os.getenv("MYSQL_DATABASE", "landcheck"),
    )


def execute_sql(sql: str, settings: MysqlSettings | None = None) -> tuple[list[str], list[list[Any]]]:
    """Run a read-only SQL and return (columns, rows) with JSON-friendly cells."""
    import pymysql

    cfg = settings or load_mysql_settings()
    conn = pymysql.connect(
        host=cfg.host,
        port=cfg.port,
        user=cfg.user,
        password=cfg.password,
        database=cfg.database,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.Cursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            columns = [str(d[0]) for d in (cur.description or [])]
            raw_rows = cur.fetchall() or []
            rows = [[_cell(v) for v in row] for row in raw_rows]
            return columns, rows
    finally:
        conn.close()


def _cell(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    return value
