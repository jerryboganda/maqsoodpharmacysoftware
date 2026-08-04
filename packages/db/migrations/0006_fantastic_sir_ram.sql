CREATE TABLE `manual_voucher` (
	`manual_voucher_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`journal_entry_id` bigint unsigned,
	`voucher_category_id` bigint unsigned NOT NULL,
	`narration` varchar(500) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `manual_voucher_manual_voucher_id` PRIMARY KEY(`manual_voucher_id`),
	CONSTRAINT `uk_manual_voucher_journal_entry` UNIQUE(`journal_entry_id`)
);
--> statement-breakpoint
ALTER TABLE `manual_voucher` ADD CONSTRAINT `manual_voucher_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manual_voucher` ADD CONSTRAINT `fk_manual_voucher_journal_entry` FOREIGN KEY (`journal_entry_id`) REFERENCES `journal_entry`(`journal_entry_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manual_voucher` ADD CONSTRAINT `fk_manual_voucher_category` FOREIGN KEY (`voucher_category_id`) REFERENCES `option_item`(`option_item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_manual_voucher_category` ON `manual_voucher` (`voucher_category_id`);--> statement-breakpoint
CREATE INDEX `ix_manual_voucher_tenant` ON `manual_voucher` (`tenant_id`);