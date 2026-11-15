CREATE TABLE `memories` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`run_id` text,
	`conversation_id` text,
	`origin` text,
	`source_label` text,
	`source_url` text,
	`trusted` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`edited_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	`forgotten_at` integer,
	`forgotten_run_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memories_id_idx` ON `memories` (`id`);--> statement-breakpoint
CREATE INDEX `memories_state_idx` ON `memories` (`forgotten_at`,`trusted`,`created_at`);--> statement-breakpoint
CREATE INDEX `memories_scope_idx` ON `memories` (`scope`,`scope_id`);--> statement-breakpoint
CREATE INDEX `memories_run_idx` ON `memories` (`run_id`);--> statement-breakpoint
CREATE INDEX `memories_forgotten_run_idx` ON `memories` (`forgotten_run_id`);--> statement-breakpoint
ALTER TABLE `agent_definitions` ADD `memory` integer DEFAULT false NOT NULL;