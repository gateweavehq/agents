CREATE TABLE `env_secrets` (
	`asset_id` text NOT NULL,
	`name` text NOT NULL,
	`sealed` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `name`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agent_definitions` ADD `env_set_asset_id` text REFERENCES assets(id);--> statement-breakpoint
ALTER TABLE `agent_definitions` ADD `env_set_version` integer;--> statement-breakpoint
CREATE INDEX `agent_definitions_env_set_idx` ON `agent_definitions` (`env_set_asset_id`);