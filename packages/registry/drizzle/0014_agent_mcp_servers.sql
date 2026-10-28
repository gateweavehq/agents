CREATE TABLE `agent_mcp_servers` (
	`agent_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `asset_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_mcp_servers_asset_idx` ON `agent_mcp_servers` (`asset_id`);