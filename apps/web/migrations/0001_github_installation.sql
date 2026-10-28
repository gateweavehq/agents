CREATE TABLE `github_installation` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`linked_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `github_installation_workspace_idx` ON `github_installation` (`workspace_id`);