CREATE TABLE `origin_routes` (
	`ref_hash` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`service` text NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_origin_routes_app_expiry` ON `origin_routes` (`app_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `origin_send_attempts` (
	`app_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `idempotency_key`)
);
