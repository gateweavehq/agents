CREATE TABLE `model_key_cap_alerts` (
	`kind` text NOT NULL,
	`period` text NOT NULL,
	`share` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `period`, `share`)
);
--> statement-breakpoint
CREATE TABLE `model_key_caps` (
	`id` text PRIMARY KEY NOT NULL,
	`daily_cap` text,
	`monthly_cap` text
);
