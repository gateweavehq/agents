CREATE TABLE `mcp_oauth` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`server_url` text NOT NULL,
	`authorization_server` text,
	`sealed_client` text,
	`sealed_verifier` text,
	`sealed_tokens` text,
	`state` text,
	`state_by` text,
	`state_expires_at` integer,
	`connected_by` text,
	`connected_at` integer
);
