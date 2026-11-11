CREATE TABLE `wiki_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`status` text NOT NULL,
	`commit` text,
	`tree` text,
	`steered` integer DEFAULT false NOT NULL,
	`steering_problem` text,
	`notes` text DEFAULT '[]' NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`started_by` text NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`pages_total` integer DEFAULT 0 NOT NULL,
	`pages_done` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost` integer DEFAULT 0,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `wiki_generations_repository_idx` ON `wiki_generations` (`repository_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_generations_underway_idx` ON `wiki_generations` (`repository_id`) WHERE "wiki_generations"."status" in ('planning', 'writing');--> statement-breakpoint
CREATE TABLE `wiki_pages` (
	`generation_id` text NOT NULL,
	`position` integer NOT NULL,
	`number` text NOT NULL,
	`depth` integer NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`notes` text NOT NULL,
	`files` text NOT NULL,
	`sources` text,
	`body` text,
	`written_at` integer,
	PRIMARY KEY(`generation_id`, `position`),
	FOREIGN KEY (`generation_id`) REFERENCES `wiki_generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_pages_number_idx` ON `wiki_pages` (`generation_id`,`number`);