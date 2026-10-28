ALTER TABLE `repositories` ADD `installation_id` text;--> statement-breakpoint
CREATE INDEX `repositories_installation_idx` ON `repositories` (`installation_id`);