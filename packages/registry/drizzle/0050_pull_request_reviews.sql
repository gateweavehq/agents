CREATE TABLE `pull_request_reviews` (
	`trigger_id` text,
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`head` text NOT NULL,
	`run_id` text,
	`source_run_id` text NOT NULL,
	`conversation_id` text,
	`status` text NOT NULL,
	`reason` text,
	`draft` integer DEFAULT false NOT NULL,
	`draft_reason` text,
	`found` integer,
	`shown` integer,
	`proven` integer,
	`retries` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pull_request_reviews_trigger_idx` ON `pull_request_reviews` (`trigger_id`);--> statement-breakpoint
CREATE INDEX `pull_request_reviews_due_idx` ON `pull_request_reviews` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `pull_request_reviews_run_idx` ON `pull_request_reviews` (`run_id`);--> statement-breakpoint
CREATE INDEX `pull_request_reviews_conversation_idx` ON `pull_request_reviews` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `triggers` ADD `pull_request` integer DEFAULT false NOT NULL;