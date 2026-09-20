# landcheck 库说明

房产测绘核对库。直接查基表。不要读 `sys_user.password`，没有文件二进制。

列注释与建表见仓库 `schema/schema.sql`。官方 NL2SQL 语义层导入与启动见 `schema/SEMANTIC_SETUP.md`。连接参数不在本文档中。

## 查询规则（摘要）

1. 业务查询加 `is_deleted = 0`。
2. **禁止**把 `survey_report_info` 和 `room_info` 同时只按 `project_id` JOIN（房间数会乘上报告数）。某一栋用 `room_info.survey_report_info_id = survey_report_info.id`。项目级汇总用子查询，不要双表按项目 JOIN。
3. 「用途」用 `room_info.usage_category`，不要用经常为空的 `room_usage`。中文查 `ref_enum`（`enum_group='usage_category'`）。
4. 「计容」用 `room_info.floor_area_type = 'BUILDABLE'` 或 `survey_report_info.total_buildable_area`。**不要**用 `contract_info.total_area`（大部分为空）。
5. 枚举代码含义查 `ref_enum`。

## 表（常用）

| 表 | 一行 | 用来问 |
|---|---|---|
| `project` | 项目 | 有哪些项目、`YEAR(project_time)` |
| `survey_report_info` | 测绘报告（通常一栋） | 计容/非计容、楼栋名 |
| `room_info` | 房间 | 面积、用途、明细 |
| `contract_info` | 合同 | 合同号、出让/受让方 |
| `planning_review_form` / `planning_review_row` | 规划审查主表/行 | 地上/地下、计容积率 |
| `file_record` | 上传文件元数据 | 类型、解析状态（无正文） |
| `usage_config` | 用途匹配规则 | 原文如何归类 |
| `unknown_usage_record` | 未归类用途 | 「工业」等未知名 |
| `ref_enum` | 枚举 | 代码→中文 |

其它：`file_archive`、`upload_record`、`ocr_execution_result`、`project_party_survey_summary_form`、`station_message`、`user_station_message_read`、`operation_audit_log`、`sys_user`、`business_knowledge`。无物理外键。

关系：`project` → `survey_report_info` → `room_info`；合同/规划/文件均挂 `project_id`。
