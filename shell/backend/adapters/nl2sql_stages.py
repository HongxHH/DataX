"""NL2SQL pipeline stage labels shared by the direct adapter and Copilot sub-agent bridge."""

from __future__ import annotations

# node name → (stage id, UI label)
NL2SQL_NODE_STAGES: dict[str, tuple[str, str]] = {
    "perceptor": ("perceiving", "正在读取表结构"),
    "generator": ("generating", "正在生成 SQL"),
    "validator": ("validating", "正在校验 SQL"),
    "reflector": ("validating", "正在反思优化"),
    "selector": ("validating", "正在选择最优 SQL"),
    "executor": ("executing", "正在执行查询"),
}

NL2SQL_STAGE_ORDER = ["perceiving", "generating", "validating", "executing"]
