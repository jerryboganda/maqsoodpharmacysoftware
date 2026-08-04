CREATE TABLE `expense_category` (
	`expense_category_id` bigint unsigned AUTO_INCREMENT NOT NULL,
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
	`gl_account_id` bigint unsigned NOT NULL,
	`is_system` boolean NOT NULL DEFAULT false,
	`remarks` varchar(1000),
	CONSTRAINT `expense_category_expense_category_id` PRIMARY KEY(`expense_category_id`),
	CONSTRAINT `uk_expense_category_tenant_code` UNIQUE(`tenant_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `expense_line` (
	`expense_line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`expense_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`expense_category_id` bigint unsigned NOT NULL,
	`amount` decimal(15,2) NOT NULL,
	`memo` varchar(500),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `expense_line_expense_line_id` PRIMARY KEY(`expense_line_id`),
	CONSTRAINT `uk_expense_line` UNIQUE(`expense_id`,`line_no`),
	CONSTRAINT `ck_expense_line_amount` CHECK(`expense_line`.`amount` > 0)
);
--> statement-breakpoint
CREATE TABLE `expense` (
	`expense_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`expense_date` date NOT NULL,
	`cash_bank_account_id` bigint unsigned NOT NULL,
	`total_amount` decimal(15,2) NOT NULL,
	`description` varchar(500),
	`status` enum('draft','posted','cancelled','reversed') NOT NULL DEFAULT 'draft',
	`journal_entry_id` bigint unsigned,
	`posted_at` datetime(3),
	`posted_by` bigint unsigned,
	`reversal_of_expense_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `expense_expense_id` PRIMARY KEY(`expense_id`),
	CONSTRAINT `uk_expense_tenant_doc_number` UNIQUE(`tenant_id`,`doc_number`),
	CONSTRAINT `uk_expense_journal_entry` UNIQUE(`journal_entry_id`),
	CONSTRAINT `ck_expense_total_amount` CHECK(`expense`.`total_amount` > 0)
);
--> statement-breakpoint
ALTER TABLE `expense_category` ADD CONSTRAINT `expense_category_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense_category` ADD CONSTRAINT `fk_expense_category_gl` FOREIGN KEY (`gl_account_id`) REFERENCES `gl_account`(`gl_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense_line` ADD CONSTRAINT `fk_expense_line_header` FOREIGN KEY (`expense_id`) REFERENCES `expense`(`expense_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense_line` ADD CONSTRAINT `fk_expense_line_category` FOREIGN KEY (`expense_category_id`) REFERENCES `expense_category`(`expense_category_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense_line` ADD CONSTRAINT `fk_expense_line_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense` ADD CONSTRAINT `expense_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense` ADD CONSTRAINT `expense_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expense` ADD CONSTRAINT `fk_expense_cash_bank_account` FOREIGN KEY (`cash_bank_account_id`) REFERENCES `cash_bank_account`(`cash_bank_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_expense_category_enabled` ON `expense_category` (`tenant_id`,`is_enabled`,`sort_order`);--> statement-breakpoint
CREATE INDEX `ix_expense_line_category` ON `expense_line` (`expense_category_id`,`expense_id`);--> statement-breakpoint
CREATE INDEX `ix_expense_account` ON `expense` (`cash_bank_account_id`,`expense_date`);--> statement-breakpoint
CREATE INDEX `ix_expense_date` ON `expense` (`tenant_id`,`expense_date`,`status`);--> statement-breakpoint
CREATE INDEX `ix_expense_reversal` ON `expense` (`reversal_of_expense_id`);