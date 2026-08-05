CREATE TABLE `cashier_shift_count` (
	`count_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`cashier_shift_id` bigint unsigned NOT NULL,
	`denomination_amount` decimal(15,2) NOT NULL,
	`denomination_count` int unsigned NOT NULL,
	`line_total` decimal(15,2) GENERATED ALWAYS AS (`denomination_amount` * `denomination_count`) STORED,
	`counted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`counted_by` bigint unsigned,
	CONSTRAINT `cashier_shift_count_count_id` PRIMARY KEY(`count_id`),
	CONSTRAINT `uk_shift_count` UNIQUE(`cashier_shift_id`,`denomination_amount`)
);
--> statement-breakpoint
CREATE TABLE `cashier_shift` (
	`cashier_shift_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`cash_bank_account_id` bigint unsigned NOT NULL,
	`opened_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`closed_at` datetime(3),
	`opening_float_amount` decimal(15,2) NOT NULL DEFAULT '0.00',
	`expected_cash_amount` decimal(15,2),
	`counted_cash_amount` decimal(15,2),
	`variance_amount` decimal(15,2) GENERATED ALWAYS AS (`counted_cash_amount` - `expected_cash_amount`) STORED,
	`variance_reason` varchar(500),
	`variance_account_id` bigint unsigned,
	`status` enum('open','closed','approved') NOT NULL DEFAULT 'open',
	`approved_by` bigint unsigned,
	`approved_at` datetime(3),
	`journal_entry_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `cashier_shift_cashier_shift_id` PRIMARY KEY(`cashier_shift_id`),
	CONSTRAINT `uk_cashier_shift_doc_number` UNIQUE(`tenant_id`,`doc_number`)
);
--> statement-breakpoint
ALTER TABLE `cashier_shift_count` ADD CONSTRAINT `cashier_shift_count_counted_by_app_user_user_id_fk` FOREIGN KEY (`counted_by`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashier_shift_count` ADD CONSTRAINT `fk_shift_count_cashier_shift` FOREIGN KEY (`cashier_shift_id`) REFERENCES `cashier_shift`(`cashier_shift_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashier_shift` ADD CONSTRAINT `cashier_shift_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashier_shift` ADD CONSTRAINT `cashier_shift_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashier_shift` ADD CONSTRAINT `cashier_shift_user_id_app_user_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashier_shift` ADD CONSTRAINT `cashier_shift_approved_by_app_user_user_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cashier_shift` ADD CONSTRAINT `fk_cashier_shift_cash_bank_account` FOREIGN KEY (`cash_bank_account_id`) REFERENCES `cash_bank_account`(`cash_bank_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_cashier_shift_open` ON `cashier_shift` (`user_id`,`cash_bank_account_id`,`status`);--> statement-breakpoint
CREATE INDEX `ix_cashier_shift_account` ON `cashier_shift` (`cash_bank_account_id`,`opened_at`);