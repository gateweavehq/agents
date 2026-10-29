CREATE TABLE `trigger_deliveries` (
	`trigger_id` text NOT NULL,
	`id` text NOT NULL,
	`status` text NOT NULL,
	`event` text,
	`conversation_id` text,
	`run_id` text,
	`error` text,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`trigger_id`, `id`),
	FOREIGN KEY (`trigger_id`) REFERENCES `triggers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trigger_deliveries_received_idx` ON `trigger_deliveries` (`trigger_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `trigger_deliveries_conversation_idx` ON `trigger_deliveries` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`agent_id` text,
	`team_id` text,
	`sealed` text NOT NULL,
	`secret_start` text NOT NULL,
	`active` integer NOT NULL,
	`per_day` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `triggers_agent_idx` ON `triggers` (`agent_id`);--> statement-breakpoint
CREATE INDEX `triggers_team_idx` ON `triggers` (`team_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `trigger_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `trigger_id` text;