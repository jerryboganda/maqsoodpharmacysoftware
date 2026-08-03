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
	`received_on` date,
	`receipt_unit_cost` decimal(15,4),
	`lot_status` enum('available','quarantined','expired','recalled','consumed') NOT NULL DEFAULT 'available',
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
	CONSTRAINT `uk_stock_lot_identity` UNIQUE(`item_id`,`batch_key`,`expiry_key`)
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
CREATE INDEX `ix_audit_tenant` ON `audit_log` (`tenant_id`,`occurred_at`);