# 字段口径

本文说明 Landcheck 常用说法对应的字段，供口径 / 字段含义类问题召回。不要用本文档猜测具体数量。

## 面积与计容

| 说法 | 用 |
|---|---|
| 建筑面积 | `room_info.building_area` |
| 套内 | `room_info.inner_area` |
| 阳台 | `room_info.balcony_area` |
| 分摊 | `room_info.shared_area` |
| 计容 | `room_info.floor_area_type = 'BUILDABLE'` 或 `survey_report_info.total_buildable_area` |
| 非计容 | `room_info.floor_area_type = 'NON_BUILDABLE'` |

**不要**用 `contract_info.total_area` 表示计容或建筑面积（大部分为空）。

## 用途

「用途」用 `room_info.usage_category`，不要用经常为空的 `room_usage`。需要中文标签时：

```sql
LEFT JOIN ref_enum e
  ON e.enum_group = 'usage_category'
 AND e.enum_code = r.usage_category
```

**usage_category**：

| 代码 | 中文 |
|---|---|
| RESIDENTIAL | 住宅 |
| COMMERCIAL | 商业 |
| MANAGEMENT | 物业管理 |
| OTHER_BUILDABLE | 其他计容 |
| COMMUNITY | 社区配套 |
| OTHER_PUBLIC | 其他公建 |
| UNKNOWN | 未知 |

## 计容类型

**floor_area_type**：

| 代码 | 中文 |
|---|---|
| BUILDABLE | 计容 |
| NON_BUILDABLE | 非计容 |
| UNKNOWN | 未知 |

## 项目与状态

- 项目主表是 `project`。问「有哪些项目」看 `project.project_name`，年份用 `YEAR(project_time)`。
- 业务表查询必须加 `is_deleted = 0`（`ref_enum` 无此列除外）。
- 「项目状态」若文档未给出独立状态字段，应说明需结合表结构 / `ref_enum` 进一步确认，不要编造枚举。

## 枚举总则

枚举代码含义查 `ref_enum`，JOIN 时必须带上正确的 `enum_group`。
