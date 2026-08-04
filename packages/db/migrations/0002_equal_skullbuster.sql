CREATE TABLE `idempotency_key` (
	`idem_key` char(36) NOT NULL,
	`endpoint` varchar(120) NOT NULL,
	`actor_user_id` bigint unsigned,
	`request_hash` char(64) NOT NULL,
	`status` enum('in_progress','succeeded','failed') NOT NULL,
	`response_status` smallint,
	`response_body` json,
	`resource_type` varchar(64),
	`resource_id` bigint unsigned,
	`created_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `idempotency_key_idem_key_endpoint_pk` PRIMARY KEY(`idem_key`,`endpoint`)
);
--> statement-breakpoint
CREATE INDEX `ix_idem_expiry` ON `idempotency_key` (`expires_at`);