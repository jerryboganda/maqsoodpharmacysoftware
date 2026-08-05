CREATE TABLE `role_limit` (
	`role_id` bigint unsigned NOT NULL,
	`limit_key` varchar(64) NOT NULL,
	`limit_value` decimal(18,4) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `role_limit_role_id_limit_key_pk` PRIMARY KEY(`role_id`,`limit_key`)
);
--> statement-breakpoint
CREATE TABLE `role_scope` (
	`role_id` bigint unsigned NOT NULL,
	`scope_type` enum('warehouse','cash_bank_account','price_type','supplier_category','voucher_category') NOT NULL,
	`scope_ref_id` bigint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `role_scope_role_id_scope_type_scope_ref_id_pk` PRIMARY KEY(`role_id`,`scope_type`,`scope_ref_id`)
);
--> statement-breakpoint
ALTER TABLE `role_limit` ADD CONSTRAINT `role_limit_role_id_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `role_scope` ADD CONSTRAINT `role_scope_role_id_role_role_id_fk` FOREIGN KEY (`role_id`) REFERENCES `role`(`role_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_role_scope_role` ON `role_scope` (`role_id`,`scope_type`);