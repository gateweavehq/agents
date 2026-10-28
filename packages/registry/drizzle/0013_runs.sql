CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`conversation_id` text,
	`started_by` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cost` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_started_at_idx` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `runs_started_by_idx` ON `runs` (`started_by`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_conversation_idx` ON `runs` (`conversation_id`);