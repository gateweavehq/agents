-- Scans before 0007 did not record the files they read, which drift compares with, so every live
-- repository is read again. Forced, because its head has not moved. The Durable Object sets its
-- alarm once migrations have run.
INSERT INTO `scan_requests` (`repository_id`, `requested_at`, `attempts`, `not_before`, `force`)
SELECT `id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 0, 0, 1
FROM `repositories`
WHERE `removed_at` IS NULL
ON CONFLICT (`repository_id`) DO UPDATE SET `force` = 1, `attempts` = 0, `not_before` = 0;
