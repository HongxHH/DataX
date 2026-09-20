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
"""Subagent stderr status extraction — handler-based dispatch.

Each agent output format (ReAct emoji, NL2SQL bare-print, etc.) is
encapsulated in its own ``_AgentStatusHandler`` subclass.  The shared
``_extract_subagent_status`` function iterates registered handlers and
returns the first match, deduplicated.
"""

from __future__ import annotations

import json
import re
from typing import Any

from dataagent.core.utils.otel_event_recorder import OTEL_LIVE_STDERR_PREFIX

# ── Utilities ─────────────────────────────────────────────────────────────────

_RE_ANSI_ESCAPE = re.compile(r"\x1b(?:\[@[A-Z]|\[[0-9;?]*[A-Za-z]|\].*?\x07|\x1b)")
# 通用的 loguru 日志级别前缀（跨 agent 类型）
_RE_LOG_LEVEL = re.compile(r"(WARNING|ERROR|CRITICAL|TRACE)")
# loguru 默认行首：2026-08-23 15:42:00.123 | INFO     | subagent | ...
_RE_LOGURU_LINE = re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s*\|")
_MAX_STDERR_LINE_LEN = 2000


def _strip_ansi_codes(text: str) -> str:
    """Strip ANSI escape codes from text."""
    return _RE_ANSI_ESCAPE.sub("", text)


def _extract_log_level(line: str) -> str | None:
    """Fallback: 提取 loguru 日志级别前缀，适用所有 agent 类型。"""
    m = _RE_LOG_LEVEL.search(line)
    if m:
        level = m.group(1)
        body = line[m.end() :].strip()
        return f"[{level}] {body}"
    return None


def _extract_loguru_message(line: str) -> str:
    """Strip loguru timestamp/level/module prefix; return the logged message body."""
    if not line:
        return line
    if _RE_LOGURU_LINE.match(line) and " | " in line:
        return line.rsplit(" | ", 1)[-1].strip()
    return line


# 去重（跨 handler 共享）：同一 tool_call_id 上一次推送的状态文本
_subagent_last_status: dict[str, str] = {}


# ── Handler base class ────────────────────────────────────────────────────────


class _AgentStatusHandler:
    """Base handler for extracting status updates from subagent stderr output.

    Subclasses encapsulate their own regex patterns and per-tool-call state.
    """

    def try_extract(self, line: str, tool_call_id: str) -> str | None:
        """Try to extract a status text from *line*.

        Returns ``None`` when *line* is not recognised by this handler.
        """
        raise NotImplementedError

    def reset(self, tool_call_id: str) -> None:
        """Clean up per-tool-call state when the subprocess finishes."""
        pass

    def reset_all(self) -> None:
        """Clean up all per-tool-call state for this handler."""
        pass


# ── ReAct (FlexAgent) handler ─────────────────────────────────────────────────


class _ReActStatusHandler(_AgentStatusHandler):
    """FlexAgent (ReAct) — Rich-rendered emoji patterns in stderr."""

    _RE_TOOL_START = re.compile(r"(?:▶\s*)?调用工具")
    _RE_TOOL_DONE = re.compile(r"✅\s*([A-Za-z]\w*)\s+完成")
    _RE_TOOL_FAIL = re.compile(r"❌\s*(?:执行失败|(?:([A-Za-z]\w*)\s*)?工具执行失败)")
    _RE_THINKING_DONE = re.compile(r"思考完毕")

    def try_extract(self, line: str, tool_call_id: str) -> str | None:
        if self._RE_TOOL_START.search(line):
            return "正在调用工具"

        m = self._RE_TOOL_DONE.search(line)
        if m:
            return f"{m.group(1).strip()} 完成"

        m = self._RE_TOOL_FAIL.search(line)
        if m:
            tool_name = m.group(1) if m.lastindex and m.group(1) else ""
            return f"{tool_name} 执行失败" if tool_name else "执行失败"

        if self._RE_THINKING_DONE.search(line):
            return "思考完毕"

        return None


# ── NL2SQL (structured agent) handler ─────────────────────────────────────────


