CREATE TABLE `audit_event` (
	`id` integer PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`target_label` text,
	`detail` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auditEvent_organizationId_id_idx` ON `audit_event` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `auditEvent_at_idx` ON `audit_event` (`at`);