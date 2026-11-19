CREATE TABLE `outside_tasks` (
	`agent_id` text NOT NULL,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`conversation_id` text,
	`run_id` text,
	`error` text,
	`asked_by` text NOT NULL,
	`asked_via` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `request_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `outside_tasks_created_idx` ON `outside_tasks` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `outside_tasks_conversation_idx` ON `outside_tasks` (`conversation_id`);