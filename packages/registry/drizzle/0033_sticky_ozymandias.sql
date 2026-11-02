ALTER TABLE `conversations` ADD `replay_of` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `replay_of` text;--> statement-breakpoint
CREATE INDEX `runs_replay_idx` ON `runs` (`replay_of`);