ALTER TABLE `agent_definitions` ADD `allowed_targets` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_definitions` ADD `any_target` integer DEFAULT false NOT NULL;