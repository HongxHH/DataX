SET NAMES utf8mb4;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS `parse_job`;

DROP TABLE IF EXISTS `parsed_data_header`;

DROP TABLE IF EXISTS `parsed_data_item`;

DROP TABLE IF EXISTS `land_parcel`;

DROP TABLE IF EXISTS `capacity_indicator_info`;

DROP TABLE IF EXISTS `sys_user`;

CREATE TABLE `sys_user` (
  `id` BIGINT NOT NULL COMMENT '用户ID',
  `username` VARCHAR(64) NULL COMMENT '登录名',
  `password` VARCHAR(255) NULL COMMENT 'BCrypt 密码哈希，禁止对 Agent 暴露',
  `real_name` VARCHAR(64) NULL COMMENT '真实姓名',
  `phone` VARCHAR(32) NULL COMMENT '手机号',
  `user_type` VARCHAR(32) NULL COMMENT '用户类型：DEVELOPER=开发商，SUPER_ADMIN=超管，USER=普通用户',
  `is_active` TINYINT NULL COMMENT '是否启用：1=启用，0=停用',
  `last_login` DATETIME(3) NULL COMMENT '最近登录时间',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='系统用户。DataAgent 禁止查询 password 列。';

DROP TABLE IF EXISTS `project`;

CREATE TABLE `project` (
  `id` BIGINT NOT NULL COMMENT '项目ID',
  `project_name` VARCHAR(255) NULL COMMENT '项目名称，如「36-智谷项目」',
  `project_time` DATE NULL COMMENT '项目时间（日期）。问某年项目用 YEAR(project_time)',
  `created_by` BIGINT NULL COMMENT '创建人用户ID，逻辑外键 sys_user.id，可空',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_created_by (created_by),
  KEY idx_project_name (project_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='建设项目（业务根表）。问「某某项目」先从本表用 project_name 模糊匹配。';

DROP TABLE IF EXISTS `usage_config`;

CREATE TABLE `usage_config` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `usage_pattern` VARCHAR(255) NULL COMMENT '匹配原文，如「住宅」「商业」；is_regex=1 时为正则',
  `usage_category` VARCHAR(64) NULL COMMENT '标准用途代码，见 ref_enum.usage_category',
  `floor_area_type` VARCHAR(64) NULL COMMENT '计容类型代码，见 ref_enum.floor_area_type',
  `is_regex` TINYINT NULL COMMENT '是否正则：1=是，0=否',
  `priority` INT NULL COMMENT '优先级，数值越大越优先',
  `status` TINYINT NULL COMMENT '规则状态：1=启用',
  `remark` TEXT NULL COMMENT '备注',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='房间用途匹配规则。usage_pattern 是测绘原文关键词，usage_category 是标准分类代码。';

DROP TABLE IF EXISTS `file_archive`;

CREATE TABLE `file_archive` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `name` VARCHAR(255) NULL COMMENT '档案夹名称，如「合同」',
  `kind` VARCHAR(64) NULL COMMENT '档案类型：CONTRACT=合同，SURVEY=测绘等',
  `is_default` TINYINT NULL COMMENT '是否默认档案夹：1=是，0=否',
  `sort_order` INT NULL COMMENT '排序号，越小越靠前',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目档案夹/目录，用于给上传文件归类。';

DROP TABLE IF EXISTS `file_record`;

CREATE TABLE `file_record` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `parse_job_id` BIGINT NULL COMMENT '历史解析任务ID，任务表已删除，不要 JOIN',
  `file_type` VARCHAR(32) NULL COMMENT '文件格式：PDF/XLSX 等',
  `file_context_type` VARCHAR(64) NULL COMMENT '业务类型，见 ref_enum.file_context_type。测绘报告=SURVEY_REPORT',
  `archive_id` BIGINT NULL COMMENT '档案夹ID，逻辑外键 file_archive.id',
  `original_name` VARCHAR(512) NULL COMMENT '原始文件名',
  `gridfs_id` VARCHAR(64) NULL COMMENT '原 GridFS 文件ID，本库无二进制',
  `md5` VARCHAR(64) NULL COMMENT '文件 MD5',
  `file_size` BIGINT NULL COMMENT '字节大小',
  `upload_user_id` BIGINT NULL COMMENT '上传人用户ID',
  `upload_user_name` VARCHAR(64) NULL COMMENT '上传人姓名',
  `upload_time` DATETIME(3) NULL COMMENT '上传时间',
  `file_state` VARCHAR(64) NULL COMMENT '解析状态，见 ref_enum.file_state',
  `thumb_gridfs_id` VARCHAR(64) NULL COMMENT '缩略图 GridFS ID，无二进制',
  `preprocess_gridfs_id` VARCHAR(64) NULL COMMENT '预处理文件 GridFS ID，无二进制',
  `phase` INT NULL COMMENT '期数/批次',
  `parse_message` TEXT NULL COMMENT '解析失败等信息',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_archive_id (archive_id),
  KEY idx_project_deleted (project_id, is_deleted),
  KEY idx_context_type (file_context_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='已上传文件元数据。不含文件二进制（GridFS 未迁移）。parse_job_id 仅为历史字段。';

DROP TABLE IF EXISTS `upload_record`;

CREATE TABLE `upload_record` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `file_id` BIGINT NULL COMMENT '文件ID，逻辑外键 file_record.id',
  `file_name` VARCHAR(512) NULL COMMENT '当时文件名',
  `upload_user_id` BIGINT NULL COMMENT '上传人用户ID',
  `upload_user_name` VARCHAR(64) NULL COMMENT '上传人姓名',
  `upload_time` DATETIME(3) NULL COMMENT '上传时间',
  `upload_status` VARCHAR(32) NULL COMMENT '上传结果：SUCCESS 等',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_file_id (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文件上传流水。';

DROP TABLE IF EXISTS `ocr_execution_result`;

CREATE TABLE `ocr_execution_result` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `parse_job_id` BIGINT NULL COMMENT '历史解析任务ID，任务表已删除',
  `ocr_result_json_gridfs_id` VARCHAR(64) NULL COMMENT 'OCR JSON 的 GridFS ID，无二进制',
  `page_count` INT NULL COMMENT '页数',
  `processing_time_ms` BIGINT NULL COMMENT '处理耗时毫秒',
  `markdown_file_gridfs_id` VARCHAR(64) NULL COMMENT 'Markdown 结果 GridFS ID，无二进制',
  `execution_time` DATETIME(3) NULL COMMENT '执行时间',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_file_record_id (file_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='OCR 执行记录。结果 JSON 仍在 GridFS，本表只有页数和耗时。';

DROP TABLE IF EXISTS `contract_info`;

CREATE TABLE `contract_info` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `contract_number` VARCHAR(128) NULL COMMENT '合同编号',
  `transferor` VARCHAR(255) NULL COMMENT '出让方/转让方',
  `transferee` VARCHAR(255) NULL COMMENT '受让方',
  `commercial_area` DECIMAL(20,4) NULL COMMENT '合同商业面积 m²，可空',
  `residential_area` DECIMAL(20,4) NULL COMMENT '合同住宅面积 m²，可空',
  `total_area` DECIMAL(20,4) NULL COMMENT '合同总面积 m²。多数行为空，勿当作实测面积',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_file_record_id (file_record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='土地/房产合同。注意 total_area 大部分为空，问面积应优先用测绘或房间汇总，不要依赖本合同面积。';

DROP TABLE IF EXISTS `planning_review_form`;

CREATE TABLE `planning_review_form` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `is_parsed` TINYINT NULL COMMENT '是否已解析：1=是，0=否',
  `project_name` VARCHAR(512) NULL COMMENT '审查文件上的工程名称',
  `construction_unit` VARCHAR(255) NULL COMMENT '建设单位',
  `design_unit` VARCHAR(255) NULL COMMENT '设计单位',
  `construction_location` VARCHAR(255) NULL COMMENT '建设位置',
  `contact_person` VARCHAR(64) NULL COMMENT '联系人',
  `contact_phone` VARCHAR(32) NULL COMMENT '联系电话',
  `remarks` TEXT NULL COMMENT '备注',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='规划审查意见书主表（一个文件一份）。';

DROP TABLE IF EXISTS `planning_review_row`;

CREATE TABLE `planning_review_row` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `planning_review_form_id` BIGINT NULL COMMENT '规划审查主表ID，逻辑外键 planning_review_form.id',
  `row_index` INT NULL COMMENT '行号',
  `engineering_project` VARCHAR(255) NULL COMMENT '工程项目/楼号，如「22#」',
  `building_nature_raw` VARCHAR(64) NULL COMMENT '建筑性质原文，如「居住」',
  `area_category` VARCHAR(64) NULL COMMENT '面积分类代码，见 ref_enum.area_category',
  `construction_nature` VARCHAR(64) NULL COMMENT '建设性质，如「新建」',
  `building_count` INT NULL COMMENT '栋数',
  `above_ground_floors` INT NULL COMMENT '地上层数',
  `below_ground_floors` INT NULL COMMENT '地下层数',
  `height_m` DECIMAL(20,4) NULL COMMENT '高度 m',
  `base_area_m2` DECIMAL(20,4) NULL COMMENT '基底面积 m²',
  `residential_residential_area` DECIMAL(20,4) NULL COMMENT '住宅-住宅面积 m²',
  `residential_hotel_apartment_area` DECIMAL(20,4) NULL COMMENT '住宅-酒店式公寓面积 m²',
  `residential_other_area` DECIMAL(20,4) NULL COMMENT '住宅-其他面积 m²',
  `nr_above_commercial` DECIMAL(20,4) NULL COMMENT '非住地上商业 m²',
  `nr_above_garage` DECIMAL(20,4) NULL COMMENT '非住地上车库 m²',
  `nr_above_other` DECIMAL(20,4) NULL COMMENT '非住地上其他 m²',
  `nr_below_commercial` DECIMAL(20,4) NULL COMMENT '非住地下商业 m²',
  `nr_below_supporting` DECIMAL(20,4) NULL COMMENT '非住地下配套 m²',
  `nr_below_other` DECIMAL(20,4) NULL COMMENT '非住地下其他 m²',
  `above_ground_area` DECIMAL(20,4) NULL COMMENT '地上面积合计 m²',
  `below_ground_area` DECIMAL(20,4) NULL COMMENT '地下面积合计 m²',
  `total_area` DECIMAL(20,4) NULL COMMENT '总面积 m²',
  `far_above_ground` DECIMAL(20,4) NULL COMMENT '计容积率地上面积 m²',
  `far_below_ground` DECIMAL(20,4) NULL COMMENT '计容积率地下面积 m²',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_form_id (planning_review_form_id),
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='规划审查明细行（楼栋/工程）。挂 planning_review_form_id，不要只按 project_id 去乘房间。';

DROP TABLE IF EXISTS `project_party_survey_summary_form`;

CREATE TABLE `project_party_survey_summary_form` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `is_parsed` TINYINT NULL COMMENT '是否已解析：1=是',
  `parse_status` VARCHAR(32) NULL COMMENT '解析状态：PARTIAL/COMPLETE 等',
  `remark` TEXT NULL COMMENT '备注，常含缺失字段说明',
  `contract_agreed_total_building_area` DECIMAL(20,4) NULL COMMENT '合同约定总建筑面积 m²',
  `buildable_total_building_area` DECIMAL(20,4) NULL COMMENT '计容总建筑面积 m²',
  `difference_total_building_area` DECIMAL(20,4) NULL COMMENT '总建筑面积差值 m²',
  `contract_agreed_commercial_area` DECIMAL(20,4) NULL COMMENT '合同约定商业面积 m²',
  `buildable_commercial_area` DECIMAL(20,4) NULL COMMENT '计容商业面积 m²',
  `difference_commercial_area` DECIMAL(20,4) NULL COMMENT '商业面积差值 m²',
  `contract_agreed_residential_area` DECIMAL(20,4) NULL COMMENT '合同约定住宅面积 m²',
  `buildable_residential_area` DECIMAL(20,4) NULL COMMENT '计容住宅面积 m²',
  `difference_residential_area` DECIMAL(20,4) NULL COMMENT '住宅面积差值 m²',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='甲方实测汇总表。declared_totals 已拆成面积列。';

DROP TABLE IF EXISTS `survey_report_info`;

CREATE TABLE `survey_report_info` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `building_name` VARCHAR(512) NULL COMMENT '楼栋名称，可空',
  `phase` INT NULL COMMENT '期数',
  `property_certificate_number` VARCHAR(128) NULL COMMENT '不动产权证号',
  `real_estate_survey_report_number` VARCHAR(128) NULL COMMENT '房产测绘报告编号',
  `property_area_confirmation_notice_number` VARCHAR(128) NULL COMMENT '房产面积确认通知编号',
  `contract_approval_number` VARCHAR(128) NULL COMMENT '合同核准文号',
  `actual_total_building_area` DECIMAL(20,4) NULL COMMENT '实测总建筑面积 m²',
  `actual_residential_area` DECIMAL(20,4) NULL COMMENT '实测住宅面积 m²',
  `actual_commercial_area` DECIMAL(20,4) NULL COMMENT '实测商业面积 m²',
  `actual_management_area` DECIMAL(20,4) NULL COMMENT '实测物管面积 m²',
  `actual_other_buildable_area` DECIMAL(20,4) NULL COMMENT '实测其他计容面积 m²',
  `actual_community_area` DECIMAL(20,4) NULL COMMENT '实测社区用房面积 m²',
  `actual_other_public_area` DECIMAL(20,4) NULL COMMENT '实测其他公建面积 m²',
  `total_buildable_area` DECIMAL(20,4) NULL COMMENT '计容面积合计 m²（问计容优先用此列）',
  `total_non_buildable_area` DECIMAL(20,4) NULL COMMENT '非计容面积合计 m²',
  `pending_confirm_area` DECIMAL(20,4) NULL COMMENT '待确认面积 m²',
  `has_unknown_usage` TINYINT NULL COMMENT '是否含未知用途：1=是，0=否',
  `unknown_usages` JSON NULL COMMENT '未知用途 JSON',
  `unknown_usage_count` INT NULL COMMENT '未知用途条数',
  `room_info_building_area_sum` DECIMAL(20,4) NULL COMMENT '下属房间建筑面积加总 m²',
  `room_info_inner_area_sum` DECIMAL(20,4) NULL COMMENT '下属房间套内面积加总 m²',
  `room_info_balcony_area_sum` DECIMAL(20,4) NULL COMMENT '下属房间阳台面积加总 m²',
  `room_info_shared_area_sum` DECIMAL(20,4) NULL COMMENT '下属房间分摊面积加总 m²',
  `room_info_building_area_sum_from_ocr` DECIMAL(20,4) NULL COMMENT 'OCR 识别的建筑面积合计 m²',
  `room_info_inner_area_sum_from_ocr` DECIMAL(20,4) NULL COMMENT 'OCR 识别的套内面积合计 m²',
  `room_info_balcony_area_sum_from_ocr` DECIMAL(20,4) NULL COMMENT 'OCR 识别的阳台面积合计 m²',
  `room_info_shared_area_sum_from_ocr` DECIMAL(20,4) NULL COMMENT 'OCR 识别的分摊面积合计 m²',
  `is_verified` TINYINT NULL COMMENT '是否已校验：1=是，0=否，可空',
  `is_parsed` TINYINT NULL COMMENT '是否已解析：1=是',
  `verification_error_reason` TEXT NULL COMMENT '校验失败原因',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_file_record_id (file_record_id),
  KEY idx_project_deleted (project_id, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='测绘报告（一栋/一份）。房间通过 survey_report_info_id 挂到本表，禁止与 room_info 同时只按 project_id JOIN。';

DROP TABLE IF EXISTS `room_info`;

CREATE TABLE `room_info` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `survey_report_info_id` BIGINT NULL COMMENT '所属测绘报告ID，逻辑外键 survey_report_info.id。挂某一栋必须用此列',
  `room_level` VARCHAR(64) NULL COMMENT '楼层原文，如「1层」',
  `room_number` VARCHAR(64) NULL COMMENT '房号，如「101」',
  `building_area` DECIMAL(20,4) NULL COMMENT '建筑面积 m²',
  `inner_area` DECIMAL(20,4) NULL COMMENT '套内面积 m²',
  `balcony_area` DECIMAL(20,4) NULL COMMENT '阳台面积 m²',
  `shared_area` DECIMAL(20,4) NULL COMMENT '分摊面积 m²',
  `room_structure` VARCHAR(64) NULL COMMENT '房屋结构，如「钢混结构」',
  `room_usage` VARCHAR(128) NULL COMMENT '测绘用途原文。大量为空，统计请用 usage_category',
  `remark` TEXT NULL COMMENT '备注',
  `is_calculate` TINYINT NULL COMMENT '是否纳入测算：1=是，0=否',
  `usage_category` VARCHAR(64) NULL COMMENT '标准用途代码，见 ref_enum.usage_category',
  `floor_area_type` VARCHAR(64) NULL COMMENT '是否计容，见 ref_enum.floor_area_type。BUILDABLE=计容',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_survey_report_info_id (survey_report_info_id),
  KEY idx_file_record_id (file_record_id),
  KEY idx_project_usage (project_id, usage_category),
  KEY idx_project_deleted (project_id, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='房间明细（最大事实表）。问面积用 building_area；问用途优先 usage_category，room_usage 原文常为空。';

DROP TABLE IF EXISTS `unknown_usage_record`;

CREATE TABLE `unknown_usage_record` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `usage_name` VARCHAR(128) NULL COMMENT '未知用途原文，如「工业」「厂房」',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `file_record_id` BIGINT NULL COMMENT '来源文件ID，逻辑外键 file_record.id',
  `room_info_id` BIGINT NULL COMMENT '关联房间ID，逻辑外键 room_info.id',
  `survey_report_info_id` BIGINT NULL COMMENT '关联测绘报告ID',
  `occurrence_count` INT NULL COMMENT '出现次数',
  `status` TINYINT NULL COMMENT '处理状态：0=未处理，1=已处理',
  `handle_remark` TEXT NULL COMMENT '处理说明',
  `handled_by` VARCHAR(64) NULL COMMENT '处理人',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_room_info_id (room_info_id),
  KEY idx_survey_report_info_id (survey_report_info_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='未能自动归类的用途，usage_name 为测绘原文。';

DROP TABLE IF EXISTS `station_message`;

CREATE TABLE `station_message` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `scene` VARCHAR(64) NULL COMMENT '场景代码，如 PARSE_SUCCESS',
  `title` VARCHAR(255) NULL COMMENT '标题',
  `content` TEXT NULL COMMENT '正文',
  `business_id` VARCHAR(64) NULL COMMENT '业务流水/任务ID',
  `project_id` BIGINT NULL COMMENT '所属项目ID，可空',
  `file_id` BIGINT NULL COMMENT '相关文件ID，可空',
  `topic_key` VARCHAR(64) NULL COMMENT '消息主题键',
  `sent_at` DATETIME(3) NULL COMMENT '发送时间',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_file_id (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='站内消息。部分记录没有 project_id（系统消息）。';

DROP TABLE IF EXISTS `user_station_message_read`;

CREATE TABLE `user_station_message_read` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `user_id` VARCHAR(64) NULL COMMENT '用户ID（字符串）',
  `message_id` BIGINT NULL COMMENT '消息ID，逻辑外键 station_message.id',
  `read_at` DATETIME(3) NULL COMMENT '阅读时间',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_user_message (user_id, message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户已读站内信。user_id 为字符串形式的用户ID。';

DROP TABLE IF EXISTS `operation_audit_log`;

CREATE TABLE `operation_audit_log` (
  `id` BIGINT NOT NULL COMMENT '主键，沿用原 Mongo Long ID',
  `operate_time` DATETIME(3) NULL COMMENT '操作时间',
  `operator_id` BIGINT NULL COMMENT '操作人用户ID',
  `operator_name` VARCHAR(64) NULL COMMENT '操作人姓名',
  `operation` VARCHAR(32) NULL COMMENT '操作类型：DELETE/UPDATE 等',
  `target_type` VARCHAR(64) NULL COMMENT '对象类型，如 file_archive',
  `target_id` VARCHAR(64) NULL COMMENT '对象ID（字符串）',
  `project_id` BIGINT NULL COMMENT '所属项目ID，逻辑外键 project.id',
  `contract_id` BIGINT NULL COMMENT '相关合同ID，可空',
  `change_summary` JSON NULL COMMENT '变更摘要 JSON',
  `create_time` DATETIME(3) NULL COMMENT '创建时间',
  `update_time` DATETIME(3) NULL COMMENT '更新时间',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`),
  KEY idx_project_id (project_id),
  KEY idx_operate_time (operate_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='操作审计日志。change_summary 为 JSON。';

DROP TABLE IF EXISTS `business_knowledge`;

CREATE TABLE `business_knowledge` (
  `id` CHAR(24) NOT NULL COMMENT '主键，Mongo ObjectId 的 24 位十六进制，无自增',
  `business_term` VARCHAR(255) NULL COMMENT '业务术语',
  `description` TEXT NULL COMMENT '术语说明',
  `synonyms` TEXT NULL COMMENT '同义词',
  `is_recall` TINYINT NULL COMMENT '是否参与召回：1=是',
  `agent_id` VARCHAR(64) NULL COMMENT '所属 Agent，如 default',
  `created_time` DATETIME(3) NULL COMMENT '创建时间',
  `updated_time` DATETIME(3) NULL COMMENT '更新时间',
  `embedding_status` VARCHAR(32) NULL COMMENT '向量化状态：COMPLETED 等',
  `is_deleted` TINYINT NOT NULL DEFAULT 0 COMMENT '软删除：0=有效，1=已删除。查询必须加 is_deleted=0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='业务术语知识（原 ObjectId 主键）。';

DROP TABLE IF EXISTS `ref_enum`;

CREATE TABLE `ref_enum` (
  `enum_group` VARCHAR(64) NOT NULL COMMENT '枚举分组，如 usage_category',
  `enum_code` VARCHAR(64) NOT NULL COMMENT '存库代码',
  `enum_label` VARCHAR(64) NOT NULL COMMENT '中文含义',
  `description` VARCHAR(255) NULL COMMENT '补充说明',
  PRIMARY KEY (`enum_group`, `enum_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='枚举释义。DataAgent 翻译代码查本表';

SET FOREIGN_KEY_CHECKS = 1;
