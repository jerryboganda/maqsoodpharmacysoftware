ALTER TABLE `branch` ADD `drug_sale_licence_no` varchar(64);--> statement-breakpoint
ALTER TABLE `branch` ADD `drug_licence_expiry_date` date;--> statement-breakpoint
ALTER TABLE `sale_invoice_line` ADD `dispensing_note` varchar(500);