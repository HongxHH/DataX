# DataX UI Shell

本目录是 **DataX 的 Web 壳**。壳位于仓库 `shell/`，与内核 `dataagent/` 并列，不参与 pip 包打包。壳通过 SDK 调内核。默认产品入口是数据问数 Copilot：用户只对话，主 Agent 按问题委派 NL2SQL / 文档召回 / 画图 / 报告。仓库内置示例 Profile `landcheck-copilot`。

## 当前能力

- 统一 Copilot 入口（`landcheck-copilot`）
- 枢纽 DAG 展示本轮委派与产物；右侧产物栏可预览 / 新窗口打开
- 语义层筛表（`schema_linking`）+ 本地 BGE 嵌入
- 生成中可 **停止生成**；失败或取消会留下中文说明，不会停在「处理中」

## 尚未做

- 结果表一键导出 CSV
- 对外演示时隐藏顶栏 Profile；登录 / 权限
- Shell API 自动化测试与一键 docker-compose

## 架构

```text
浏览器 (:5173) → shell/backend (:8788) → DataAgent SDK → Semantic / MySQL / DataLink MCP
```

分层：

```text
shell/web          布局 + 组件（按 Profile 选 layout）
    ↕ SSE / REST
shell/backend      事件翻译 + 会话 + Profile 运行时
    ↕ SDK
dataagent/         Agent 内核
```

| 路径 | 职责 |
|------|------|
| `profiles/*.yaml` | Product Profile：layout、agent_config、agent_type |
| `backend/protocol/` | SSE 事件名、`sse_encode` |
| `backend/adapters/` | 按 Agent 类型把 SDK 流译为壳事件 |
| `backend/profiles/` | Profile YAML 加载 |
| `backend/session/` | 会话 JSON（`.sessions/`） |
| `backend/runtime/` | `AgentPool`：Profile 切换、Agent 懒加载 |
| `web/src/protocol/` | 前端事件类型与 `streamClient` |
| `web/src/layouts/` | 场景布局（数据查询工作台 / 对话助手） |
| `web/src/profiles/` | layout 注册表 |

## 统一入口

默认 Profile `landcheck-copilot` 使用 `landcheck_copilot.yaml`：

- 主 Agent：`type: react`
- 子 Agent：NL2SQL、Document Recall、Plot、Report，经 `sub_agent_tool` 同步委派
- `landcheck-nl2sql` Profile 保留，仅供 NL2SQL 直连调试

```text
用户 → Shell → Landcheck Copilot (react)
                    ├─ landcheck_nl2sql
                    ├─ landcheck_document_recall
                    ├─ landcheck_plot
                    └─ landcheck_report
```

### Copilot 流式协作

```text
主 Agent (react) ──tool_status──► Shell TOOL 事件
       │
       └─ sub_agent_tool 子进程
              ├─ stderr ──► execution_msg (subagent_progress) ──► Shell log/stage
              └─ 返回 state ──► subagent_state ──► Shell artifact (sql/table/image/report)
```

- Copilot 布局：对话流内枢纽 DAG（主 Agent → 子 Agent → 产物 → 总结）+ 右侧产物栏
- 直连 `landcheck-nl2sql` Profile 仍走 `Nl2sqlStreamAdapter`，供管道调试
- 内核：`executor._emit_tool_execution_output` 发射 `subagent_state`

## 前置条件

1. MySQL（`landcheck` 等，按 Profile 配置）
2. Semantic Service（NL2SQL Profile 需要，`:32000`）
3. 仓库根目录 `.env`（LLM、数据库、语义层）
4. `uv sync --extra server --extra nl2sql`

## 启动

```powershell
# 后端（仓库根目录）
$env:PYTHONUTF8 = "1"
uv run python shell/backend/main.py

# 前端
cd shell/web
npm install
npm run dev
```

浏览器：**http://127.0.0.1:5173**

## Profile

| ID | 布局 | 说明 |
|----|------|------|
| `landcheck-copilot` | 对话 + 工具轨迹 | **默认**。主 Agent 自动委派 Landcheck NL2SQL 子 Agent |
| `landcheck-nl2sql` | 数据查询三栏 | 开发调试：直连 NL2SQL 管道 |
| `local-dev-react` | 对话 + 工具轨迹 | 开发调试：通用 ReAct |

环境变量：

- `SHELL_PROFILE`：Profile ID（默认 `landcheck-copilot`）
- `SHELL_AGENT_CONFIG`：直接指定 Agent YAML（Profile 为 `custom`）
- `DATAAGENT_REPO_ROOT`：仓库根目录（Shell 后端自动注入；CLI 单独跑 `landcheck_copilot.yaml` 时需手动设置）

UI 顶栏下拉框可切换 Profile（调用 `POST /api/profile/switch`）。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 状态 + 当前 Profile |
| GET | `/api/profile` | 当前 Profile |
| GET | `/api/profiles` | 列表 + 当前 |
| POST | `/api/profile/switch` | `{ profile_id }` |
| GET/POST | `/api/sessions` | 会话 |
| DELETE | `/api/sessions/{id}` | 删除会话（含工作区目录） |
| POST | `/api/chat` | SSE 流式 |

## SSE 事件（v1）

| event | 说明 |
|-------|------|
| `stage` | 管道/节点阶段 |
| `token` | 流式文本块（react） |
| `tool` | 工具/子 Agent 状态 |
| `artifact` | 结构化产物（如 SQL） |
| `log` | 短日志 |
| `result` | 终态 |
| `error` | 错误 |

### 委派事件字段

`log` / `stage` / `artifact` 在 Copilot 多 Agent 场景下可携带：

| 字段 | 说明 |
|------|------|
| `tool_call_id` | 归属的工具调用（委派卡片 ID） |
| `scope` | `subagent` 表示子 Agent 内部 |
| `agent_type` | 如 `nl2sql` |
| `kind`（artifact） | `sql` / `table` |

`result` 可携带 `delegations[]`，用于会话持久化。

## 如何新增一种 Agent 类型

1. 在 `backend/adapters/` 实现 `stream_events`，注册到 `registry.py`
2. 在 `shell/profiles/` 增加 YAML
3. 如需新 UI，在 `web/src/layouts/` 增加布局并注册到 `profiles/registry.ts`
4. 在 `streamClient` 中处理新事件（若需要）
