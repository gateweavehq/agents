-- Full-text search over the workspace's memory (src/memory.ts). Drizzle cannot express an FTS5
-- table, so this migration is written by hand, as Track's issue search is. A row's rowid is its
-- memory's `seq`. The code writes a memory and its row here in one transaction; there are no
-- triggers, because a move copies this table by its content (src/move.ts) and a trigger would
-- then index each memory twice.
CREATE VIRTUAL TABLE `memory_search` USING fts5(
	`text`,
	tokenize = 'unicode61 remove_diacritics 2',
	prefix = '2 3'
);
