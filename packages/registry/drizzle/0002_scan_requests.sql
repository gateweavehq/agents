CREATE TABLE `scan_requests` (
	`repository_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scan_requests_not_before_idx` ON `scan_requests` (`not_before`);