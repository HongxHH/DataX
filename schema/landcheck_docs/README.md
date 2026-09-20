# Landcheck 文档召回语料（v0）

本目录是 Copilot Document Recall 子 Agent 的只读 Markdown 种子。后续只需往这里追加 `.md`，不必改 YAML。

| 文件 | 内容 |
|---|---|
| `schema_overview.md` | 库说明、常用表、关系 |
| `field_glossary.md` | 字段口径（面积、计容、用途枚举） |
| `sql_rules.md` | 查询规则（软删除、JOIN 陷阱、枚举）。这是可编辑源文件；改完后同步到 `dataagent/agents/nl2sql/prompts/user/sql_rules_landcheck.md` |

不要把 `landcheck_seed.json` 当作召回语料。具体数字必须走 NL2SQL 查库，禁止用本文档猜测数量。
