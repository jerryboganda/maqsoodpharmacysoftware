CREATE TABLE `branch` (
	`branch_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`name_ur` varchar(160),
	`address_line1` varchar(255),
	`address_line2` varchar(255),
	`city` varchar(80),
	`is_default` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`default_tenant_key` bigint unsigned GENERATED ALWAYS AS (if(`is_default` = 1, `tenant_id`, null)) STORED,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `branch_branch_id` PRIMARY KEY(`branch_id`),
	CONSTRAINT `uk_branch_tenant_code` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `uk_branch_tenant_default` UNIQUE(`default_tenant_key`)
);
--> statement-breakpoint
CREATE TABLE `tenant` (
	`tenant_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`name_ur` varchar(160),
	`legal_name` varchar(200),
	`ntn_no` varchar(24),
	`strn_no` varchar(24),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `tenant_tenant_id` PRIMARY KEY(`tenant_id`),
	CONSTRAINT `uk_tenant_code` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `app_user` (
	`user_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned,
	`default_branch_id` bigint unsigned,
	`username` varchar(64) NOT NULL,
	`display_name` varchar(120) NOT NULL,
	`display_name_ur` varchar(120),
	`password_hash` varchar(255) NOT NULL,
	`password_algo` varchar(32) NOT NULL DEFAULT 'argon2id',
	`password_changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`must_change_password` boolean NOT NULL DEFAULT true,
	`failed_login_count` smallint unsigned NOT NULL DEFAULT 0,
	`locked_until` datetime(3),
	`mfa_secret_enc` varbinary(255),
	`email` varchar(190),
	`phone` varchar(32),
	`father_name` varchar(120),
	`address` varchar(255),
	`is_active` boolean NOT NULL DEFAULT true,
	`locale` varchar(12) NOT NULL DEFAULT 'en-PK',
	`legacy_id` smallint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `app_user_user_id` PRIMARY KEY(`user_id`),
	CONSTRAINT `uk_app_user_username` UNIQUE(`username`),
	CONSTRAINT `uk_app_user_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE TABLE `user_session` (
	`session_id` char(36) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned,
	`branch_id` bigint unsigned,
	`issued_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`revoked_by` bigint unsigned,
	`ip_address` varbinary(16),
	`user_agent` varchar(255),
	`machine_name` varchar(64),
	CONSTRAINT `user_session_session_id` PRIMARY KEY(`session_id`)
);
--> statement-breakpoint
CREATE TABLE `permission` (
	`permission_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` varchar(255),
	`permission_kind` enum('action','view','field','report','admin') NOT NULL DEFAULT 'action',
	`is_sensitive` boolean NOT NULL DEFAULT false,
	`legacy_right_code` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `permission_permission_id` PRIMARY KEY(`permission_id`),
	CONSTRAINT `uk_permission_code` UNIQUE(`code`),
	CONSTRAINT `uk_permission_legacy` UNIQUE(`legacy_right_code`)
);
--> statement-breakpoint
CREATE TABLE `role_permission` (
	`role_id` bigint unsigned NOT NULL,
	`permission_id` bigint unsigned NOT NULL,
	`granted_at` datetime(3) NOT NULL,
	`granted_by` bigint unsigned,
	CONSTRAINT `role_permission_role_id_permission_id_pk` PRIMARY KEY(`role_id`,`permission_id`)
);
--> statement-breakpoint
CREATE TABLE `role` (
	`role_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned,
	`role_key` varchar(64) NOT NULL,
	`display_name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_system` boolean NOT NULL DEFAULT false,
	`is_admin` boolean NOT NULL DEFAULT false,
	`legacy_group_code` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `role_role_id` PRIMARY KEY(`role_id`),
	CONSTRAINT `uk_role_tenant_key` UNIQUE(`tenant_id`,`role_key`)
);
--> statement-breakpoint
CREATE TABLE `user_role` (
	`user_id` bigint unsigned NOT NULL,
	`role_id` bigint unsigned NOT NULL,
	`assigned_at` datetime(3) NOT NULL,
	`assigned_by` bigint unsigned,
	`valid_from` datetime(3),
	`valid_to` datetime(3),
	CONSTRAINT `user_role_user_id_role_id_pk` PRIMARY KEY(`user_id`,`role_id`)
);
--> statement-breakpoint
CREATE TABLE `option_item` (
	`option_item_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`option_list_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`name_ur` varchar(120),
	`description` varchar(255),
	`group_label` varchar(64),
	`min_permission` varchar(96),
	`search_terms` varchar(255),
	`meta_json` json,
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`is_system` boolean NOT NULL DEFAULT false,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`legacy_id` varchar(32),
	`default_list_key` bigint unsigned GENERATED ALWAYS AS (if(`is_default` = 1, `option_list_id`, null)) STORED,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `option_item_option_item_id` PRIMARY KEY(`option_item_id`),
	CONSTRAINT `uk_option_item_list_code` UNIQUE(`option_list_id`,`code`),
	CONSTRAINT `uk_option_item_default` UNIQUE(`default_list_key`)
);
--> statement-breakpoint
CREATE TABLE `option_list` (
	`option_list_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`list_code` varchar(48) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_admin_extensible` boolean NOT NULL DEFAULT true,
	`allows_disable` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `option_list_option_list_id` PRIMARY KEY(`option_list_id`),
	CONSTRAINT `uk_option_list_tenant_code` UNIQUE(`tenant_id`,`list_code`)
);
--> statement-breakpoint
CREATE TABLE `item_visibility` (
	`item_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`scope` enum('pos','purchase','reports','stock_list') NOT NULL,
	`is_visible` boolean NOT NULL DEFAULT true,
	`source` enum('default','manual','bulk','preset') NOT NULL DEFAULT 'default',
	`changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`changed_by` bigint unsigned,
	`bulk_operation_id` bigint unsigned,
	CONSTRAINT `item_visibility_item_id_scope_pk` PRIMARY KEY(`item_id`,`scope`)
);
--> statement-breakpoint
CREATE TABLE `item` (
	`item_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`custom_code` varchar(75) NOT NULL,
	`name` varchar(160) NOT NULL,
	`name_local` varchar(255),
	`registration_no` varchar(64),
	`pack_units` smallint unsigned NOT NULL DEFAULT 1,
	`allow_decimal_qty` boolean NOT NULL DEFAULT false,
	`sale_price` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`purchase_price` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`avg_unit_cost` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`min_qty` decimal(15,4),
	`max_qty` decimal(15,4),
	`reorder_qty` decimal(15,4),
	`is_active` boolean NOT NULL DEFAULT true,
	`has_expiry` boolean NOT NULL DEFAULT true,
	`expiry_capture_mode` enum('required','prompt','off') NOT NULL DEFAULT 'required',
	`shelf_life_days` smallint unsigned,
	`storage_location` varchar(100),
	`is_controlled_drug` boolean NOT NULL DEFAULT false,
	`attributes_json` varchar(4000),
	`notes` varchar(1000),
	`legacy_id` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `item_item_id` PRIMARY KEY(`item_id`),
	CONSTRAINT `uk_item_tenant_custom_code` UNIQUE(`tenant_id`,`custom_code`),
	CONSTRAINT `uk_item_tenant_name` UNIQUE(`tenant_id`,`name`),
	CONSTRAINT `uk_item_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE TABLE `stock_lot` (
	`stock_lot_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`batch_no` varchar(64),
	`expiry_date` date,
	`expiry_status` enum('known','unknown','not_applicable') NOT NULL DEFAULT 'known',
	`manufactured_on` date,
	`supplier_id` bigint unsigned,
	`source_document_type_id` bigint unsigned,
	`source_document_id` bigint unsigned,
	`received_on` date,
	`receipt_unit_cost` decimal(15,4),
	`lot_status` enum('available','quarantined','expired','recalled','consumed') NOT NULL DEFAULT 'available',
	`hold_reason_id` bigint unsigned,
	`priority` smallint unsigned NOT NULL DEFAULT 10,
	`batch_key` varchar(64) GENERATED ALWAYS AS (ifnull(`batch_no`, '~none~')) STORED NOT NULL,
	`expiry_key` date GENERATED ALWAYS AS (ifnull(`expiry_date`, '9999-12-31')) STORED NOT NULL,
	`legacy_key` varchar(160),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `stock_lot_stock_lot_id` PRIMARY KEY(`stock_lot_id`),
	CONSTRAINT `uk_stock_lot_identity` UNIQUE(`item_id`,`batch_key`,`expiry_key`),
	CONSTRAINT `uk_stock_lot_legacy` UNIQUE(`legacy_key`)
);
--> statement-breakpoint
CREATE TABLE `gl_account_category` (
	`gl_account_category_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`gl_account_main_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`name_ur` varchar(120),
	`statement_section` enum('balance_sheet','income_statement') NOT NULL,
	`presentation_order` smallint unsigned NOT NULL DEFAULT 100,
	`is_enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `gl_account_category_gl_account_category_id` PRIMARY KEY(`gl_account_category_id`),
	CONSTRAINT `uk_gl_account_category_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `gl_account_main` (
	`gl_account_main_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`name_ur` varchar(120),
	`account_nature` enum('asset','liability','equity','revenue','expense') NOT NULL,
	`normal_balance` enum('debit','credit') NOT NULL,
	`is_enabled` boolean NOT NULL DEFAULT true,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `gl_account_main_gl_account_main_id` PRIMARY KEY(`gl_account_main_id`),
	CONSTRAINT `uk_gl_account_main_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `gl_account_sub` (
	`gl_account_sub_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`gl_account_category_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`name_ur` varchar(120),
	`is_control_account` boolean NOT NULL DEFAULT false,
	`subledger_kind` enum('none','supplier','customer','cash_bank','tax','inventory','expense') NOT NULL DEFAULT 'none',
	`is_enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `gl_account_sub_gl_account_sub_id` PRIMARY KEY(`gl_account_sub_id`),
	CONSTRAINT `uk_gl_account_sub_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `gl_account` (
	`gl_account_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`gl_account_sub_id` bigint unsigned NOT NULL,
	`code` varchar(24) NOT NULL,
	`name` varchar(160) NOT NULL,
	`name_ur` varchar(160),
	`account_nature` enum('asset','liability','equity','revenue','expense') NOT NULL,
	`normal_balance` enum('debit','credit') NOT NULL,
	`is_contra` boolean NOT NULL DEFAULT false,
	`is_postable` boolean NOT NULL DEFAULT true,
	`is_system` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`is_restricted` boolean NOT NULL DEFAULT false,
	`balance_limit_amount` decimal(15,2),
	`opened_on` date,
	`alias_name` varchar(24),
	`remarks` varchar(1000),
	`legacy_id` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `gl_account_gl_account_id` PRIMARY KEY(`gl_account_id`),
	CONSTRAINT `uk_gl_account_tenant_code` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `uk_gl_account_tenant_name` UNIQUE(`tenant_id`,`name`),
	CONSTRAINT `uk_gl_account_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE TABLE `journal_entry` (
	`journal_entry_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned,
	`entry_no` varchar(32) NOT NULL,
	`entry_date` date NOT NULL,
	`document_type_code` varchar(16) NOT NULL,
	`source_document_id` bigint unsigned,
	`reversal_seq` smallint unsigned NOT NULL DEFAULT 0,
	`description` varchar(500) NOT NULL,
	`total_debit` decimal(15,2) NOT NULL DEFAULT '0.00',
	`total_credit` decimal(15,2) NOT NULL DEFAULT '0.00',
	`line_count` smallint unsigned NOT NULL DEFAULT 0,
	`status` enum('draft','posted','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`reversal_of_journal_id` bigint unsigned,
	`reversal_reason` varchar(500),
	`legacy_key` varchar(64),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `journal_entry_journal_entry_id` PRIMARY KEY(`journal_entry_id`),
	CONSTRAINT `uk_journal_source` UNIQUE(`document_type_code`,`source_document_id`,`reversal_seq`),
	CONSTRAINT `uk_journal_entry_no` UNIQUE(`tenant_id`,`entry_no`),
	CONSTRAINT `uk_journal_legacy` UNIQUE(`legacy_key`),
	CONSTRAINT `ck_journal_balanced` CHECK(`journal_entry`.`total_debit` = `journal_entry`.`total_credit`),
	CONSTRAINT `ck_journal_posted` CHECK(`journal_entry`.`status` <> 'posted' or (`journal_entry`.`posted_at` is not null and `journal_entry`.`posted_by` is not null and `journal_entry`.`line_count` >= 2))
);
--> statement-breakpoint
CREATE TABLE `journal_line` (
	`journal_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`journal_entry_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`gl_account_id` bigint unsigned NOT NULL,
	`debit_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`credit_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`analysis_account_id` bigint unsigned,
	`supplier_id` bigint unsigned,
	`customer_id` bigint unsigned,
	`item_id` bigint unsigned,
	`leg_role` enum('primary_debit','primary_credit','sales_tax','income_tax','fbr_fee','payment','cogs','rounding','charge','other') NOT NULL DEFAULT 'other',
	`memo` varchar(500),
	`legacy_row_key` varchar(80),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	CONSTRAINT `journal_line_journal_line_id` PRIMARY KEY(`journal_line_id`),
	CONSTRAINT `uk_journal_line` UNIQUE(`journal_entry_id`,`line_no`),
	CONSTRAINT `ck_journal_line_one_side` CHECK(`journal_line`.`debit_amount` = 0 or `journal_line`.`credit_amount` = 0),
	CONSTRAINT `ck_journal_line_nonneg` CHECK(`journal_line`.`debit_amount` >= 0 and `journal_line`.`credit_amount` >= 0),
	CONSTRAINT `ck_journal_line_nonzero` CHECK((`journal_line`.`debit_amount` + `journal_line`.`credit_amount`) > 0)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`audit_log_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned,
	`branch_id` bigint unsigned,
	`occurred_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`actor_user_id` bigint unsigned,
	`actor_username` varchar(64) NOT NULL,
	`session_id` char(36),
	`action` varchar(48) NOT NULL,
	`entity_type` varchar(48) NOT NULL,
	`entity_id` bigint unsigned,
	`entity_label` varchar(160),
	`before_json` json,
	`after_json` json,
	`changed_fields` json,
	`amount_impact` decimal(15,2),
	`reason` varchar(500),
	`ip_address` varbinary(16),
	`machine_name` varchar(64),
	`request_id` char(36),
	CONSTRAINT `audit_log_audit_log_id` PRIMARY KEY(`audit_log_id`)
);
--> statement-breakpoint
CREATE TABLE `doc_series` (
	`doc_series_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`prefix` varchar(16) NOT NULL DEFAULT '',
	`pad_width` smallint unsigned NOT NULL DEFAULT 6,
	`reset_policy` enum('never','yearly','monthly') NOT NULL DEFAULT 'never',
	`is_enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `doc_series_doc_series_id` PRIMARY KEY(`doc_series_id`),
	CONSTRAINT `uk_doc_series_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `doc_series_counter` (
	`doc_series_id` bigint unsigned NOT NULL,
	`period_key` varchar(8) NOT NULL DEFAULT '*',
	`next_value` bigint unsigned NOT NULL,
	`updated_at` datetime(3),
	CONSTRAINT `uk_doc_series_counter` UNIQUE(`doc_series_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `document_type` (
	`document_type_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`approval_threshold_amount` decimal(15,2),
	`is_enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `document_type_document_type_id` PRIMARY KEY(`document_type_id`),
	CONSTRAINT `uk_document_type_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `fiscal_period` (
	`fiscal_period_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`fiscal_year_id` bigint unsigned NOT NULL,
	`period_key` varchar(8) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`status` enum('open','soft_closed','closed') NOT NULL DEFAULT 'open',
	`closed_at` datetime(3),
	`closed_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `fiscal_period_fiscal_period_id` PRIMARY KEY(`fiscal_period_id`),
	CONSTRAINT `uk_fiscal_period_tenant_key` UNIQUE(`tenant_id`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `fiscal_year` (
	`fiscal_year_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(16) NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `fiscal_year_fiscal_year_id` PRIMARY KEY(`fiscal_year_id`),
	CONSTRAINT `uk_fiscal_year_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `customer` (
	`customer_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`name_ur` varchar(160),
	`gl_account_id` bigint unsigned NOT NULL,
	`customer_category_id` bigint unsigned,
	`is_walk_in` boolean NOT NULL DEFAULT false,
	`credit_limit_amount` decimal(15,2),
	`credit_days` smallint unsigned,
	`ntn_no` varchar(24),
	`strn_no` varchar(24),
	`cnic_no` varchar(20),
	`phone` varchar(32),
	`mobile` varchar(32),
	`email` varchar(190),
	`address_line1` varchar(255),
	`address_line2` varchar(255),
	`city` varchar(80),
	`is_active` boolean NOT NULL DEFAULT true,
	`legacy_id` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `customer_customer_id` PRIMARY KEY(`customer_id`),
	CONSTRAINT `uk_customer_tenant_code` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `uk_customer_tenant_name` UNIQUE(`tenant_id`,`name`),
	CONSTRAINT `uk_customer_account` UNIQUE(`gl_account_id`),
	CONSTRAINT `uk_customer_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE TABLE `salesman` (
	`salesman_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	`user_id` bigint unsigned,
	`commission_percent` decimal(9,4),
	`legacy_id` varchar(16),
	CONSTRAINT `salesman_salesman_id` PRIMARY KEY(`salesman_id`),
	CONSTRAINT `uk_salesman_tenant_code` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `uk_salesman_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE TABLE `supplier` (
	`supplier_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(160) NOT NULL,
	`name_ur` varchar(160),
	`gl_account_id` bigint unsigned NOT NULL,
	`supplier_category_id` bigint unsigned,
	`ntn_no` varchar(24),
	`strn_no` varchar(24),
	`cnic_no` varchar(20),
	`phone` varchar(32),
	`mobile` varchar(32),
	`email` varchar(190),
	`address_line1` varchar(255),
	`address_line2` varchar(255),
	`city` varchar(80),
	`credit_days` smallint unsigned,
	`lead_time_days` smallint unsigned,
	`special_instructions` varchar(4000),
	`is_active` boolean NOT NULL DEFAULT true,
	`legacy_id` varchar(16),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	CONSTRAINT `supplier_supplier_id` PRIMARY KEY(`supplier_id`),
	CONSTRAINT `uk_supplier_tenant_code` UNIQUE(`tenant_id`,`code`),
	CONSTRAINT `uk_supplier_tenant_name` UNIQUE(`tenant_id`,`name`),
	CONSTRAINT `uk_supplier_account` UNIQUE(`gl_account_id`),
	CONSTRAINT `uk_supplier_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
CREATE TABLE `cash_bank_account` (
	`cash_bank_account_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`gl_account_id` bigint unsigned NOT NULL,
	`account_kind` enum('cash_drawer','petty_cash','bank','mobile_wallet','card_settlement') NOT NULL,
	`bank_name` varchar(120),
	`branch_name` varchar(120),
	`account_no` varchar(34),
	`iban` varchar(34),
	`branch_id` bigint unsigned,
	`opening_balance_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`opening_balance_date` date,
	`allow_negative` boolean NOT NULL DEFAULT false,
	`is_default_for_sales` boolean NOT NULL DEFAULT false,
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `cash_bank_account_cash_bank_account_id` PRIMARY KEY(`cash_bank_account_id`),
	CONSTRAINT `uk_cash_bank_gl_account` UNIQUE(`gl_account_id`)
);
--> statement-breakpoint
CREATE TABLE `payment_allocation` (
	`payment_allocation_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`payment_id` bigint unsigned NOT NULL,
	`target_document_type_id` bigint unsigned NOT NULL,
	`target_document_id` bigint unsigned NOT NULL,
	`allocated_amount` decimal(15,2) NOT NULL,
	`allocated_at` datetime(3) NOT NULL,
	`allocated_by` bigint unsigned,
	`is_auto` boolean NOT NULL DEFAULT false,
	`reversed_at` datetime(3),
	`reversal_of_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	CONSTRAINT `payment_allocation_payment_allocation_id` PRIMARY KEY(`payment_allocation_id`),
	CONSTRAINT `uk_payment_alloc` UNIQUE(`payment_id`,`target_document_type_id`,`target_document_id`),
	CONSTRAINT `ck_alloc_amount` CHECK(`payment_allocation`.`allocated_amount` > 0)
);
--> statement-breakpoint
CREATE TABLE `payment_method` (
	`payment_method_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	`direction_allowed` enum('in','out','both') NOT NULL DEFAULT 'both',
	`default_cash_bank_account_id` bigint unsigned,
	`requires_reference` boolean NOT NULL DEFAULT false,
	`requires_bank_account` boolean NOT NULL DEFAULT false,
	`requires_cheque_details` boolean NOT NULL DEFAULT false,
	`settlement_lag_days` smallint unsigned NOT NULL DEFAULT 0,
	`is_counter_method` boolean NOT NULL DEFAULT false,
	`min_permission_id` bigint unsigned,
	CONSTRAINT `payment_method_payment_method_id` PRIMARY KEY(`payment_method_id`),
	CONSTRAINT `uk_payment_method_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `payment` (
	`payment_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`direction` enum('out','in') NOT NULL,
	`party_kind` enum('supplier','customer','employee','other') NOT NULL DEFAULT 'supplier',
	`supplier_id` bigint unsigned,
	`customer_id` bigint unsigned,
	`other_party_name` varchar(160),
	`payment_method_id` bigint unsigned NOT NULL,
	`cash_bank_account_id` bigint unsigned NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`allocated_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`unallocated_amount` decimal(15,2) GENERATED ALWAYS AS (`amount` - `allocated_amount`) STORED NOT NULL,
	`allocation_mode` enum('specific','oldest_first','on_account') NOT NULL DEFAULT 'oldest_first',
	`reference_no` varchar(64),
	`cheque_no` varchar(32),
	`cheque_date` date,
	`cheque_status` enum('issued','presented','cleared','bounced','cancelled'),
	`journal_entry_id` bigint unsigned,
	CONSTRAINT `payment_payment_id` PRIMARY KEY(`payment_id`),
	CONSTRAINT `uk_payment_tenant_doc_number` UNIQUE(`tenant_id`,`doc_number`),
	CONSTRAINT `uk_payment_journal_entry` UNIQUE(`journal_entry_id`),
	CONSTRAINT `ck_payment_amount` CHECK(`payment`.`amount` > 0),
	CONSTRAINT `ck_payment_alloc` CHECK(`payment`.`allocated_amount` >= 0 and `payment`.`allocated_amount` <= `payment`.`amount`)
);
--> statement-breakpoint
CREATE TABLE `adjustment_reason` (
	`adjustment_reason_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	`direction` enum('increase','decrease','both') NOT NULL DEFAULT 'both',
	`gl_account_id` bigint unsigned NOT NULL,
	`requires_approval` boolean NOT NULL DEFAULT false,
	`approval_threshold_amount` decimal(15,2),
	`requires_note` boolean NOT NULL DEFAULT false,
	`affects_shrinkage_kpi` boolean NOT NULL DEFAULT true,
	CONSTRAINT `adjustment_reason_adjustment_reason_id` PRIMARY KEY(`adjustment_reason_id`),
	CONSTRAINT `uk_adjustment_reason_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `item_cost_snapshot` (
	`item_cost_snapshot_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`effective_at` datetime(3) NOT NULL,
	`posting_date` date NOT NULL,
	`avg_unit_cost` decimal(15,5) NOT NULL,
	`previous_avg_unit_cost` decimal(15,5) NOT NULL,
	`qty_on_hand_before` decimal(15,4) NOT NULL,
	`qty_in` decimal(15,4) NOT NULL,
	`unit_cost_in` decimal(15,5) NOT NULL,
	`cost_basis` enum('net_rate','gross_price','manual','migration') NOT NULL,
	`source_movement_id` bigint unsigned,
	`document_type_id` bigint unsigned,
	`source_document_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	CONSTRAINT `item_cost_snapshot_item_cost_snapshot_id` PRIMARY KEY(`item_cost_snapshot_id`),
	CONSTRAINT `uk_cost_snapshot_movement` UNIQUE(`source_movement_id`)
);
--> statement-breakpoint
CREATE TABLE `stock_adjustment_line` (
	`line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`stock_adjustment_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`qty` decimal(15,4) NOT NULL,
	`unit_cost` decimal(15,5) NOT NULL,
	`cost_amount` decimal(15,2) NOT NULL,
	`qty_before` decimal(15,4),
	`notes` varchar(255),
	`legacy_key` varchar(160),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `stock_adjustment_line_line_id` PRIMARY KEY(`line_id`),
	CONSTRAINT `uk_adj_line` UNIQUE(`stock_adjustment_id`,`line_no`)
);
--> statement-breakpoint
CREATE TABLE `stock_adjustment` (
	`stock_adjustment_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`adjustment_reason_id` bigint unsigned NOT NULL,
	`direction` enum('increase','decrease') NOT NULL,
	`total_qty` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`total_cost_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`update_avg_cost` boolean NOT NULL DEFAULT false,
	`requires_approval` boolean NOT NULL DEFAULT false,
	`approved_by` bigint unsigned,
	`approved_at` datetime(3),
	`stock_take_id` bigint unsigned,
	CONSTRAINT `stock_adjustment_stock_adjustment_id` PRIMARY KEY(`stock_adjustment_id`),
	CONSTRAINT `uk_stock_adjustment_doc` UNIQUE(`doc_series_id`,`doc_number`),
	CONSTRAINT `ck_adjustment_approval` CHECK(`stock_adjustment`.`requires_approval` = 0 or `stock_adjustment`.`status` <> 'posted' or `stock_adjustment`.`approved_by` is not null)
);
--> statement-breakpoint
CREATE TABLE `stock_balance` (
	`branch_id` bigint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`qty_on_hand` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_reserved` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_available` decimal(15,4) GENERATED ALWAYS AS (`qty_on_hand` - `qty_reserved`) STORED NOT NULL,
	`last_movement_id` bigint unsigned,
	`last_movement_at` datetime(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `stock_balance_branch_id_item_id_stock_lot_id_pk` PRIMARY KEY(`branch_id`,`item_id`,`stock_lot_id`)
);
--> statement-breakpoint
CREATE TABLE `stock_movement` (
	`stock_movement_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`occurred_at` datetime(3) NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`source_document_id` bigint unsigned NOT NULL,
	`source_line_id` bigint unsigned,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`qty_delta` decimal(15,4) NOT NULL,
	`direction` enum('in','out') GENERATED ALWAYS AS (if(`qty_delta` >= 0, 'in', 'out')) STORED NOT NULL,
	`unit_cost` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`cost_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`qty_before` decimal(15,4),
	`qty_after` decimal(15,4),
	`reversal_of_id` bigint unsigned,
	`reason_id` bigint unsigned,
	`notes` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	CONSTRAINT `stock_movement_stock_movement_id` PRIMARY KEY(`stock_movement_id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_category` (
	`purchase_category_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	`qty_basis` enum('pack','loose') NOT NULL DEFAULT 'pack',
	`counterparty` enum('supplier','equity','customer') NOT NULL DEFAULT 'supplier',
	`is_return` boolean NOT NULL DEFAULT false,
	`is_opening` boolean NOT NULL DEFAULT false,
	CONSTRAINT `purchase_category_purchase_category_id` PRIMARY KEY(`purchase_category_id`),
	CONSTRAINT `uk_purchase_category_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `purchase_invoice_line` (
	`purchase_invoice_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`purchase_invoice_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`qty_pack` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_loose` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_bonus` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`pack_units_at_txn` smallint unsigned NOT NULL DEFAULT 1,
	`qty_base` decimal(15,4) NOT NULL,
	`unit_purchase_price` decimal(15,4) NOT NULL,
	`net_rate` decimal(15,4) NOT NULL,
	`unit_cost_in` decimal(15,5) NOT NULL,
	`unit_sale_price` decimal(15,4) NOT NULL,
	`unit_sales_tax` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`discount_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`line_gross_amount` decimal(15,4) NOT NULL,
	`line_discount_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_net_amount` decimal(15,4) NOT NULL,
	`line_tax_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`avg_cost_before` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`avg_cost_after` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`expiry_date_captured` date,
	`batch_no_captured` varchar(64),
	`capture_method` enum('scan_gs1','manual','copied_previous','defaulted_unknown') NOT NULL DEFAULT 'manual',
	`legacy_row_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `purchase_invoice_line_purchase_invoice_line_id` PRIMARY KEY(`purchase_invoice_line_id`),
	CONSTRAINT `uk_purchase_line` UNIQUE(`purchase_invoice_id`,`line_no`),
	CONSTRAINT `uk_purchase_line_legacy` UNIQUE(`legacy_row_id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_invoice` (
	`purchase_invoice_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`supplier_id` bigint unsigned NOT NULL,
	`purchase_category_id` bigint unsigned NOT NULL,
	`supplier_invoice_no` varchar(64),
	`supplier_invoice_date` date,
	`due_date` date,
	`gross_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`line_discount_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`invoice_discount_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`invoice_discount_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`net_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`sales_tax_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`advance_income_tax_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`other_charges_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`invoice_total` decimal(15,2) NOT NULL DEFAULT '0.00',
	`paid_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`balance_amount` decimal(15,2) GENERATED ALWAYS AS (`invoice_total` - `paid_amount`) STORED NOT NULL,
	`cost_basis` enum('net_rate','gross_price') NOT NULL DEFAULT 'net_rate',
	`total_qty` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`journal_entry_id` bigint unsigned,
	`purchase_order_id` bigint unsigned,
	CONSTRAINT `purchase_invoice_purchase_invoice_id` PRIMARY KEY(`purchase_invoice_id`),
	CONSTRAINT `uk_purchase_invoice_doc_no` UNIQUE(`tenant_id`,`doc_number`),
	CONSTRAINT `uk_purchase_invoice_journal` UNIQUE(`journal_entry_id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_order_line` (
	`purchase_order_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`purchase_order_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`qty_ordered` decimal(15,4) NOT NULL,
	`qty_received` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_outstanding` decimal(15,4) GENERATED ALWAYS AS (`qty_ordered` - `qty_received`) STORED NOT NULL,
	`unit_price` decimal(15,4),
	`expected_date` date,
	`reorder_qty` decimal(15,4),
	`optimum_qty` decimal(15,4),
	`sold_qty` decimal(15,4),
	`return_qty` decimal(15,4),
	`transit_stock` decimal(15,4),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `purchase_order_line_purchase_order_line_id` PRIMARY KEY(`purchase_order_line_id`),
	CONSTRAINT `uk_po_line` UNIQUE(`purchase_order_id`,`line_no`)
);
--> statement-breakpoint
CREATE TABLE `purchase_order` (
	`purchase_order_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`supplier_id` bigint unsigned NOT NULL,
	`expected_date` date,
	`order_status` enum('open','partial','received','closed','cancelled') NOT NULL DEFAULT 'open',
	`total_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	CONSTRAINT `purchase_order_purchase_order_id` PRIMARY KEY(`purchase_order_id`),
	CONSTRAINT `uk_purchase_order_doc_no` UNIQUE(`tenant_id`,`doc_number`)
);
--> statement-breakpoint
CREATE TABLE `purchase_return_line` (
	`purchase_return_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`purchase_return_id` bigint unsigned NOT NULL,
	`purchase_invoice_line_id` bigint unsigned,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`qty_pack` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_loose` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_bonus` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`pack_units_at_txn` smallint unsigned NOT NULL DEFAULT 1,
	`qty_base` decimal(15,4) NOT NULL,
	`unit_purchase_price` decimal(15,4) NOT NULL,
	`net_rate` decimal(15,4) NOT NULL,
	`unit_cost_in` decimal(15,5) NOT NULL,
	`discount_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`line_gross_amount` decimal(15,4) NOT NULL,
	`line_discount_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_net_amount` decimal(15,4) NOT NULL,
	`line_tax_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`avg_cost_before` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`avg_cost_after` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`expiry_date_captured` date,
	`batch_no_captured` varchar(64),
	`capture_method` enum('scan_gs1','manual','copied_previous','defaulted_unknown') NOT NULL DEFAULT 'manual',
	`legacy_row_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `purchase_return_line_purchase_return_line_id` PRIMARY KEY(`purchase_return_line_id`),
	CONSTRAINT `uk_purchase_return_line` UNIQUE(`purchase_return_id`,`line_no`),
	CONSTRAINT `uk_pr_line_legacy` UNIQUE(`legacy_row_id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_return` (
	`purchase_return_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`purchase_invoice_id` bigint unsigned,
	`supplier_id` bigint unsigned NOT NULL,
	`purchase_category_id` bigint unsigned NOT NULL,
	`reason_id` bigint unsigned,
	`gross_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`line_discount_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`net_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`sales_tax_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`return_total` decimal(15,2) NOT NULL DEFAULT '0.00',
	`total_qty` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`credit_note_no` varchar(64),
	`journal_entry_id` bigint unsigned,
	CONSTRAINT `purchase_return_purchase_return_id` PRIMARY KEY(`purchase_return_id`),
	CONSTRAINT `uk_purchase_return_doc_no` UNIQUE(`tenant_id`,`doc_number`),
	CONSTRAINT `uk_purchase_return_journal` UNIQUE(`journal_entry_id`)
);
--> statement-breakpoint
CREATE TABLE `sale_category` (
	`sale_category_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`code` varchar(32) NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`is_enabled` boolean NOT NULL DEFAULT true,
	`is_default` boolean NOT NULL DEFAULT false,
	`sort_order` smallint unsigned NOT NULL DEFAULT 100,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`deleted_at` datetime(3),
	`deleted_by` bigint unsigned,
	`delete_reason` varchar(255),
	`counterparty` enum('cash','customer_account') NOT NULL DEFAULT 'cash',
	`default_cash_account_id` bigint unsigned,
	`is_return` boolean NOT NULL DEFAULT false,
	`affects_stock` boolean NOT NULL DEFAULT true,
	CONSTRAINT `sale_category_sale_category_id` PRIMARY KEY(`sale_category_id`),
	CONSTRAINT `uk_sale_category_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `sale_invoice_line` (
	`sale_invoice_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`sale_invoice_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`qty_pack` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_loose` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_bonus` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`pack_units_at_txn` smallint unsigned NOT NULL DEFAULT 1,
	`qty_base` decimal(15,4) NOT NULL,
	`unit_sale_price` decimal(15,4) NOT NULL,
	`pack_sale_price` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`item_flat_discount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`discount_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`line_gross_amount` decimal(15,4) NOT NULL,
	`line_discount_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`invoice_discount_allocated` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_net_amount` decimal(15,4) NOT NULL,
	`unit_sales_tax` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`tax_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`line_tax_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`unit_cost` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`line_cost_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_margin_amount` decimal(15,4) GENERATED ALWAYS AS (`line_net_amount` - `line_cost_amount`) STORED NOT NULL,
	`expiry_at_sale` date,
	`fefo_overridden` boolean NOT NULL DEFAULT false,
	`legacy_row_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `sale_invoice_line_sale_invoice_line_id` PRIMARY KEY(`sale_invoice_line_id`),
	CONSTRAINT `uk_sale_line` UNIQUE(`sale_invoice_id`,`line_no`),
	CONSTRAINT `uk_sale_line_legacy` UNIQUE(`legacy_row_id`),
	CONSTRAINT `ck_sale_line_qty` CHECK(`sale_invoice_line`.`qty_base` > 0),
	CONSTRAINT `ck_sale_line_pack` CHECK(`sale_invoice_line`.`pack_units_at_txn` >= 1)
);
--> statement-breakpoint
CREATE TABLE `sale_invoice_payment` (
	`sale_invoice_payment_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`sale_invoice_id` bigint unsigned NOT NULL,
	`payment_method_id` bigint unsigned NOT NULL,
	`cash_bank_account_id` bigint unsigned NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`reference_no` varchar(64),
	`card_last4` char(4),
	`wallet_txn_id` varchar(64),
	`sequence_no` smallint unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `sale_invoice_payment_sale_invoice_payment_id` PRIMARY KEY(`sale_invoice_payment_id`),
	CONSTRAINT `uk_sale_payment` UNIQUE(`sale_invoice_id`,`sequence_no`),
	CONSTRAINT `ck_sale_payment_amount` CHECK(`sale_invoice_payment`.`amount` > 0)
);
--> statement-breakpoint
CREATE TABLE `sale_invoice` (
	`sale_invoice_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`customer_id` bigint unsigned NOT NULL,
	`sale_category_id` bigint unsigned NOT NULL,
	`salesman_id` bigint unsigned,
	`gross_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`line_discount_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`invoice_discount_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`invoice_discount_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`net_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`sales_tax_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`advance_income_tax_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`fbr_pos_fee_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`other_charges_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`rounding_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`invoice_total` decimal(15,2) NOT NULL DEFAULT '0.00',
	`paid_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`change_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`balance_amount` decimal(15,2) GENERATED ALWAYS AS (`invoice_total` - `paid_amount`) STORED NOT NULL,
	`due_date` date,
	`total_qty` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_count` smallint unsigned NOT NULL DEFAULT 0,
	`cogs_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`journal_entry_id` bigint unsigned,
	CONSTRAINT `sale_invoice_sale_invoice_id` PRIMARY KEY(`sale_invoice_id`),
	CONSTRAINT `uk_sale_invoice_number` UNIQUE(`doc_series_id`,`doc_number`),
	CONSTRAINT `uk_sale_invoice_journal` UNIQUE(`journal_entry_id`),
	CONSTRAINT `uk_sale_invoice_legacy` UNIQUE(`legacy_id`),
	CONSTRAINT `ck_sale_invoice_totals` CHECK(`sale_invoice`.`invoice_total` >= 0 and `sale_invoice`.`paid_amount` >= 0)
);
--> statement-breakpoint
CREATE TABLE `sale_return_line` (
	`sale_return_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`sale_return_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`sale_invoice_line_id` bigint unsigned,
	`cost_basis` enum('original_cost','current_avg','sale_price_estimate') NOT NULL DEFAULT 'original_cost',
	`qty_pack` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_loose` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`qty_bonus` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`pack_units_at_txn` smallint unsigned NOT NULL DEFAULT 1,
	`qty_base` decimal(15,4) NOT NULL,
	`unit_sale_price` decimal(15,4) NOT NULL,
	`pack_sale_price` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`item_flat_discount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`discount_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`line_gross_amount` decimal(15,4) NOT NULL,
	`line_discount_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`invoice_discount_allocated` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_net_amount` decimal(15,4) NOT NULL,
	`unit_sales_tax` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`tax_percent` decimal(9,4) NOT NULL DEFAULT '0.0000',
	`line_tax_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`unit_cost` decimal(15,5) NOT NULL DEFAULT '0.00000',
	`line_cost_amount` decimal(15,4) NOT NULL DEFAULT '0.0000',
	`line_margin_amount` decimal(15,4) GENERATED ALWAYS AS (`line_net_amount` - `line_cost_amount`) STORED NOT NULL,
	`expiry_at_sale` date,
	`fefo_overridden` boolean NOT NULL DEFAULT false,
	`legacy_row_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `sale_return_line_sale_return_line_id` PRIMARY KEY(`sale_return_line_id`),
	CONSTRAINT `uk_sale_return_line` UNIQUE(`sale_return_id`,`line_no`),
	CONSTRAINT `uk_sale_return_line_legacy` UNIQUE(`legacy_row_id`),
	CONSTRAINT `ck_sr_line_qty` CHECK(`sale_return_line`.`qty_base` > 0),
	CONSTRAINT `ck_sr_line_pack` CHECK(`sale_return_line`.`pack_units_at_txn` >= 1)
);
--> statement-breakpoint
CREATE TABLE `sale_return` (
	`sale_return_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','confirmed','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`cancelled_at` datetime(3),
	`cancelled_by` bigint unsigned,
	`cancel_reason_id` bigint unsigned,
	`reversal_of_id` bigint unsigned,
	`notes` varchar(1000),
	`machine_name` varchar(64),
	`legacy_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	`sale_invoice_id` bigint unsigned,
	`customer_id` bigint unsigned NOT NULL,
	`sale_category_id` bigint unsigned NOT NULL,
	`refund_method_id` bigint unsigned,
	`cash_bank_account_id` bigint unsigned,
	`gross_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`net_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`sales_tax_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`fbr_pos_fee_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`return_total` decimal(15,2) NOT NULL DEFAULT '0.00',
	`cogs_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`journal_entry_id` bigint unsigned,
	CONSTRAINT `sale_return_sale_return_id` PRIMARY KEY(`sale_return_id`),
	CONSTRAINT `uk_sale_return_number` UNIQUE(`doc_series_id`,`doc_number`),
	CONSTRAINT `uk_sale_return_journal` UNIQUE(`journal_entry_id`),
	CONSTRAINT `uk_sale_return_legacy` UNIQUE(`legacy_id`)
);
--> statement-breakpoint
ALTER TABLE `branch` ADD CONSTRAINT `branch_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `app_user` ADD CONSTRAINT `app_user_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `app_user` ADD CONSTRAINT `app_user_default_branch_id_branch_branch_id_fk` FOREIGN KEY (`default_branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_session` ADD CONSTRAINT `user_session_user_id_app_user_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_session` ADD CONSTRAINT `user_session_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_session` ADD CONSTRAINT `user_session_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_session` ADD CONSTRAINT `user_session_revoked_by_app_user_user_id_fk` FOREIGN KEY (`revoked_by`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permission` ADD CONSTRAINT `role_permission_role_id_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permission` ADD CONSTRAINT `role_permission_permission_id_permission_permission_id_fk` FOREIGN KEY (`permission_id`) REFERENCES `permission`(`permission_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_permission` ADD CONSTRAINT `role_permission_granted_by_app_user_user_id_fk` FOREIGN KEY (`granted_by`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role` ADD CONSTRAINT `role_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_role` ADD CONSTRAINT `user_role_user_id_app_user_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_role` ADD CONSTRAINT `user_role_role_id_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_role` ADD CONSTRAINT `user_role_assigned_by_app_user_user_id_fk` FOREIGN KEY (`assigned_by`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `option_item` ADD CONSTRAINT `option_item_option_list_id_option_list_option_list_id_fk` FOREIGN KEY (`option_list_id`) REFERENCES `option_list`(`option_list_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `option_item` ADD CONSTRAINT `option_item_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `option_list` ADD CONSTRAINT `option_list_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_visibility` ADD CONSTRAINT `item_visibility_item_id_item_item_id_fk` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_visibility` ADD CONSTRAINT `item_visibility_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item` ADD CONSTRAINT `item_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_lot` ADD CONSTRAINT `stock_lot_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_lot` ADD CONSTRAINT `stock_lot_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_lot` ADD CONSTRAINT `stock_lot_item_id_item_item_id_fk` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account_category` ADD CONSTRAINT `gl_account_category_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account_category` ADD CONSTRAINT `fk_gl_account_category_main` FOREIGN KEY (`gl_account_main_id`) REFERENCES `gl_account_main`(`gl_account_main_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account_main` ADD CONSTRAINT `gl_account_main_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account_sub` ADD CONSTRAINT `gl_account_sub_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account_sub` ADD CONSTRAINT `fk_gl_account_sub_category` FOREIGN KEY (`gl_account_category_id`) REFERENCES `gl_account_category`(`gl_account_category_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account` ADD CONSTRAINT `gl_account_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `gl_account` ADD CONSTRAINT `gl_account_gl_account_sub_id_gl_account_sub_gl_account_sub_id_fk` FOREIGN KEY (`gl_account_sub_id`) REFERENCES `gl_account_sub`(`gl_account_sub_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_entry` ADD CONSTRAINT `journal_entry_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_entry` ADD CONSTRAINT `journal_entry_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_entry` ADD CONSTRAINT `journal_entry_posted_by_app_user_user_id_fk` FOREIGN KEY (`posted_by`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_line` ADD CONSTRAINT `journal_line_journal_entry_id_journal_entry_journal_entry_id_fk` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entry`(`journal_entry_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_line` ADD CONSTRAINT `journal_line_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_line` ADD CONSTRAINT `journal_line_gl_account_id_gl_account_gl_account_id_fk` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `journal_line` ADD CONSTRAINT `journal_line_analysis_account_id_gl_account_gl_account_id_fk` FOREIGN KEY (`analysis_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `doc_series` ADD CONSTRAINT `doc_series_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `doc_series` ADD CONSTRAINT `doc_series_document_type_id_document_type_document_type_id_fk` FOREIGN KEY (`document_type_id`) REFERENCES `document_type`(`document_type_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `doc_series_counter` ADD CONSTRAINT `doc_series_counter_doc_series_id_doc_series_doc_series_id_fk` FOREIGN KEY (`doc_series_id`) REFERENCES `doc_series`(`doc_series_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `document_type` ADD CONSTRAINT `document_type_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fiscal_period` ADD CONSTRAINT `fiscal_period_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fiscal_period` ADD CONSTRAINT `fiscal_period_fiscal_year_id_fiscal_year_fiscal_year_id_fk` FOREIGN KEY (`fiscal_year_id`) REFERENCES `fiscal_year`(`fiscal_year_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fiscal_year` ADD CONSTRAINT `fiscal_year_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer` ADD CONSTRAINT `customer_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customer` ADD CONSTRAINT `customer_gl_account_id_gl_account_gl_account_id_fk` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `salesman` ADD CONSTRAINT `salesman_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier` ADD CONSTRAINT `supplier_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier` ADD CONSTRAINT `supplier_gl_account_id_gl_account_gl_account_id_fk` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_bank_account` ADD CONSTRAINT `cash_bank_account_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_bank_account` ADD CONSTRAINT `cash_bank_account_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_bank_account` ADD CONSTRAINT `fk_cash_bank_gl_account` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_allocation` ADD CONSTRAINT `payment_allocation_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_allocation` ADD CONSTRAINT `payment_allocation_payment_id_payment_payment_id_fk` FOREIGN KEY (`payment_id`) REFERENCES `payment`(`payment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_allocation` ADD CONSTRAINT `fk_payment_alloc_doc_type` FOREIGN KEY (`target_document_type_id`) REFERENCES `document_type`(`document_type_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_method` ADD CONSTRAINT `payment_method_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_method` ADD CONSTRAINT `fk_payment_method_default_cba` FOREIGN KEY (`default_cash_bank_account_id`) REFERENCES `cash_bank_account`(`cash_bank_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment` ADD CONSTRAINT `payment_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment` ADD CONSTRAINT `payment_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment` ADD CONSTRAINT `payment_payment_method_id_payment_method_payment_method_id_fk` FOREIGN KEY (`payment_method_id`) REFERENCES `payment_method`(`payment_method_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_cash_bank_account` FOREIGN KEY (`cash_bank_account_id`) REFERENCES `cash_bank_account`(`cash_bank_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `adjustment_reason` ADD CONSTRAINT `adjustment_reason_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `adjustment_reason` ADD CONSTRAINT `fk_adjustment_reason_gl` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_cost_snapshot` ADD CONSTRAINT `item_cost_snapshot_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_cost_snapshot` ADD CONSTRAINT `item_cost_snapshot_item_id_item_item_id_fk` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_cost_snapshot` ADD CONSTRAINT `fk_cost_snapshot_movement` FOREIGN KEY (`source_movement_id`) REFERENCES `stock_movement`(`stock_movement_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `item_cost_snapshot` ADD CONSTRAINT `fk_cost_snapshot_doc_type` FOREIGN KEY (`document_type_id`) REFERENCES `document_type`(`document_type_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `stock_adjustment_line_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `stock_adjustment_line_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `fk_adj_line_header` FOREIGN KEY (`stock_adjustment_id`) REFERENCES `stock_adjustment`(`stock_adjustment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `fk_adj_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment_line` ADD CONSTRAINT `fk_adj_line_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment` ADD CONSTRAINT `stock_adjustment_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment` ADD CONSTRAINT `stock_adjustment_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_adjustment` ADD CONSTRAINT `fk_stock_adjustment_reason` FOREIGN KEY (`adjustment_reason_id`) REFERENCES `adjustment_reason`(`adjustment_reason_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_item_id_item_item_id_fk` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_balance` ADD CONSTRAINT `stock_balance_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_balance` ADD CONSTRAINT `fk_balance_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_balance` ADD CONSTRAINT `fk_balance_last_movement` FOREIGN KEY (`last_movement_id`) REFERENCES `stock_movement`(`stock_movement_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `stock_movement_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_fiscal_period` FOREIGN KEY (`fiscal_period_id`) REFERENCES `fiscal_period`(`fiscal_period_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_document_type` FOREIGN KEY (`document_type_id`) REFERENCES `document_type`(`document_type_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_movement` ADD CONSTRAINT `fk_movement_reason` FOREIGN KEY (`reason_id`) REFERENCES `adjustment_reason`(`adjustment_reason_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_category` ADD CONSTRAINT `fk_purchase_category_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice_line` ADD CONSTRAINT `fk_pi_line_invoice` FOREIGN KEY (`purchase_invoice_id`) REFERENCES `purchase_invoice`(`purchase_invoice_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice_line` ADD CONSTRAINT `fk_pi_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice_line` ADD CONSTRAINT `fk_pi_line_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice_line` ADD CONSTRAINT `fk_pi_line_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice` ADD CONSTRAINT `fk_pi_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice` ADD CONSTRAINT `fk_pi_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice` ADD CONSTRAINT `fk_pi_category` FOREIGN KEY (`purchase_category_id`) REFERENCES `purchase_category`(`purchase_category_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice` ADD CONSTRAINT `fk_pi_journal` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entry`(`journal_entry_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_invoice` ADD CONSTRAINT `fk_pi_order` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_order`(`purchase_order_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_order_line` ADD CONSTRAINT `fk_po_line_order` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_order`(`purchase_order_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_order_line` ADD CONSTRAINT `fk_po_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_order_line` ADD CONSTRAINT `fk_po_line_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_order` ADD CONSTRAINT `fk_po_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_order` ADD CONSTRAINT `fk_po_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return_line` ADD CONSTRAINT `fk_pr_line_return` FOREIGN KEY (`purchase_return_id`) REFERENCES `purchase_return`(`purchase_return_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return_line` ADD CONSTRAINT `fk_pr_line_invoice_line` FOREIGN KEY (`purchase_invoice_line_id`) REFERENCES `purchase_invoice_line`(`purchase_invoice_line_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return_line` ADD CONSTRAINT `fk_pr_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return_line` ADD CONSTRAINT `fk_pr_line_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return_line` ADD CONSTRAINT `fk_pr_line_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return` ADD CONSTRAINT `fk_pr_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return` ADD CONSTRAINT `fk_pr_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return` ADD CONSTRAINT `fk_pr_invoice` FOREIGN KEY (`purchase_invoice_id`) REFERENCES `purchase_invoice`(`purchase_invoice_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return` ADD CONSTRAINT `fk_pr_category` FOREIGN KEY (`purchase_category_id`) REFERENCES `purchase_category`(`purchase_category_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_return` ADD CONSTRAINT `fk_pr_journal` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entry`(`journal_entry_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_category` ADD CONSTRAINT `fk_sale_category_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_line` ADD CONSTRAINT `fk_sale_line_invoice` FOREIGN KEY (`sale_invoice_id`) REFERENCES `sale_invoice`(`sale_invoice_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_line` ADD CONSTRAINT `fk_sale_line_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_line` ADD CONSTRAINT `fk_sale_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_line` ADD CONSTRAINT `fk_sale_line_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_line` ADD CONSTRAINT `fk_sale_line_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_payment` ADD CONSTRAINT `fk_sale_payment_invoice` FOREIGN KEY (`sale_invoice_id`) REFERENCES `sale_invoice`(`sale_invoice_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice_payment` ADD CONSTRAINT `fk_sale_payment_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_series` FOREIGN KEY (`doc_series_id`) REFERENCES `doc_series`(`doc_series_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_doc_type` FOREIGN KEY (`document_type_id`) REFERENCES `document_type`(`document_type_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_period` FOREIGN KEY (`fiscal_period_id`) REFERENCES `fiscal_period`(`fiscal_period_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_category` FOREIGN KEY (`sale_category_id`) REFERENCES `sale_category`(`sale_category_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_invoice` ADD CONSTRAINT `fk_sale_invoice_journal` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entry`(`journal_entry_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return_line` ADD CONSTRAINT `fk_sr_line_return` FOREIGN KEY (`sale_return_id`) REFERENCES `sale_return`(`sale_return_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return_line` ADD CONSTRAINT `fk_sr_line_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return_line` ADD CONSTRAINT `fk_sr_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return_line` ADD CONSTRAINT `fk_sr_line_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return_line` ADD CONSTRAINT `fk_sr_line_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_branch` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_series` FOREIGN KEY (`doc_series_id`) REFERENCES `doc_series`(`doc_series_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_doc_type` FOREIGN KEY (`document_type_id`) REFERENCES `document_type`(`document_type_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_period` FOREIGN KEY (`fiscal_period_id`) REFERENCES `fiscal_period`(`fiscal_period_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_invoice` FOREIGN KEY (`sale_invoice_id`) REFERENCES `sale_invoice`(`sale_invoice_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_category` FOREIGN KEY (`sale_category_id`) REFERENCES `sale_category`(`sale_category_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sale_return` ADD CONSTRAINT `fk_sale_return_journal` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entry`(`journal_entry_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_branch_tenant_active` ON `branch` (`tenant_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `ix_tenant_active` ON `tenant` (`is_active`,`name`);--> statement-breakpoint
CREATE INDEX `ix_app_user_tenant_active` ON `app_user` (`tenant_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `ix_user_session_user` ON `user_session` (`user_id`,`issued_at`);--> statement-breakpoint
CREATE INDEX `ix_user_session_live` ON `user_session` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `ix_user_session_tenant` ON `user_session` (`tenant_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `ix_role_permission_perm` ON `role_permission` (`permission_id`);--> statement-breakpoint
CREATE INDEX `ix_role_tenant` ON `role` (`tenant_id`,`is_system`);--> statement-breakpoint
CREATE INDEX `ix_user_role_role` ON `user_role` (`role_id`);--> statement-breakpoint
CREATE INDEX `ix_option_item_enabled` ON `option_item` (`option_list_id`,`is_enabled`,`sort_order`);--> statement-breakpoint
CREATE INDEX `ix_item_visibility_scope` ON `item_visibility` (`tenant_id`,`scope`,`is_visible`);--> statement-breakpoint
CREATE INDEX `ix_item_visibility_bulk` ON `item_visibility` (`bulk_operation_id`);--> statement-breakpoint
CREATE INDEX `ix_item_tenant_active_name` ON `item` (`tenant_id`,`is_active`,`name`);--> statement-breakpoint
CREATE INDEX `ix_stock_lot_expiry` ON `stock_lot` (`branch_id`,`expiry_date`,`lot_status`);--> statement-breakpoint
CREATE INDEX `ix_stock_lot_item_fefo` ON `stock_lot` (`item_id`,`lot_status`,`priority`,`expiry_date`);--> statement-breakpoint
CREATE INDEX `ix_stock_lot_batch` ON `stock_lot` (`batch_no`);--> statement-breakpoint
CREATE INDEX `ix_stock_lot_supplier` ON `stock_lot` (`supplier_id`,`received_on`);--> statement-breakpoint
CREATE INDEX `ix_gl_account_category_main` ON `gl_account_category` (`gl_account_main_id`);--> statement-breakpoint
CREATE INDEX `ix_gl_account_sub_category` ON `gl_account_sub` (`gl_account_category_id`);--> statement-breakpoint
CREATE INDEX `ix_gl_account_sub` ON `gl_account` (`gl_account_sub_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `ix_gl_account_nature` ON `gl_account` (`account_nature`,`is_active`);--> statement-breakpoint
CREATE INDEX `ix_journal_date` ON `journal_entry` (`tenant_id`,`entry_date`,`status`);--> statement-breakpoint
CREATE INDEX `ix_journal_type` ON `journal_entry` (`document_type_code`,`entry_date`);--> statement-breakpoint
CREATE INDEX `ix_jl_account_date` ON `journal_line` (`gl_account_id`,`journal_entry_id`);--> statement-breakpoint
CREATE INDEX `ix_jl_supplier` ON `journal_line` (`supplier_id`,`journal_entry_id`);--> statement-breakpoint
CREATE INDEX `ix_jl_customer` ON `journal_line` (`customer_id`,`journal_entry_id`);--> statement-breakpoint
CREATE INDEX `ix_jl_role` ON `journal_line` (`leg_role`);--> statement-breakpoint
CREATE INDEX `ix_audit_entity` ON `audit_log` (`entity_type`,`entity_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_actor` ON `audit_log` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_action` ON `audit_log` (`action`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_audit_request` ON `audit_log` (`request_id`);--> statement-breakpoint
CREATE INDEX `ix_audit_tenant` ON `audit_log` (`tenant_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `ix_fiscal_period_dates` ON `fiscal_period` (`tenant_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `ix_customer_tenant_active` ON `customer` (`tenant_id`,`is_active`,`name`);--> statement-breakpoint
CREATE INDEX `ix_salesman_tenant_enabled` ON `salesman` (`tenant_id`,`is_enabled`,`name`);--> statement-breakpoint
CREATE INDEX `ix_salesman_user` ON `salesman` (`user_id`);--> statement-breakpoint
CREATE INDEX `ix_supplier_tenant_active` ON `supplier` (`tenant_id`,`is_active`,`name`);--> statement-breakpoint
CREATE INDEX `ix_cash_bank_kind` ON `cash_bank_account` (`tenant_id`,`account_kind`,`is_active`);--> statement-breakpoint
CREATE INDEX `ix_alloc_target` ON `payment_allocation` (`target_document_type_id`,`target_document_id`);--> statement-breakpoint
CREATE INDEX `ix_payment_supplier` ON `payment` (`tenant_id`,`supplier_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_payment_customer` ON `payment` (`tenant_id`,`customer_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_payment_account` ON `payment` (`cash_bank_account_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_payment_open` ON `payment` (`tenant_id`,`party_kind`,`unallocated_amount`);--> statement-breakpoint
CREATE INDEX `ix_payment_cheque` ON `payment` (`cheque_status`,`cheque_date`);--> statement-breakpoint
CREATE INDEX `ix_cost_snapshot_item` ON `item_cost_snapshot` (`item_id`,`effective_at`);--> statement-breakpoint
CREATE INDEX `ix_adj_line_item` ON `stock_adjustment_line` (`item_id`);--> statement-breakpoint
CREATE INDEX `ix_adj_line_lot` ON `stock_adjustment_line` (`stock_lot_id`);--> statement-breakpoint
CREATE INDEX `ix_stock_adjustment_date` ON `stock_adjustment` (`tenant_id`,`branch_id`,`posting_date`,`status`);--> statement-breakpoint
CREATE INDEX `ix_stock_adjustment_reason` ON `stock_adjustment` (`adjustment_reason_id`);--> statement-breakpoint
CREATE INDEX `ix_balance_item` ON `stock_balance` (`item_id`,`branch_id`);--> statement-breakpoint
CREATE INDEX `ix_balance_nonzero` ON `stock_balance` (`item_id`,`qty_on_hand`);--> statement-breakpoint
CREATE INDEX `ix_movement_item_time` ON `stock_movement` (`item_id`,`posting_date`,`stock_movement_id`);--> statement-breakpoint
CREATE INDEX `ix_movement_lot` ON `stock_movement` (`stock_lot_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_movement_doc` ON `stock_movement` (`document_type_id`,`source_document_id`);--> statement-breakpoint
CREATE INDEX `ix_movement_balance` ON `stock_movement` (`branch_id`,`item_id`,`stock_lot_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_movement_period` ON `stock_movement` (`fiscal_period_id`,`document_type_id`);--> statement-breakpoint
CREATE INDEX `ix_purchase_line_item` ON `purchase_invoice_line` (`item_id`,`purchase_invoice_id`);--> statement-breakpoint
CREATE INDEX `ix_purchase_line_lot` ON `purchase_invoice_line` (`stock_lot_id`);--> statement-breakpoint
CREATE INDEX `ix_purchase_supplier` ON `purchase_invoice` (`supplier_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_purchase_open` ON `purchase_invoice` (`supplier_id`,`balance_amount`);--> statement-breakpoint
CREATE INDEX `ix_purchase_supp_inv` ON `purchase_invoice` (`supplier_id`,`supplier_invoice_no`);--> statement-breakpoint
CREATE INDEX `ix_po_line_item_open` ON `purchase_order_line` (`item_id`,`qty_outstanding`);--> statement-breakpoint
CREATE INDEX `ix_purchase_order_supplier` ON `purchase_order` (`supplier_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_purchase_order_status` ON `purchase_order` (`tenant_id`,`order_status`);--> statement-breakpoint
CREATE INDEX `ix_pr_line_item` ON `purchase_return_line` (`item_id`,`purchase_return_id`);--> statement-breakpoint
CREATE INDEX `ix_pr_line_lot` ON `purchase_return_line` (`stock_lot_id`);--> statement-breakpoint
CREATE INDEX `ix_purchase_return_supplier` ON `purchase_return` (`supplier_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_purchase_return_invoice` ON `purchase_return` (`purchase_invoice_id`);--> statement-breakpoint
CREATE INDEX `ix_sale_line_item` ON `sale_invoice_line` (`item_id`,`sale_invoice_id`);--> statement-breakpoint
CREATE INDEX `ix_sale_line_lot` ON `sale_invoice_line` (`stock_lot_id`);--> statement-breakpoint
CREATE INDEX `ix_sale_payment_method` ON `sale_invoice_payment` (`payment_method_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_sale_invoice_date` ON `sale_invoice` (`tenant_id`,`posting_date`,`status`);--> statement-breakpoint
CREATE INDEX `ix_sale_invoice_customer` ON `sale_invoice` (`customer_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_sale_invoice_salesman` ON `sale_invoice` (`salesman_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_sale_invoice_created` ON `sale_invoice` (`created_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_sr_line_item` ON `sale_return_line` (`item_id`,`sale_return_id`);--> statement-breakpoint
CREATE INDEX `ix_sr_line_lot` ON `sale_return_line` (`stock_lot_id`);--> statement-breakpoint
CREATE INDEX `ix_sr_line_orig` ON `sale_return_line` (`sale_invoice_line_id`);--> statement-breakpoint
CREATE INDEX `ix_sale_return_date` ON `sale_return` (`tenant_id`,`posting_date`,`status`);--> statement-breakpoint
CREATE INDEX `ix_sale_return_customer` ON `sale_return` (`customer_id`,`posting_date`);--> statement-breakpoint
CREATE INDEX `ix_sale_return_invoice` ON `sale_return` (`sale_invoice_id`);