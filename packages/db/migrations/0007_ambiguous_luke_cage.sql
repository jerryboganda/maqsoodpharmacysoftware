CREATE TABLE `notification` (
	`notification_id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`tenant_id` bigint unsigned NOT NULL,
	`recipient_user_id` bigint unsigned,
	`recipient_role_key` varchar(64),
	`kind` varchar(48) NOT NULL,
	`severity` enum('info','warning','critical') NOT NULL DEFAULT 'info',
	`title` varchar(200) NOT NULL,
	`body` varchar(1000) NOT NULL,
	`link` varchar(255),
	`source_type` varchar(48) NOT NULL,
	`source_id` bigint unsigned,
	`read_at` datetime(3),
	`read_by` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` bigint unsigned,
	`created_source` enum('ui','api','migration','system_job','import') NOT NULL DEFAULT 'ui',
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_by` bigint unsigned,
	`row_version` int unsigned NOT NULL DEFAULT 1,
	CONSTRAINT `notification_notification_id` PRIMARY KEY(`notification_id`),
	CONSTRAINT `uk_notification_source` UNIQUE(`tenant_id`,`source_type`,`source_id`,`kind`)
);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `is_sensitive` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `notification` ADD CONSTRAINT `notification_tenant_id_tenant_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`tenant_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification` ADD CONSTRAINT `notification_recipient_user_id_app_user_user_id_fk` FOREIGN KEY (`recipient_user_id`) REFERENCES `app_user`(`user_id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ix_notification_recipient` ON `notification` (`tenant_id`,`recipient_user_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `ix_notification_role` ON `notification` (`tenant_id`,`recipient_role_key`,`read_at`);