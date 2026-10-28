CREATE TABLE `setup_assets` (
	`setup_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`setup_id`, `asset_id`),
	FOREIGN KEY (`setup_id`) REFERENCES `setups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `setup_assets_asset_idx` ON `setup_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `setups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`runtimes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
