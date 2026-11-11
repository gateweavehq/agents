-- Custom SQL migration: "Who owns a server" in docs/architecture.md.
--
-- Trusting the sign-in provider no longer opens the trigger to any verified address. The hook that knows an
-- account comes from the provider writes a pass for its address (`sign_up_pass`, a minute long), and with
-- trust on the trigger lets an insert through only while one is there. Expired passes count as none.
DROP TRIGGER `user_needs_a_way_in`;--> statement-breakpoint
CREATE TRIGGER `user_needs_a_way_in`
BEFORE INSERT ON `user`
WHEN COALESCE((SELECT `sign_up` FROM `deployment` WHERE `id` = 1), 'closed') <> 'open'
	AND EXISTS (SELECT 1 FROM `user`)
	AND NOT EXISTS (
		SELECT 1 FROM `sign_up_allow`
		WHERE `entry` = lower(new.`email`)
			OR `entry` = substr(lower(new.`email`), length(rtrim(lower(new.`email`), replace(lower(new.`email`), '@', ''))))
	)
	AND NOT EXISTS (
		SELECT 1 FROM `invitation`
		WHERE `email` = lower(new.`email`)
			AND `status` = 'pending'
			AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
	)
	AND NOT (
		COALESCE((SELECT `trust_provider` FROM `deployment` WHERE `id` = 1), 0) = 1
		AND EXISTS (
			SELECT 1 FROM `sign_up_pass`
			WHERE `email` = lower(new.`email`)
				AND `expires_at` > cast(unixepoch('subsecond') * 1000 as integer)
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'sign-up is closed here');
END;--> statement-breakpoint
-- A server is never left without an owner. While sign-up is open, the owner's account may go, and
-- ownership passes to the earliest account left (`created_at`, then `id`), or to nobody if there is none,
-- when `first_account_owns_deployment` gives it to the next account. This runs before the row goes, so
-- the foreign key that would empty `owner_id` finds nothing to do. While sign-up is closed
-- `deployment_keeps_its_owner` refuses the deletion instead.
CREATE TRIGGER `deployment_hands_over_its_owner`
BEFORE DELETE ON `user`
WHEN old.`id` = (SELECT `owner_id` FROM `deployment` WHERE `id` = 1)
	AND (SELECT `sign_up` FROM `deployment` WHERE `id` = 1) = 'open'
BEGIN
	UPDATE `deployment`
	SET `owner_id` = (SELECT `id` FROM `user` WHERE `id` <> old.`id` ORDER BY `created_at`, `id` LIMIT 1),
		`updated_at` = cast(unixepoch('subsecond') * 1000 as integer)
	WHERE `id` = 1;
END;
