CREATE TABLE `mcp_checks` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`ok` integer NOT NULL,
	`tools` text NOT NULL,
	`error` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
