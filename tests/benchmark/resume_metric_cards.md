# 简历候选指标定义卡（B / C）

目标：为一页 STAR bullet 准备 **2 个可对比候选数**；正文最终只上 **执行一致率 +（B 或 C 其一）**。  
数字未冻结前禁止写进对外简历。

相关底座：`tests/benchmark/landcheck/`（L1）、子 Agent Job hydrate（`SubagentSubprocessRunner.reuse_workspace`）。

### 出数入口（脚手架）

| 指标 | 命令 |
| --- | --- |
| B | `python tests/benchmark/resume_metrics/run_linking_metric.py --from-run <L1出目录>` 或加 `--run-l1` |
| C | `python tests/benchmark/resume_metrics/run_reuse_metric.py --k 3 --warmup 1`（先探路）；`--dry-run` 只写模板 |

单测（无 LLM）：`tests/benchmark/resume_metrics/test_resume_metrics.py`。

---

## 共同约定

| 项 | 约定 |
| --- | --- |
| 主结果（已定上屏） | Landcheck L1 **执行一致率** `execution_consistency.rate` |
| 第二指标 | B 与 C **都测**，择一上屏；落选者改成无数字的机制句，或面试口述 |
| 报告精度 | 比率一位小数百分比（如 `94.7%`）；耗时用 ms，下降比例一位小数 |
| 禁止混报 | 不得把执行一致率、SQL 表召回、linking 召回合成「准确率」一个数 |
| 环境快照 | 每次出数记录：日期、模型名、Semantic 是否开嵌入、`landcheck_nl2sql.yaml` / Suite 版本、是否 warmup |

---

## 指标 B：Schema Linking 召回 / 缩表

### B1（上屏主候选）— Linking 必含表召回率

**一句话**：感知阶段 `schema_linking` 召回的表集合，是否覆盖该题标注的必含表。

