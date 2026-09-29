1. 只生成只读 SELECT；禁止 INSERT/UPDATE/DELETE/DDL。不要查询 `sys_user`，不要 SELECT 密码/密钥列（含 `AS password` 别名规避），不要读取 GridFS 二进制字段。
2. 业务表查询必须加 `is_deleted = 0`（`ref_enum` 无此列除外）。多表 JOIN 时每张业务表都要过滤软删除。
3. 使用 MySQL 语法取年份：用 `YEAR(列名)`，不要用 SQLite 的 `strftime`。
   时间字段按问题语义选择，不要默认写死某一列：
   - 问「创建 / 建档 / 录入系统 / 何时新建」→ `project.create_time`
   - 问「项目时间 / 业务年份 / 立项或项目所属年份」→ `project.project_time`
   - 问题只说「各年份项目数量」且未指明创建或业务时间 → 优先 `project_time`，并在结果说明里写清统计口径
   `create_time` 与 `project_time` 是不同字段，禁止混用，也禁止因为本条出现过某列名就忽略用户用词。
4. 问「某某项目」先用 `project.project_name LIKE '%关键字%'` 匹配，再用 `project.id` 关联明细。
5. **禁止**把 `survey_report_info` 和 `room_info` 同时只按 `project_id` JOIN（房间数会乘上报告数）。某一栋用 `room_info.survey_report_info_id = survey_report_info.id`。项目级同时统计房间和测绘报告时用相关子查询，不要双表按项目 JOIN。
6. 「用途」用 `room_info.usage_category`，不要用经常为空的 `room_usage`。需要中文时 `LEFT JOIN ref_enum e ON e.enum_group = 'usage_category' AND e.enum_code = r.usage_category`。
7. 「计容」用 `room_info.floor_area_type = 'BUILDABLE'` 或 `survey_report_info.total_buildable_area`。**不要**用 `contract_info.total_area`（大部分为空）。
8. 「建筑面积」用 `room_info.building_area`；套内 / 阳台 / 分摊分别用 `inner_area` / `balcony_area` / `shared_area`。
9. 枚举代码含义查 `ref_enum`，JOIN 时必须带上正确的 `enum_group`。
10. 直接查基表，不要查 `v_*` 视图。`parse_job` 等历史表已删除，不要 JOIN。
11. 只 SELECT 问题需要的列；排序/过滤用到的列不必出现在 SELECT 中，除非用户要看。
12. 大表 `room_info` 做全库汇总可以；按项目过滤时务必带 `project_id` 或先匹配 `project`。
13. 问「按 X 排名 / 取前 N」时，`ORDER BY` 必须对应 X。问句同时列出多项指标但只说「排名」、未写按哪一项时，按**最先出现的度量**排序（先说房间数再说建筑面积 → `ORDER BY` 房间数）。禁止用未作为排序依据的另一列排序。
