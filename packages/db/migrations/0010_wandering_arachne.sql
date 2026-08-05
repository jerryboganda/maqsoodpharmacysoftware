ALTER TABLE `role` ADD `display_name_ur` varchar(120);--> statement-breakpoint
ALTER TABLE `role` ADD `is_enabled` boolean DEFAULT true NOT NULL;