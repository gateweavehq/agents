CREATE TABLE `registry_passes` (
	`name` text PRIMARY KEY NOT NULL,
	`ran_at` integer NOT NULL,
	`failure` text
);
--> statement-breakpoint
ALTER TABLE `env_secrets` ADD `contested` text;