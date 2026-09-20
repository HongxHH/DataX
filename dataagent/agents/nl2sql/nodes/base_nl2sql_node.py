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
from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from dataagent.agents.nl2sql.errors import LLMOutputParseError
from dataagent.agents.nl2sql.utils.nl2sql_utils import json_parser
from dataagent.core.cbb.base_node import BaseNode
from dataagent.core.managers.llm_manager import llm_manager
from dataagent.core.managers.prompt_manager import PromptTemplate
from dataagent.utils.constants import NL2SQL_PROMPT_PREFIX, TZ_CN
from dataagent.utils.env_utils import get_env_bool
from dataagent.utils.log import logger

_TYPE_LABELS = {
    SystemMessage: "SYSTEM",
    HumanMessage: "HUMAN",
    AIMessage: "AI",
    ToolMessage: "TOOL",
}

DA_THINK = "DA_THINK"
DA_DRAFT = "DA_DRAFT"
_MAX_DA_DELTA = 512


def _encode_da_delta(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("\r", "\\r")
        .replace("\n", "\\n")
        .replace("\t", "\\t")
    )


def _write_nl2sql_stream_progress(payload: dict[str, Any]) -> None:
    """Best-effort LangGraph custom event; no-op outside a streaming node."""
    try:
        from dataagent.core.framework_adapters.runtime.context import get_stream_writer

        get_stream_writer()(payload)
    except Exception:
        # HAZARD: 吞掉所有异常（含 writer 缺失）。若需区分配置错误与「非流式节点」，
        # 应收窄为 LookupError / RuntimeError，并至少 logger.debug 一次。
        return


def emit_nl2sql_progress(kind: str, node: str, delta: str) -> None:
    """Write DA_* lines to stderr and, when available, LangGraph custom events.

    Copilot sub-agents parse stderr; in-process workbench consumes custom events.
    """
    text = str(delta or "")
    if not text or kind not in {DA_THINK, DA_DRAFT}:
        return
    node_name = str(node or "nl2sql").replace("\t", " ").replace("\n", " ")
    start = 0
    while start < len(text):
        piece = text[start : start + _MAX_DA_DELTA]
        start += _MAX_DA_DELTA
        sys.stderr.write(f"{kind}\t{node_name}\t{_encode_da_delta(piece)}\n")
        _write_nl2sql_stream_progress(
            {
                "type": "nl2sql_progress",
                "kind": kind,
                "node": node_name,
                "delta": piece,
            }
        )
    sys.stderr.flush()