class _NL2SQLStatusHandler(_AgentStatusHandler):
    """Structured agent (NL2SQL) — ``=== NodeName ===`` markers in loguru stderr."""

    _NODE_NAMES = frozenset(
        {
            "Coordinator",
            "Perceptor",
            "Generator",
            "Validator",
            "Reflector",
            "Executor",
            "Selector",
            "Final Result",
        }
    )
    _RE_MORE_ROWS = re.compile(r"^\.\.\. and (\d+) more rows$")
    # 只保留有意义的行：JSON / SQL 关键字 / Score / 行预览等
    _RE_MEANINGFUL = re.compile(
        r"^(?:\{|\"|SELECT |INSERT |UPDATE |DELETE |CREATE |DROP |WITH |ALTER |"
        r"Score: |schema: |joins: |\[\(|\\d+ row|final_answer|sql|columns|rows)"
    )
    _MAX_CONTENT_LINES = 3

    # 每个 tool_call_id 的 node 上下文和行计数
    _node_context: dict[str, str] = {}
    _node_line_count: dict[str, int] = {}

    def try_extract(self, line: str, tool_call_id: str) -> str | None:
        line = line.strip()
        if not line:
            return None
        if "\n" in line:
            first_result: str | None = None
            for subline in line.splitlines():
                sub = subline.strip()
                if not sub:
                    continue
                part = self._try_extract_single(sub, tool_call_id)
                if part is not None and first_result is None:
                    first_result = part
            return first_result
        return self._try_extract_single(line, tool_call_id)

    def _try_extract_single(self, line: str, tool_call_id: str) -> str | None:
        if line.startswith("DA_THINK\t") or line.startswith("DA_DRAFT\t"):
            return line

        # === NodeName === 分隔符
        node_header = re.match(r"^===\s+(.+?)\s*===$", line)
        if node_header and node_header.group(1) in self._NODE_NAMES:
            self._node_context[tool_call_id] = node_header.group(1)
            self._node_line_count[tool_call_id] = 0
            return node_header.group(1)

        # ... and N more rows
        more = self._RE_MORE_ROWS.match(line)
        if more:
            node = self._node_context.get(tool_call_id, "")
            rest = f"... and {more.group(1)} more rows"
            return f"{node}: {rest}" if node else rest

        # 已有 node context：仅推送有意义的内容行，且限制行数
        if tool_call_id in self._node_context:
            if not self._RE_MEANINGFUL.match(line):
                return None
            count = self._node_line_count.get(tool_call_id, 0)
            if count >= self._MAX_CONTENT_LINES:
                return None
            self._node_line_count[tool_call_id] = count + 1
            node = self._node_context[tool_call_id]
            return f"{node}: {line}"

        return None

    def reset(self, tool_call_id: str) -> None:
        self._node_context.pop(tool_call_id, None)
        self._node_line_count.pop(tool_call_id, None)

    def reset_all(self) -> None:
        self._node_context.clear()
        self._node_line_count.clear()


# ── Registry ───────────────────────────────────────────────────────────────────

_subagent_handlers: list[_AgentStatusHandler] = [
    _NL2SQLStatusHandler(),  # 更具体的 handler 放前面
    _ReActStatusHandler(),
]


def parse_otel_live_line(text: str) -> dict[str, Any] | None:
    """Parse a compact live span line from sub-agent stderr. None if not a span."""
    raw = str(text or "").strip()
    body = ""
    if raw.startswith("DATAAGENT_OTEL\t"):
        body = raw.split("\t", 1)[1]
    elif raw.startswith(OTEL_LIVE_STDERR_PREFIX):
        body = raw[len(OTEL_LIVE_STDERR_PREFIX) :]
    else:
        return None
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def reset_subagent_status(tool_call_id: str) -> None:
    """清理指定 tool_call_id 的去重缓存和所有 handler 的 per-call 状态。

    由 ``_run_subprocess_async`` 的 ``finally`` 块调用。
    """
    _subagent_last_status.pop(tool_call_id, None)
    for handler in _subagent_handlers:
        handler.reset(tool_call_id)


def extract_subagent_status(line: str, tool_call_id: str, progress_callback: Any) -> None:
    """从子进程 stderr 中提取关键状态行（带去重）。

    遍历所有已注册的 ``_AgentStatusHandler``，首个匹配的 handler 返回状态文本。
    """
    if not progress_callback or not tool_call_id:
        return

    stripped = _strip_ansi_codes(line).strip()
    if not stripped:
        return

    normalized = _extract_loguru_message(stripped)
    if not normalized or len(normalized) > _MAX_STDERR_LINE_LEN:
        return

    otel = parse_otel_live_line(normalized)
    if otel is not None:
        progress_callback(
            tool_call_id,
            f"DATAAGENT_OTEL\t{json.dumps(otel, ensure_ascii=False, separators=(',', ':'))}",
        )
        return

    lines_to_process = normalized.splitlines() if "\n" in normalized else [normalized]

    text: str | None = None
    for part in lines_to_process:
        part = part.strip()
        if not part:
            continue
        for handler in _subagent_handlers:
            candidate = handler.try_extract(part, tool_call_id)
            if candidate is not None:
                text = candidate
                break
        if text is not None:
            break

    # Fallback: 通用日志级别检测（任意 agent 类型的 stderr 都可能输出）
    if text is None:
        text = _extract_log_level(normalized)

    if not text:
        return

    # DA_* 增量允许重复（空格/同一 token），阶段名仍去重。
    is_da_progress = text.startswith("DA_THINK\t") or text.startswith("DA_DRAFT\t")
    if not is_da_progress:
        if _subagent_last_status.get(tool_call_id) == text:
            return
        _subagent_last_status[tool_call_id] = text
    progress_callback(tool_call_id, text)
