CREATE TABLE `deployment` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text,
	`sign_up` text NOT NULL,
	`trust_provider` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "deployment_one_row" CHECK("deployment"."id" = 1),
	CONSTRAINT "deployment_sign_up" CHECK("deployment"."sign_up" IN ('open', 'closed')),
	CONSTRAINT "deployment_trust_provider" CHECK("deployment"."trust_provider" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `sign_up_allow` (
	`entry` text PRIMARY KEY NOT NULL,
	`note` text,
	`added_at` integer NOT NULL,
	`added_by` text NOT NULL,
	CONSTRAINT "sign_up_allow_lowercase" CHECK("sign_up_allow"."entry" = lower("sign_up_allow"."entry")),
	CONSTRAINT "sign_up_allow_note" CHECK("sign_up_allow"."note" IS NULL OR length("sign_up_allow"."note") <= 200)
);