class BaseNL2SQLNode(BaseNode):
    def __init__(self, name: str, config_manager: Any | None = None, **kwargs: Any) -> None:
        """Initialize NL2SQL node with optional per-Agent ConfigManager.

        Args:
            name: Node name for prompts and routing.
            config_manager: Per-Agent configuration; required for DATABASE/SEMANTIC_LAYER reads.
            **kwargs: Remaining node-specific options (passed to :class:`BaseNode`).
        """
        super().__init__(name=name, **kwargs)
        self._config_manager = config_manager
        self._nl2sql_context_dump_dir: Path | None = None
        self._context_dump_seq: list[int] = [0]
        self._context_dump_enabled: bool = get_env_bool("DATAAGENT_CONTEXT_DUMP")

    @property
    def db(self):
        """Return the configured DATABASE.db_id."""
        return self._get_agent_config("DATABASE.db_id", "")

    @property
    def dialect(self):
        """Return the configured DATABASE.dialect (default sqlite)."""
        return self._get_agent_config("DATABASE.dialect", "sqlite")

    @property
    def engine(self):
        """Return DATABASE.engine, falling back to dialect."""
        return self._get_agent_config("DATABASE.engine") or self.dialect

    def set_context_dump_dir(self, dump_dir: Any | None) -> None:
        """Set or clear this node's NL2SQL context-dump directory."""
        if dump_dir is not None:
            self._nl2sql_context_dump_dir = Path(dump_dir)
        else:
            self._nl2sql_context_dump_dir = None

    async def execute_with_llm(self, context: dict[str, str], action: str = "") -> str:
        """Render the node prompts and asynchronously invoke the configured LLM."""
        system_prompt = PromptTemplate.from_package_relative(
            f"{NL2SQL_PROMPT_PREFIX}/{self.name}/{action}system"
        ).content
        user_prompt = PromptTemplate.from_package_relative(
            f"{NL2SQL_PROMPT_PREFIX}/{self.name}/{action}user"
        ).apply_prompt_template(**context)
        prompts = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        content = await self._stream_llm(prompts, emit_draft=False)
        self._dump_llm_context(system_prompt, user_prompt, content, self.name, action)
        return content

    async def _stream_llm(self, prompts: list[dict[str, str]], *, emit_draft: bool) -> str:
        """Stream LLM output, emitting DA_THINK (and optional DA_DRAFT) to stderr."""
        llm = llm_manager.get_default_llm()
        astream = getattr(llm, "astream", None)
        if callable(astream):
            try:
                return await self._consume_llm_stream(astream, prompts, emit_draft=emit_draft)
            except Exception as exc:
                logger.warning(f"NL2SQL LLM stream failed, fallback to ainvoke: {exc}")
        return await self._invoke_llm(llm, prompts, emit_draft=emit_draft)

    async def _consume_llm_stream(self, astream: Any, prompts: list[dict[str, str]], *, emit_draft: bool) -> str:
        content_parts: list[str] = []
        async for chunk in astream(prompts):
            final = getattr(chunk, "final_response", None)
            if getattr(chunk, "done", False) and final is not None:
                if content_parts:
                    break
                content = str(getattr(final, "content", "") or "")
                reasoning = str(getattr(final, "reasoning_content", "") or "")
                if reasoning:
                    emit_nl2sql_progress(DA_THINK, self.name, reasoning)
                if emit_draft and content:
                    emit_nl2sql_progress(DA_DRAFT, self.name, content)
                return content
            reasoning = str(getattr(chunk, "reasoning_content", "") or "")
            text = str(getattr(chunk, "content", "") or "")
            if reasoning:
                emit_nl2sql_progress(DA_THINK, self.name, reasoning)
            if text:
                content_parts.append(text)
                if emit_draft:
                    emit_nl2sql_progress(DA_DRAFT, self.name, text)
        return "".join(content_parts)

    async def _invoke_llm(self, llm: Any, prompts: list[dict[str, str]], *, emit_draft: bool) -> str:
        response = await llm.ainvoke(prompts)
        content = str(getattr(response, "content", "") or "")
        reasoning = str(getattr(response, "reasoning_content", "") or "")
        if reasoning:
            emit_nl2sql_progress(DA_THINK, self.name, reasoning)
        if emit_draft and content:
            emit_nl2sql_progress(DA_DRAFT, self.name, content)
        return content

    async def execute_with_llm_json(self, context: dict[str, str], action: str = "") -> Any:
        """Execute the LLM with the given context and action, returning parsed JSON output."""
        for attempt in range(3):
            try:
                return json.loads(json_parser(await self.execute_with_llm(context, action)))
            except (LLMOutputParseError, json.JSONDecodeError) as exc:
                if attempt == 2:
                    detail = exc.detail if isinstance(exc, LLMOutputParseError) and exc.detail else str(exc)
                    raise LLMOutputParseError(
                        message=f"Model output format error: JSON parsing failed after 3 attempts: {detail}",
                        detail=detail,
                    ) from exc
        return None

    def _dump_llm_context(self, system_prompt: str, user_prompt: str, result: str, node_name: str, action: str) -> None:
        """Persist the (system, user, AI) prompt triple to the node's context-dump file."""
        if not self._context_dump_enabled:
            return
        if self._nl2sql_context_dump_dir is None:
            return
        try:
            self._context_dump_seq[0] += 1
            seq = self._context_dump_seq[0]
            label = f"{node_name}_{action}" if action else node_name
            dump_file = self._nl2sql_context_dump_dir / f"{seq:02d}_round_{label}.txt"
            separator = "=" * 80
            ts = datetime.now(tz=TZ_CN).strftime("%Y-%m-%d %H:%M:%S")
            with dump_file.open("w", encoding="utf-8") as f:
                f.write(f"{separator}\n")
                f.write(f"  NL2SQL Prompt Dump  |  {ts}  |  node: {label}\n")
                f.write(f"{separator}\n\n")
                f.write("--- [0] SYSTEM ---\n")
                f.write(f"{system_prompt}\n\n")
                f.write("--- [1] HUMAN ---\n")
                f.write(f"{user_prompt}\n\n")
                f.write("--- [2] AI ---\n")
                f.write(f"{result}\n\n")
                f.write(f"{separator}\n")
                f.write("  END OF DUMP\n")
                f.write(f"{separator}\n")
            logger.info(f"NL2SQL context dump saved: {seq:02d}_round_{label}.txt")
        except Exception as exc:
            self._context_dump_seq[0] -= 1
            logger.warning(f"Failed to dump NL2SQL context: {exc}")

    def _get_agent_config(self, key: str, default: Any = None) -> Any:
        """Read configuration from the bound per-Agent ConfigManager."""
        if self._config_manager is None:
            raise RuntimeError(
                f"NL2SQL node {self.name!r} has no config_manager; pass config_manager when constructing the node."
            )
        return self._config_manager.get(key, default)
