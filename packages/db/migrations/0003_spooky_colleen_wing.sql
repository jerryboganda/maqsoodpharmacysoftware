ALTER TABLE `user_session` ADD `token_hash` char(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `user_session` ADD CONSTRAINT `uk_user_session_token_hash` UNIQUE(`token_hash`);