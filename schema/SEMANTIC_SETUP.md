# landcheck 语义层布置

本目录提供语义层 seed 与 SQL 规则。按下面顺序做完即可用 Copilot / NL2SQL 查询 MySQL 库 `landcheck`。当前产品默认 `schema_mode: schema_linking`，需要 **Semantic Service + 本地 BGE 嵌入 + 已导入 seed**。

## 文件

| 文件 | 用途 |
| --- | --- |
| `schema/landcheck_seed.json` | Semantic Service bulk 导入 |
| `schema/landcheck_docs/sql_rules.md` | NL2SQL 查询硬规则（可编辑源文件；Document Recall 也读这份） |
| `dataagent/agents/nl2sql/prompts/user/sql_rules_landcheck.md` | NL2SQL 运行时加载的规则副本，改源文件后请同步过来 |
| `dataagent/core/flex/examples/landcheck_nl2sql.yaml` | 专用 NL2SQL Agent 配置 |
| `schema/generate_landcheck_seed.py` | 从 `schema.sql` 重新生成 seed |

## 前置条件

1. **Semantic Service**（Java 21 + pgvector PostgreSQL，默认 `:32000`）。`mysql` 只存业务数据，不能当语义层库。
2. 已 bulk 导入 `landcheck_seed.json`（打开嵌入后导入，否则筛表无向量）。
3. `.env` 中 `SEMANTIC_LAYER_BASE_URL` 指向该服务。

Windows 上 Java 服务脚本是 `start.sh`，用 **Git Bash** 或 WSL 跑服务包；PostgreSQL 用 Docker Desktop。

## 步骤 1：拉起语义层 PostgreSQL

端口用 **54321**，避免和别的 Postgres 冲突（不要占用 3306）。

```powershell
docker run -d --name semantic-layer-pg `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=semantic_layer `
  -p 54321:5432 `
  -v semantic-layer-pg-data:/var/lib/postgresql/data `
  --restart unless-stopped `
  pgvector/pgvector:pg16
```

## 步骤 2：下载并启动 Semantic Service

服务包：

https://datagallery.obs.cn-southwest-2.myhuaweicloud.com/semantic-service/semantic-layer-0.1.0.tar.gz

在 **WSL** 中：

```bash
export SEMANTIC_PORT=32000
export PG_PORT=54321
export BASE="http://localhost:${SEMANTIC_PORT}/api/semantic/v1"

# 解压服务包后进入目录
# 编辑 conf/semantic-service-application.properties：
#   semantic_service.db.url=jdbc:postgresql://host.docker.internal:54321/semantic_layer
#   （WSL 访问 Docker Desktop 中的 PG 常用 host.docker.internal）
#   semantic_service.db.user=postgres
#   semantic_service.db.password=postgres

# 第一次可以先关向量，尽快导入：
#   semantic_service.vector.embedding.service.enable=false

java -version   # 需要 21+
./bin/start.sh -p "${SEMANTIC_PORT}"
```

成功标志：终端出现 `Semantic Service is ready!`，且：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" "$BASE/types/typedefs"
# 期望 200
```

完整向量检索：下载 `BAAI/bge-base-zh-v1.5`，设置 `semantic_service.vector.embedding.service.enable=true` 和本地 `model.path` 后重启，再导入 seed。详见 `docs/zh/installation_doc/database_install/semantic-service-deployment.md`。

Landcheck Copilot 已使用 `schema_linking`；嵌入未打开时列检索会失败（`queryVector is null`）。

## 步骤 3：导入 landcheck 元数据

在 **仓库根目录**（PowerShell）：

```powershell
$BASE = "http://localhost:32000/api/semantic/v1"
curl.exe -sS -X POST -H "Content-Type: application/json" `
  --data-binary "@schema/landcheck_seed.json" `
  "$BASE/entity/bulk"
```

若报 duplicate key，测试环境可在服务包目录执行 `./bin/start.sh -p 32000 -c` 清库后重导。

抽检：

```powershell
curl.exe -sS -X POST -H "Content-Type: application/json" `
  "$BASE/search/basic" `
  -d '{"typeName":"data_table","query":"room","limit":10}'

curl.exe -sS "$BASE/advanced-search/table-columns-info?tableName=landcheck.room_info&limit=30&offset=0"
```

应能看到 `room_info` / `project` 等表。

## 步骤 4：启动 Copilot

确认 `.env` 中：

```text
SEMANTIC_LAYER_BASE_URL=http://localhost:32000
MYSQL_* 与 DATASOURCE 已指向 landcheck
```

产品入口是 Shell（`restart-shell-backend.bat` + `shell/web` 的 `npm run dev`），默认 Profile `landcheck-copilot`。直连 NL2SQL 调试才用：

```powershell
conda activate dataagent
cd E:\dev\Code\Agent\dataagent
uv run -m dataagent --config dataagent/core/flex/examples/landcheck_nl2sql.yaml
```

可试：

- 智谷项目有多少房间、建筑面积多少
- 按用途统计房间数
- 房间数最多的 10 个项目

抽检口径：智谷约 535 间、建筑面积约 395113；房间数最多约嘉顺苑 5989 间。

## 改了 schema.sql 之后

```powershell
.\.venv\Scripts\python.exe schema\generate_landcheck_seed.py
```

然后重新 bulk 导入（或先清库）。
