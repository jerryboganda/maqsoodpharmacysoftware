CREATE TABLE `cash_bank_reconciliation_match` (
	`reconciliation_id` bigint unsigned NOT NULL,
	`journal_line_id` bigint unsigned NOT NULL,
	`matched_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `uk_recon_match_line` UNIQUE(`reconciliation_id`,`journal_line_id`)
);
--> statement-breakpoint
CREATE TABLE `cash_bank_reconciliation` (
	`reconciliation_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`cash_bank_account_id` bigint unsigned NOT NULL,
	`statement_date` date NOT NULL,
	`statement_closing_balance` decimal(15,2) NOT NULL,
	`status` enum('open','completed') NOT NULL DEFAULT 'open',
	`difference_amount` decimal(15,2),
	`reason` varchar(500),
	`completed_at` datetime(3),
	`completed_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `cash_bank_reconciliation_reconciliation_id` PRIMARY KEY(`reconciliation_id`)
);
--> statement-breakpoint
ALTER TABLE `cash_bank_reconciliation_match` ADD CONSTRAINT `fk_recon_match_reconciliation` FOREIGN KEY (`reconciliation_id`) REFERENCES `cash_bank_reconciliation`(`reconciliation_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_bank_reconciliation_match` ADD CONSTRAINT `fk_recon_match_journal_line` FOREIGN KEY (`journal_line_id`) REFERENCES `journal_line`(`journal_line_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_bank_reconciliation` ADD CONSTRAINT `cash_bank_reconciliation_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cash_bank_reconciliation` ADD CONSTRAINT `fk_cash_bank_recon_account` FOREIGN KEY (`cash_bank_account_id`) REFERENCES `cash_bank_account`(`cash_bank_account_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_recon_match_line` ON `cash_bank_reconciliation_match` (`journal_line_id`);--> statement-breakpoint
CREATE INDEX `ix_cash_bank_recon_account` ON `cash_bank_reconciliation` (`cash_bank_account_id`,`statement_date`);