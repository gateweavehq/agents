CREATE TABLE `setup_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`setup_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`pins` text NOT NULL,
	`files` text NOT NULL,
	`branch` text NOT NULL,
	`commit` text NOT NULL,
	`pull_number` integer NOT NULL,
	`pull_url` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`setup_id`) REFERENCES `setups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `setup_applications_setup_idx` ON `setup_applications` (`setup_id`);--> statement-breakpoint
CREATE INDEX `setup_applications_pull_idx` ON `setup_applications` (`repository_id`,`pull_number`);