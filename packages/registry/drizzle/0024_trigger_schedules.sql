ALTER TABLE `triggers` ADD `schedule` text;--> statement-breakpoint
ALTER TABLE `triggers` ADD `next_run_at` integer;--> statement-breakpoint
CREATE INDEX `triggers_next_run_idx` ON `triggers` (`next_run_at`);