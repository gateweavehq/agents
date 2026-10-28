CREATE TABLE `repository_files` (
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`blob` text NOT NULL,
	`size` integer NOT NULL,
	`symlink` integer NOT NULL,
	PRIMARY KEY(`repository_id`, `path`),
	FOREIGN KEY (`repository_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
