CREATE TABLE `track_source_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`track_origin` text NOT NULL,
	`workspace_id` text NOT NULL,
	`workspace_slug` text NOT NULL,
	`workspace_name` text NOT NULL,
	`team_id` text NOT NULL,
	`team_key` text NOT NULL,
	`team_name` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`source_product` text NOT NULL,
	`sealed_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `track_source_destinations_team_idx` ON `track_source_destinations` (`track_origin`,`workspace_id`,`team_id`);