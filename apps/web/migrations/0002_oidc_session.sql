ALTER TABLE `session` ADD `oidc_sid` text;--> statement-breakpoint
CREATE INDEX `session_oidcSid_idx` ON `session` (`oidc_sid`);