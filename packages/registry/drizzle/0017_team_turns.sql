ALTER TABLE `conversations` ADD `team_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `root_id` text;--> statement-breakpoint
CREATE INDEX `conversations_root_idx` ON `conversations` (`root_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `parent_span_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `root_run_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `edge` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `team_path` text;--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `runs_root_idx` ON `runs` (`root_run_id`);