ALTER TABLE `agent_definitions` ADD `sandbox` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `sandbox` integer DEFAULT false NOT NULL;