CREATE TABLE `track_report_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`destination_id` text NOT NULL,
	`report` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `track_source_destinations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `track_report_outbox_next_idx` ON `track_report_outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `track_report_outbox_destination_idx` ON `track_report_outbox` (`destination_id`);