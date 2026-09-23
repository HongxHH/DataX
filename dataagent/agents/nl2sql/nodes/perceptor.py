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
import asyncio
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import httpx

from dataagent.actions.tools.semantic_tool.semantic_client import SemanticServiceClient, SemanticServiceError
from dataagent.agents.nl2sql.errors import SchemaNotFoundError, SemanticServiceCallError
from dataagent.agents.nl2sql.nodes.base_nl2sql_node import BaseNL2SQLNode
from dataagent.agents.nl2sql.utils.nl2sql_utils import (
    iter_semantic_column_payloads,
    schema_to_ddl,
)
from dataagent.agents.nl2sql.workflow.state import NL2SQLState
from dataagent.core.managers.prompt_manager import PromptTemplate
from dataagent.utils.constants import (
    DEFAULT_NL2SQL_SCHEMA_TOP_K,
    DEFAULT_NL2SQL_SEMANTIC_JOINABLE_TABLES_LIMIT,
    DEFAULT_NL2SQL_SEMANTIC_TABLE_COLUMNS_LIMIT,
    DEFAULT_NL2SQL_SEMANTIC_TABLE_LIST_LIMIT,
    NL2SQL_PROMPT_PREFIX,
)
from dataagent.utils.log import logger

_SCHEMA_MODE_FULL = "full_schema"
_SCHEMA_MODE_LINKING = "schema_linking"
_SUPPORTED_SCHEMA_MODES = (_SCHEMA_MODE_FULL, _SCHEMA_MODE_LINKING)


