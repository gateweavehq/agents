CREATE TABLE `agent_pauses` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`paused_by` text NOT NULL,
	`paused_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
