CREATE TABLE `provider_keys` (
	`provider` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`hint` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	`checked_at` integer,
	`check_ok` integer,
	`check_message` text,
	`check_models` integer
);
