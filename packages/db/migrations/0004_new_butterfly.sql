CREATE TABLE `stock_take_line` (
	`line_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`stock_take_id` bigint unsigned NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`line_no` smallint unsigned NOT NULL,
	`item_id` bigint unsigned NOT NULL,
	`stock_lot_id` bigint unsigned NOT NULL,
	`qty_system` decimal(15,4) NOT NULL,
	`qty_counted` decimal(15,4),
	`qty_variance` decimal(15,4) GENERATED ALWAYS AS (`qty_counted` - `qty_system`) STORED,
	`unit_cost_snapshot` decimal(15,5) NOT NULL,
	`captured_batch_no` varchar(40),
	`captured_expiry_date` date,
	`counted_by` bigint unsigned,
	`counted_at` datetime(3),
	`adjustment_line_id` bigint unsigned,
	`notes` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `stock_take_line_line_id` PRIMARY KEY(`line_id`),
	CONSTRAINT `uk_stock_take_line_lot` UNIQUE(`stock_take_id`,`stock_lot_id`),
	CONSTRAINT `uk_stock_take_line_no` UNIQUE(`stock_take_id`,`line_no`),
	CONSTRAINT `ck_stock_take_line_qty_nonneg` CHECK(`stock_take_line`.`qty_system` >= 0 and (`stock_take_line`.`qty_counted` is null or `stock_take_line`.`qty_counted` >= 0))
);
--> statement-breakpoint
CREATE TABLE `stock_take` (
	`stock_take_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`branch_id` bigint unsigned NOT NULL,
	`doc_number` varchar(32) NOT NULL,
	`doc_series_id` bigint unsigned NOT NULL,
	`document_type_id` bigint unsigned NOT NULL,
	`document_date` date NOT NULL,
	`posting_date` date NOT NULL,
	`fiscal_period_id` bigint unsigned NOT NULL,
	`status` enum('draft','counting','reviewed','closed','cancelled') NOT NULL DEFAULT 'draft',
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
	`scope_item_id` bigint unsigned,
	`scope_category_id` bigint unsigned,
	`count_sheet_generated_at` datetime(3),
	`reviewed_by` bigint unsigned,
	`reviewed_at` datetime(3),
	`closed_by` bigint unsigned,
	`closed_at` datetime(3),
	`increase_adjustment_id` bigint unsigned,
	`decrease_adjustment_id` bigint unsigned,
	CONSTRAINT `stock_take_stock_take_id` PRIMARY KEY(`stock_take_id`),
	CONSTRAINT `uk_stock_take_doc` UNIQUE(`doc_series_id`,`doc_number`)
);
--> statement-breakpoint
ALTER TABLE `stock_take_line` ADD CONSTRAINT `stock_take_line_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take_line` ADD CONSTRAINT `stock_take_line_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take_line` ADD CONSTRAINT `fk_stock_take_line_header` FOREIGN KEY (`stock_take_id`) REFERENCES `stock_take`(`stock_take_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take_line` ADD CONSTRAINT `fk_stock_take_line_item` FOREIGN KEY (`item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take_line` ADD CONSTRAINT `fk_stock_take_line_lot` FOREIGN KEY (`stock_lot_id`) REFERENCES `stock_lot`(`stock_lot_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take_line` ADD CONSTRAINT `fk_stock_take_line_adj_line` FOREIGN KEY (`adjustment_line_id`) REFERENCES `stock_adjustment_line`(`line_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take` ADD CONSTRAINT `stock_take_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take` ADD CONSTRAINT `stock_take_branch_id_branch_branch_id_fk` FOREIGN KEY (`branch_id`) REFERENCES `branch`(`branch_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take` ADD CONSTRAINT `fk_stock_take_scope_item` FOREIGN KEY (`scope_item_id`) REFERENCES `item`(`item_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take` ADD CONSTRAINT `fk_stock_take_increase_adj` FOREIGN KEY (`increase_adjustment_id`) REFERENCES `stock_adjustment`(`stock_adjustment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stock_take` ADD CONSTRAINT `fk_stock_take_decrease_adj` FOREIGN KEY (`decrease_adjustment_id`) REFERENCES `stock_adjustment`(`stock_adjustment_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_stock_take_line_item` ON `stock_take_line` (`item_id`);--> statement-breakpoint
CREATE INDEX `ix_stock_take_date` ON `stock_take` (`tenant_id`,`branch_id`,`posting_date`,`status`);