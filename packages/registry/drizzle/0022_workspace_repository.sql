ALTER TABLE `agent_definitions` ADD `repository_id` text REFERENCES repositories(id);--> statement-breakpoint
CREATE INDEX `agent_definitions_repository_idx` ON `agent_definitions` (`repository_id`);