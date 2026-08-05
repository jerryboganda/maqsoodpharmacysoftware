CREATE TABLE `visibility_bulk_operation` (
	`bulk_operation_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`is_visible` boolean NOT NULL,
	`reason` varchar(500) NOT NULL,
	`applied_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`applied_by` bigint unsigned,
	`undone_at` datetime(3),
	`undone_by` bigint unsigned,
	CONSTRAINT `visibility_bulk_operation_bulk_operation_id` PRIMARY KEY(`bulk_operation_id`)
);
--> statement-breakpoint
ALTER TABLE `visibility_bulk_operation` ADD CONSTRAINT `visibility_bulk_operation_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_visibility_bulk_op_tenant` ON `visibility_bulk_operation` (`tenant_id`,`applied_at`);--> statement-breakpoint
ALTER TABLE `item_visibility` ADD CONSTRAINT `fk_item_visibility_bulk_operation` FOREIGN KEY (`bulk_operation_id`) REFERENCES `visibility_bulk_operation`(`bulk_operation_id`) ON DELETE no action ON UPDATE no action;