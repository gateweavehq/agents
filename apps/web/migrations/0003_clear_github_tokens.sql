-- Signing in with GitHub used to keep GitHub's tokens. Agents never used them: it signs people in and
-- never acts for them with that token, and the GitHub integration makes an exchange of its own.
UPDATE `account`
SET
	`access_token` = NULL,
	`refresh_token` = NULL,
	`id_token` = NULL,
	`access_token_expires_at` = NULL,
	`refresh_token_expires_at` = NULL
WHERE `provider_id` = 'github';
