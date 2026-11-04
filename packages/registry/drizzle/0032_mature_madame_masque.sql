CREATE TABLE `telemetry` (
	`id` integer PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`header_names` text NOT NULL,
	`sealed_headers` text,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	`last_export_at` integer,
	`last_export_ok` integer,
	`last_export_error` text
);
