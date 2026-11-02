CREATE TABLE `gitlab_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`account` text NOT NULL,
	`sealed_token` text NOT NULL,
	`token_hint` text NOT NULL,
	`sealed_webhook_secret` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`synced_at` integer,
	`sync_error` text,
	`last_delivery_at` integer
);
--> statement-breakpoint
ALTER TABLE `repositories` ADD `web_url` text;