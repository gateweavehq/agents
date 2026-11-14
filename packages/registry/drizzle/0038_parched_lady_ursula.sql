CREATE TABLE `track_connections` (
	`state` text PRIMARY KEY NOT NULL,
	`started_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`choices` text NOT NULL,
	`trigger_id` text NOT NULL,
	`sealed_verifier` text NOT NULL
);
