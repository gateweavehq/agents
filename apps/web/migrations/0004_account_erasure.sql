CREATE TABLE `former_member` (
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `organization_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `formerMember_organizationId_idx` ON `former_member` (`organization_id`);--> statement-breakpoint
CREATE TABLE `pending_erasure` (
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `organization_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pendingErasure_organizationId_idx` ON `pending_erasure` (`organization_id`);--> statement-breakpoint
CREATE INDEX `pendingErasure_createdAt_idx` ON `pending_erasure` (`created_at`);