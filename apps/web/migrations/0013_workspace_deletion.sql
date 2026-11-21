CREATE TABLE `workspace_deletion` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`deleted_at` integer NOT NULL,
	`last_tried_at` integer
);
--> statement-breakpoint
CREATE INDEX `workspaceDeletion_lastTriedAt_idx` ON `workspace_deletion` (`last_tried_at`,`deleted_at`);