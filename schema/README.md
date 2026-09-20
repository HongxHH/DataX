# landcheck（MySQL）给 DataAgent

房产测绘核对库。直接查基表。不要读 `sys_user.password`，没有文件二进制。

## 连接

- Host: `127.0.0.1:3306`
- Database: `landcheck`
- User / Password: `root` / `root`
- Charset: `utf8mb4`

列注释与建表见 `schema.sql`。官方 NL2SQL 语义层导入与启动见 `SEMANTIC_SETUP.md`。

## 查询规则（必读）

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

## 口径

| 说法 | 用 |
|---|---|
| 建筑面积 | `room_info.building_area` |
| 套内 / 阳台 / 分摊 | `inner_area` / `balcony_area` / `shared_area` |
| 计容 | `floor_area_type='BUILDABLE'` 或 `total_buildable_area` |
| 非计容 | `floor_area_type='NON_BUILDABLE'` |

**usage_category**：RESIDENTIAL 住宅，COMMERCIAL 商业，MANAGEMENT 物业管理，OTHER_BUILDABLE 其他计容，COMMUNITY 社区配套，OTHER_PUBLIC 其他公建，UNKNOWN 未知。

**floor_area_type**：BUILDABLE 计容，NON_BUILDABLE 非计容，UNKNOWN 未知。

## 示例

```sql
SELECT p.project_name, COUNT(*) rooms, ROUND(SUM(r.building_area), 2) area
FROM room_info r
JOIN project p ON p.id = r.project_id
WHERE r.is_deleted = 0 AND p.is_deleted = 0 AND p.project_name LIKE '%智谷%'
GROUP BY p.project_name;

SELECT r.usage_category, e.enum_label, r.floor_area_type, COUNT(*) rooms,
       ROUND(SUM(r.building_area), 2) area
FROM room_info r
LEFT JOIN ref_enum e ON e.enum_group = 'usage_category' AND e.enum_code = r.usage_category
WHERE r.is_deleted = 0
GROUP BY r.usage_category, e.enum_label, r.floor_area_type
ORDER BY rooms DESC;

SELECT p.project_name,
       (SELECT COUNT(*) FROM room_info r WHERE r.project_id = p.id AND r.is_deleted = 0) rooms,
       (SELECT COUNT(*) FROM survey_report_info s WHERE s.project_id = p.id AND s.is_deleted = 0) surveys,
       (SELECT ROUND(SUM(building_area), 2) FROM room_info r WHERE r.project_id = p.id AND r.is_deleted = 0) area
FROM project p
WHERE p.is_deleted = 0
ORDER BY rooms DESC
LIMIT 10;
```

抽检：智谷约 535 间、建筑面积约 395113；房间数最多为嘉顺苑约 5989 间。
