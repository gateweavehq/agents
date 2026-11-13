CREATE TABLE `workspace_location` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`jurisdiction` text NOT NULL,
	`moved_from` text,
	`moved_at` integer
);
