CREATE TABLE `conversations_to_destroy` (
	`id` text PRIMARY KEY NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_to_destroy_next_idx` ON `conversations_to_destroy` (`next_attempt_at`);