class PerceptorNode(BaseNL2SQLNode):
    def __init__(self, **kwargs):
        super().__init__(name="perceptor", **kwargs)
        self._semantic_client: SemanticServiceClient | None = None  # noqa: UP045
        self.top_k = kwargs.get("top_k", DEFAULT_NL2SQL_SCHEMA_TOP_K)
        self.schema_mode = kwargs.get("schema_mode", _SCHEMA_MODE_FULL)
        if self.schema_mode not in _SUPPORTED_SCHEMA_MODES:
            allowed_values = ", ".join(_SUPPORTED_SCHEMA_MODES)
            raise ValueError(
                f"Invalid CORE.perceptor.schema_mode {self.schema_mode!r}; allowed values: {allowed_values}"
            )
        self.user_schema = kwargs.pop("user_schema", None)
        self.user_evidence = kwargs.pop("user_evidence", None)
        self.user_sql_rules = kwargs.pop("user_sql_rules", None)
        self.user_few_shot_examples = kwargs.pop("user_few_shot_examples", None)

    @property
    def semantic_client(self) -> SemanticServiceClient:
        """Lazily build the semantic-layer client from agent config."""
        if self._semantic_client is None:
            try:
                self._semantic_client = SemanticServiceClient.from_config(self._config_manager)
            except (AttributeError, ValueError) as exc:
                raise SemanticServiceCallError(detail=str(exc)) from exc
        return self._semantic_client

    def schema_linking(self, keywords: list[str] | None) -> tuple[dict, list[tuple[str, str]]]:
        """Retrieve the schema and joins relevant to semantic search keywords."""
        if not keywords:
            return {}, []
        column_tables: set[str] = set()
        raw = self._call_semantic_service(self.semantic_client.semantic_search_columns, self.db, keywords, self.top_k)
        for payload in iter_semantic_column_payloads(raw):
            for entry in payload.get("column_name_search") or []:
                if not isinstance(entry, dict) or not entry:
                    continue
                parts = next(iter(entry)).split(".")
                if len(parts) != 3:
                    logger.warning(f"Perceptor: malformed column_name_search entry (expected d.t.c): {entry}")
                    continue
                d, t, _c = parts
                column_tables.add(f"{d}.{t}")
        dt_desc = self._table_descriptions()
        # joinable-tables 只返回「入参表集合内部」的边。只传列检索命中表时，
        # 父表不在集合里，接口会给空数组。所以先问全库 join 图，再按命中表扩 1-hop。
        joins_raw = self._get_joinable_tables(list(dt_desc.keys()))
        dt_set = set(column_tables)
        for join_entry in joins_raw:
            table_ids = [table_id for table_id in self._join_table_ids(join_entry) if table_id in dt_desc]
            if any(table_id in column_tables for table_id in table_ids):
                dt_set.update(table_ids)
        schema = self._schema_for_tables(dt_set, dt_desc)
        column_table_names = {dt.split(".", 1)[1] for dt in column_tables if "." in dt}
        recalled_tables = {dt.split(".", 1)[1] for dt in dt_set if "." in dt}
        j_set: set[tuple[str, str]] = set()
        for join_entry in joins_raw:
            pair = self._join_column_pair(join_entry)
            if pair is None:
                continue
            src, tgt = pair
            if src.split(".", 1)[0] in recalled_tables and tgt.split(".", 1)[0] in recalled_tables:
                j_set.add((src, tgt))
        logger.info(
            "NL2SQL schema_linking column_tables={} expanded_tables={}",
            sorted(column_table_names),
            sorted(recalled_tables),
        )
        return schema, sorted(j_set)

    def full_schema(self, allow_tables: list[str] | None = None) -> tuple[dict, list[tuple[str, str]]]:
        """Retrieve the complete schema and joins, optionally limited to selected tables."""
        allow_set = {str(t).strip() for t in (allow_tables or []) if str(t).strip()} or None
        allow_names = {t.split(".", 1)[1] if "." in t else t for t in allow_set} if allow_set else None
        dt_desc = {}
        for dt, description in self._table_descriptions().items():
            table_name = dt.split(".", 1)[1] if "." in dt else dt
            if allow_set and dt not in allow_set and table_name not in allow_names:
                continue
            dt_desc[dt] = description
        schema = self._schema_for_tables(dt_desc.keys(), dt_desc)
        j_set: set[tuple[str, str]] = set()
        for j in self._get_joinable_tables(list(dt_desc.keys())):
            pair = self._join_column_pair(j)
            if pair is not None:
                j_set.add(pair)
        return schema, sorted(j_set)

    def _table_descriptions(self) -> dict[str, str]:
        dt_desc: dict[str, str] = {}
        for item in self._get_table_list():
            if not isinstance(item, dict) or not item:
                continue
            dt, meta = next(iter(item.items()))
            dt_desc[dt] = (meta or {}).get("table_description", "")
        return dt_desc

    def _schema_for_tables(self, table_ids: Iterable[str], dt_desc: dict[str, str]) -> dict:
        schema: dict = {}
        for dt in table_ids:
            if "." not in dt:
                logger.warning(f"Perceptor: malformed table id (expected d.t): {dt}")
                continue
            t = dt.split(".", 1)[1]
            columns = {}
            schema[t] = {"description": dt_desc.get(dt, ""), "columns": columns}
            for dtc, meta in self._get_table_columns_info(dt).items():
                parts = dtc.split(".", 2)
                if len(parts) != 3:
                    logger.warning(f"Perceptor: malformed column id (expected d.t.c): {dtc}")
                    continue
                columns[parts[2]] = {
                    "description": meta.get("column_short_description", ""),
                    "value_type": meta.get("value_type", ""),
                    "example_values": meta.get("value_description", ""),
                }
        return schema

    def _join_column_pair(self, join_entry) -> tuple[str, str] | None:
        try:
            src = join_entry.get("src", "").split(".", 1)[1]
            tgt = join_entry.get("target_column", [])[0].split(".", 1)[1]
        except (AttributeError, IndexError, TypeError, ValueError) as exc:
            logger.warning(f"Perceptor: malformed joinable_table entry {join_entry}: {exc}")
            return None
        return src, tgt

    def _join_table_ids(self, join_entry) -> list[str]:
        """Return qualified db.table ids referenced by one joinable-tables entry."""
        try:
            src = str(join_entry.get("src") or "")
            targets = join_entry.get("target_column") or []
        except (AttributeError, TypeError):
            return []
        table_ids: list[str] = []
        for column_id in (src, *targets):
            parts = str(column_id).split(".")
            if len(parts) != 3:
                continue
            table_ids.append(f"{parts[0]}.{parts[1]}")
        return table_ids

    def _call_semantic_service(self, func, *args, **kwargs):
        try:
            return func(*args, **kwargs)
        except SemanticServiceError as exc:
            raise SemanticServiceCallError(detail=self._semantic_service_error_detail(exc)) from exc
        except httpx.HTTPError as exc:
            raise SemanticServiceCallError(detail=str(exc)) from exc
        except ValueError as exc:
            raise SemanticServiceCallError(detail=str(exc)) from exc

    async def _aprocess(self, state: NL2SQLState, runtime: Any = None) -> NL2SQLState:
        _ = runtime
        for attr, key in [
            ("schema_str", self.user_schema),
            ("evidence", self.user_evidence),
            ("sql_rules", self.user_sql_rules),
            ("few_shot_examples", self.user_few_shot_examples),
        ]:
            state[attr] = await asyncio.to_thread(self._load_prompt, key)
        if not state.get("schema_str", "").strip():
            logger.debug("NL2SQL Perceptor using schema_mode={}", self.schema_mode)
            if self.schema_mode == _SCHEMA_MODE_LINKING:
                question = state.get("question", "").strip()
                schema, joins = await asyncio.to_thread(self.schema_linking, [question] if question else [])
                if not schema:
                    raise SchemaNotFoundError(detail=f"schema_mode={self.schema_mode}")
            else:
                schema, joins = await asyncio.to_thread(self.full_schema)
            state["schema"] = schema
            state["joins"] = joins
            state["schema_str"] = schema_to_ddl(schema, joins)
        message = f"=== Perceptor ===\n{state.get('schema_str', '')}"
        logger.info(message)
        state["stream_message"] = message
        return state

    def _load_prompt(self, name: str | None) -> str:
        """Load a user-supplied prompt file by name.

        Resolution order:
        1. If ``name`` is an existing file path → read it directly.
        2. If ``WORKSPACE.path`` is configured → look for ``<workspace>/<name>``;
           if found, read it.
        3. Fall back to the package-bundled prompt at
           ``nl2sql/prompts/user/<name>`` (via :class:`PromptTemplate`).

        This fallback prevents ``FileNotFoundError`` when the referenced prompt
        file exists in the package but has not been copied to the workspace.
        """
        if not name:
            return ""
        name = name if name.endswith(".md") else f"{name}.md"
        prompt_path = Path(name) if Path(name).is_file() else None
        if prompt_path is not None:
            logger.info(f"nl2sql load prompt (absolute): {prompt_path}")
            return prompt_path.read_text(encoding="utf-8")
        workspace = self._get_agent_config("WORKSPACE.path")
        if workspace:
            ws_path = Path(workspace) / name
            if ws_path.is_file():
                logger.info(f"nl2sql load prompt (workspace): {ws_path}")
                return ws_path.read_text(encoding="utf-8")
        logger.info(f"nl2sql load prompt (package fallback): {name}")
        return PromptTemplate.from_package_relative(f"{NL2SQL_PROMPT_PREFIX}/user/{name}").content

    def _get_table_list(self) -> list:
        return self._call_semantic_service(
            self.semantic_client.get_table_list, self.db, limit=DEFAULT_NL2SQL_SEMANTIC_TABLE_LIST_LIMIT
        )

    def _get_table_columns_info(self, table_name: str) -> dict:
        return self._call_semantic_service(
            self.semantic_client.get_table_columns_info,
            table_name,
            limit=DEFAULT_NL2SQL_SEMANTIC_TABLE_COLUMNS_LIMIT,
        )

    def _get_joinable_tables(self, table_names: list[str]) -> list:
        return self._call_semantic_service(
            self.semantic_client.get_joinable_tables,
            table_names,
            limit=DEFAULT_NL2SQL_SEMANTIC_JOINABLE_TABLES_LIMIT,
        )

    async def _keyword_extraction(self, question: str) -> list[str]:
        context = {"question": question}
        res = await self.execute_with_llm_json(context, action="keyword_extraction_")
        return res["keywords"]

    def _semantic_service_error_detail(self, exc: SemanticServiceError) -> str:
        parts = [f"method={exc.method}", f"path={exc.path}", f"status_code={exc.status_code}"]
        if exc.error_code:
            parts.append(f"error_code={exc.error_code}")
        if exc.error_message:
            parts.append(f"error_message={exc.error_message}")
        return ", ".join(parts)
