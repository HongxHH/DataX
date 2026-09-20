# DataX

数据问数 Copilot：用自然语言问数、看表、出图、写报告。主 Agent 只负责对话和路由，查数 / 口径 / 画图交给子 Agent。

> 本仓库**不是** [阿里巴巴 DataX](https://github.com/alibaba/DataX)（那个是离线数据同步工具）。

<p>
  <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  <img src="https://img.shields.io/badge/Python-3.11+-brightgreen" alt="Python">
  <img src="https://img.shields.io/badge/UI-React%20+%20Vite-61dafb" alt="UI">
</p>

## 致谢与许可证

DataX 基于 [DataAgent](https://gitcode.com/datagallery/dataagent)（Apache License 2.0）二次开发，并作为**独立项目**维护，不再从上游合并。

- 上游仓库：[gitcode.com/datagallery/dataagent](https://gitcode.com/datagallery/dataagent)
- 本仓库**不是** DataGallery 官方发行版
- 许可证见 [LICENSE](LICENSE)，署名见 [NOTICE](NOTICE)

Python 包导入路径仍为 `dataagent`（沿用上游内核目录名）。

## 能做什么

用户只需要说话。Copilot 按问题类型委派：

| 你想问 | 谁来做 |
|--------|--------|
| 数量、列表、统计、对比、排名 | NL2SQL（只读查库） |
| 表怎么 JOIN、字段是否同义 | DataLink |
| 口径、字段含义、业务规则 | Document Recall |
| 折线 / 柱状 / 饼图 | 先查数，再 Plot |
| 写成文档 | Report（不查库） |

界面侧会同时给出：对话结论、本轮委派 DAG、SQL / 表 / 图 / 报告产物。

仓库内置一份**可替换的示例场景**（房产测绘核对库 `landcheck`），用来跑通整条链路。换成自己的库时，改 YAML、数据源和文档语料即可，不必改壳。

## 架构

```mermaid
flowchart LR
  Browser["浏览器 :5173"] -->|SSE / REST| Shell["shell/backend :8788"]
  Shell --> Copilot["ReAct Copilot"]
  Copilot --> NL2SQL
  Copilot --> DataLink
  Copilot --> Docs["Document Recall"]
  Copilot --> Plot
  Copilot --> Report
  NL2SQL --> MySQL[(业务库 MySQL)]
  NL2SQL --> Semantic["Semantic Service"]
  DataLink --> MCP["DataLink MCP"]
  Docs --> MD["schema 文档语料"]
```

分层：

```text
shell/web            对话工作台、DAG、产物栏
        ↕ SSE / REST
shell/backend        Profile、会话、把内核流转成壳事件
        ↕ SDK
dataagent/           Agent 内核（YAML 编排、NL2SQL、子 Agent）
        ↕
MySQL / Semantic Service / DataLink MCP   外部依赖，不在本仓库
```

更细的壳协议、Profile、SSE 事件见 [shell/README.md](shell/README.md)。

## 仓库里有什么

```text
dataagent/     内核（含 Copilot 所需的流式事件与 persist）
shell/         Web 壳 + 后端
schema/        示例场景：建表、语义 seed、文档召回语料
pyproject.toml  Python 依赖
.env.example   环境变量模板（不要提交 .env）
```

本仓库**不包含** Semantic Service 源码、本地会话、密钥。那些是运行时依赖或本机状态。

## 环境要求

| 依赖 | 说明 |
|------|------|
| Python 3.11+ | 推荐 `uv` |
| Node.js 20+ | `shell/web` |
| MySQL | 示例库名 `landcheck`，也可换成自己的库 |
| Semantic Service | NL2SQL 语义层，默认 `:32000`（需自行部署） |
| DataLink MCP | 可选；不问表关系可以先不启 |
| LLM | 任意 OpenAI 兼容接口 |

## 快速开始

### 1. 安装

```bash
git clone https://github.com/HongxHH/DataX.git
cd DataX
uv sync --extra server --extra nl2sql
cp .env.example .env
```

编辑 `.env`：填入 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`，以及 MySQL、`SEMANTIC_LAYER_BASE_URL`。

语义层导入与 Semantic Service 启动见 [`schema/SEMANTIC_SETUP.md`](schema/SEMANTIC_SETUP.md)。示例库说明见 [`schema/README.md`](schema/README.md)。

### 2. 启动后端

```powershell
$env:PYTHONUTF8 = "1"
uv run python shell/backend/main.py
```

默认 `http://127.0.0.1:8788`。

### 3. 启动前端

```bash
cd shell/web
npm install
npm run dev
```

浏览器打开 **http://127.0.0.1:5173**。默认 Profile 为 `landcheck-copilot`。

## 换成自己的数据

1. 准备只读业务库，把 `.env` 里的 `MYSQL_*` / `DATASOURCE_DATABASE_ADDRESS` 指过去  
2. 复制 `dataagent/core/flex/examples/landcheck_*.yaml`，改库名、路由说明、子 Agent 路径  
3. 把文档口径放到类似 `schema/landcheck_docs/` 的目录，并写入对应 YAML 的 `allow_path`  
4. 在 `shell/profiles/` 增加 Profile，或把 `SHELL_PROFILE` 指到新配置  

内核导入名仍是 `dataagent`，YAML 仍走 `$env{VAR_NAME}`，壳不感知具体业务库。

## 配置注意

- 只把密钥放在 `.env`，不要提交。`.env.example` 只是空模板。
- `DATAAGENT_REPO_ROOT` 由 `shell/backend/main.py` 自动注入。
- 会话写在 `shell/.sessions/`，已被 gitignore。

## License

Apache License 2.0. 见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