| 项 | 定义 |
| --- | --- |
| 符号 | \(R_{\text{link}}\) |
| 单题通过 | `expected_tables ⊆ linked_tables`（大小写不敏感；空 `expected_tables` 的题 **不计入分母**） |
| 汇总 | \(R_{\text{link}} = \#\{\text{单题通过}\} / \#\{\text{计入题}\}\) |
| 数据来源 | Agent 跑 L1 后每题 `score.json` → `table_recall.schema_linking`；汇总对齐 `summary.schema_linking_recall` |
| 配置前提 | `schema_mode: schema_linking`（landcheck 默认）；Semantic 嵌入可用 |
| 与硬闸关系 | `require_schema_linking: true` 只影响 **整题是否判 fail**；B1 **仍用同一 ⊆ 公式**，在固定题集上汇总，不因硬闸改公式 |

**计入题集（初版，可修订但须改定义卡版本号）**

优先纳入「依赖 linking / 多表 / 枚举」的题；排除纯计数且单表、以及安全负例：

- 纳入：`lc_zhigu_rooms_area`, `lc_project_rooms_surveys_rank`, `lc_project_rooms_surveys_rank_by_area`, `lc_jasy_rooms_surveys`, `lc_usage_category_stats`, `lc_usage_and_floor_area_type`, `lc_buildable_rooms_area`, `lc_project_buildable_area`, `lc_residential_rooms`
- 排除：`lc_security_no_password`（`expected_tables: []`）、以及跑数时 `linked_tables` 缺失的题（记 `n/a`，不进分母）

**简历允许写法（择一）**

- 「在 Landcheck linking 子集（N 题）上，感知阶段必含表召回率 X%」
- 面试补充：与执行一致率分开；召回高不等于 SQL 对。

**禁止写法**

- 「语义检索准确率 / 意图识别准确率」
- 「缩表后准确率提升 X%」（未做 ablation 不得写）
- 把 SQL 内 `table_recall`（最终 SQL 含表）冒充 linking 召回

### B2（辅证，默认不上屏）— 相对全库缩表比

| 项 | 定义 |
| --- | --- |
| 符号 | \(S_{\text{reduce}}\) |
| 单题 | \(1 - n_{\text{linked}} / n_{\text{full}}\)，其中 \(n_{\text{linked}}=\|linked_tables\|\)，\(n_{\text{full}}\)= 同库 `full_schema` 可得表数（同一 Semantic catalog，评测时冻结一次） |
| 汇总 | 题集上 \(S_{\text{reduce}}\) 的 **中位数**（非均值，抗极端题） |
| 用途 | 支撑「省上下文」口述；仅当 B1 过弱且缩表中位 ≥ 约定门槛时，才考虑改写成上屏句 |

**门槛（建议）**：中位 \(S_{\text{reduce}} \ge 0.5\) 才值得口头强调；否则只讲召回。

---

## 指标 C：子 Agent 工作区复用耗时对比

### C1（上屏主候选）— 第 2 问 E2E 相对下降

**一句话**：同一条子 Agent 任务链上，**复用工作区** 的第 2 问端到端耗时，相对 **冷启动** 第 2 问下降多少。

| 项 | 定义 |
| --- | --- |
| 符号 | \(\Delta_{\text{reuse}}\) |
| 剧本 | 固定 Parent workspace；连续两问 \(Q_1, Q_2\)（\(Q_2\) 依赖 \(Q_1\) 的对话或中间产物，禁止两问完全无关） |
| Cold | 两问均 **不** 传 `workspace_rel_path` / Swarm `sub_id`（第二次新工作区） |
| Reuse | 第 1 问 `collect` 后，第 2 问携带同一 `workspace_rel_path`（Job）或同一 `sub_id`（Swarm，且 SWARM 开启） |
| 单次观测 | \(t=\text{E2E}(Q_2)\)：从 submit/调用开始到 collect/返回终态（ms） |
| 重复 | 同一剧本跑 \(k=5\) 次（可先 \(k=3\) 探路）；取 Cold / Reuse 各自 \(t\) 的 **中位数** \(t_{\text{cold}}, t_{\text{reuse}}\) |
| 汇总 | \(\Delta_{\text{reuse}} = (t_{\text{cold}} - t_{\text{reuse}}) / t_{\text{cold}}\) |
| Warmup | 正式计数前允许 1 次丢弃的预热（模型/连接）；预热不计入中位 |

**路径选定（实现时二选一写进报告，不得混算）**

| 路径 | 复用键 | 适用简历叙事 |
| --- | --- | --- |
| Job（推荐先做） | `workspace_rel_path` + `.memory` hydrate | 数据分析 Suite / submit_subagent |
| Swarm | `sub_id` + worker `.memory` | `sub_agent_tool` 并发工人 |

**控制变量**

- 同模型、同温度、同机器；跑数期间不改 YAML
- \(Q_1, Q_2\) 文案冻结在评测夹具内
- 报告须注明：Reuse **仍新起子进程**，收益来自 hydrate（messages / snapshot / 磁盘产物），非进程常驻

**简历允许写法**

- 「同会话追问复用子 Agent 工作区，第 2 问端到端耗时较冷启动下降 X%（中位，k 次）」

**禁止写法**

- 「进程热复用 / 免初始化 / 零开销」
- 「文件锁使性能提升 X%」（锁不是 C 的自变量）
- 用第 1 问耗时或 token 冒充 \(\Delta_{\text{reuse}}\)

### C2（辅证，默认不上屏）

| 观测 | 用途 |
| --- | --- |
| `reused_workspace: true` 出现率 | 证明复用路径真触发 |
| hydrate 后 messages 条数 > 冷启 | 证明继承历史，而非空会话 |
| 可选：到「首条 progress / 首 token」延迟 | 仅当 E2E 受下游 SQL/DB 噪声过大时改用；改用则定义卡升版 |

---

## 上屏二选一决策（测完后执行）

按顺序否决，留下一个：

1. **稳定**：隔日重跑，主数字相对波动 ≤ 5 个百分点（比率）或耗时下降比例波动 ≤ 10 个百分点；否则该候选不上屏。  
2. **诚实**：能否用一句说清口径且不被追问打脸（C 必须能说清「新进程 + hydrate」）。  
3. **分工**：执行一致率已强时，优先让第二指标讲 **不同故事**（平台复用 → C；感知缩表 → B）。  
4. **美观**：一页只保留 **一个** 第二数字；另一个改为机制句。

---

## 明确不在本卡范围

- 安全拒答率、钩子调用、轨迹节点数、IR token 绝对值、执行一致性投票  
- 把 B/C 做成 CI 常跑门槛（可另开工程任务；简历卡先服务出数）

---

## 版本

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v0.1 | 2026-09-30 | 初定 B1/B2、C1/C2；脚手架已接 |
| v0.1-run | 2026-09-30 | 实测：B1=100%（9/9），B2 中位 52.6%；C1 Δ≈-1.3%（不上屏）；第二指标选 B |
