# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
#
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
"""Per-turn thinking override for OpenAI-compatible ``thinking`` extra_body.

Shell chat can force ``enabled`` / ``disabled`` for the current request without
rewriting YAML. Parent process uses a ContextVar; subagent subprocesses inherit
via ``DATAAGENT_THINKING_TYPE`` in their env.
"""

from __future__ import annotations

import contextvars
import os
from collections.abc import MutableMapping
from typing import Any

THINKING_ENV = "DATAAGENT_THINKING_TYPE"
_VALID = frozenset({"enabled", "disabled"})

_turn_thinking: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "dataagent_turn_thinking",
    default=None,
)


def set_turn_thinking(enabled: bool) -> contextvars.Token[str | None]:
    """Bind this turn's thinking mode for the current async context."""
    return _turn_thinking.set("enabled" if enabled else "disabled")


def reset_turn_thinking(token: contextvars.Token[str | None]) -> None:
    """Restore the previous turn thinking binding."""
    _turn_thinking.reset(token)


def get_thinking_type() -> str | None:
    """Resolve override: ContextVar first, then subprocess env."""
    bound = _turn_thinking.get()
    if bound in _VALID:
        return bound
    env = str(os.environ.get(THINKING_ENV) or "").strip().lower()
    return env if env in _VALID else None


def inject_thinking_env(env: MutableMapping[str, str]) -> None:
    """Copy the current override into a child-process env mapping."""
    mode = get_thinking_type()
    if mode:
        env[THINKING_ENV] = mode


def apply_thinking_to_payload(payload: dict[str, Any]) -> None:
    """Mutate outbound chat payload so ``thinking.type`` matches the override."""
    mode = get_thinking_type()
    if not mode:
        return
    payload["thinking"] = {"type": mode}
