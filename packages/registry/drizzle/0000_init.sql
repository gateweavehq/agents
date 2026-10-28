CREATE TABLE `agent_assets` (
	`agent_id` text NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`agent_id`, `asset_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_assets_asset_idx` ON `agent_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`runtime` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`model` text,
	`path` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_repository_key_idx` ON `agents` (`repository_id`,`runtime`,`key`);--> statement-breakpoint
CREATE TABLE `asset_versions` (
	`asset_id` text NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`commit` text,
	`files` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `version`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`path` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`version` integer NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_repository_key_idx` ON `assets` (`repository_id`,`key`);--> statement-breakpoint
CREATE INDEX `assets_hash_idx` ON `assets` (`hash`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`content` text
);
--> statement-breakpoint
CREATE TABLE `project_repositories` (
	`project_id` text NOT NULL,
	`repository_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `repository_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `project_repositories_repository_idx` ON `project_repositories` (`repository_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text NOT NULL,
	`private` integer NOT NULL,
	`scanned_commit` text,
	`scanned_at` integer,
	`scan_error` text,
	`problems` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repositories_external_idx` ON `repositories` (`provider`,`external_id`);