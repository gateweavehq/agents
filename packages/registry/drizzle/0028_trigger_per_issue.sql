ALTER TABLE `conversations` ADD `issue` text;--> statement-breakpoint
CREATE INDEX `conversations_trigger_issue_idx` ON `conversations` (`trigger_id`,`issue`);--> statement-breakpoint
ALTER TABLE `triggers` ADD `per_issue` integer DEFAULT false NOT NULL;