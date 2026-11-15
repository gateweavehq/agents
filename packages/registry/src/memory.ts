/**
 * The workspace's memory (AGT-107): short notes its people and agents keep, recalled by keyword.
 *
 * A memory says who or what wrote it and, for an agent, in which run. What a run's agent writes
 * is trusted only when a person's chat message started the run. A run a trigger started read
 * content an outsider may have written (a webhook's event, a mail), so what its agent remembers
 * waits: no agent recalls it until an owner or admin approves it. Otherwise one poisoned event
 * would steer every later run, long after its own run ended. Whether a run is a trigger's is read
 * here, from the run's own row, never taken from the caller.
 *
 * An FTS5 table, `memory_search`, holds each memory's text under the memory's `seq`. Every write
 * here changes the row and the index together, inside the caller's transaction.
 */
import {
	MEMORY_LIMITS,
	MEMORY_NOTICE,
	type Memory,
	type MemoryAgentEvent,
	type MemoryPage,
	type MemoryRefusal,
	type MemoryScope,
	type MemoryState,
	type memoryEditInput,
	memoryExcerpt,
	type memoryFilter,
	type memoryInput,
	memoryMatch,
	type RecalledMemory,
	type RecallOutcome,
	type RememberOutcome,
	RUN_TIMEOUT_MS,
	type recallInput,
	type rememberInput,
	triggerOf,
} from "@gateweave/agents-model";
import { and, asc, desc, eq, gt, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import {
	agentDefinitions,
	agents,
	conversations,
	type MemoryRow,
	memories,
	repositories,
	runs,
	triggers,
} from "./db/schema";
import type { Db } from "./state";

/**
 * The FTS5 table, for queries only. It lives outside `db/schema.ts`, so Drizzle Kit leaves it to
 * migration 0040. `rowid` is `memories.seq`.
 */
const memorySearch = sqliteTable("memory_search", {
	rowid: integer("rowid").notNull(),
	text: text("text").notNull(),
});

/** Orders matches best first. Lower is better. */
const RANK = sql<number>`bm25(${memorySearch})`;

/** How far back a replay is followed to what started it, before the answer is "not trusted". */
const REPLAY_HOPS = 20;

function refused(message: string): MemoryRefusal {
	return { status: "refused", message };
}

function indexMemory(db: Db, seq: number, body: string): void {
	db.run(sql`insert into memory_search (rowid, text) values (${seq}, ${body})`);
}

function unindexMemory(db: Db, seq: number): void {
	db.run(sql`delete from memory_search where rowid = ${seq}`);
}

/**
 * Merges the index into one piece. Deleting a row from FTS5 only marks its words as deleted, and
 * they stay in the index's pages until a merge, which is too long for a text someone removed.
 */
function mergeIndex(db: Db): void {
	db.run(sql`insert into memory_search (memory_search) values ('optimize')`);
}

const live = and(isNull(memories.forgottenAt), eq(memories.trusted, true));
const waiting = and(isNull(memories.forgottenAt), eq(memories.trusted, false));
const forgotten = isNotNull(memories.forgottenAt);
const STATES: Record<MemoryState, SQL | undefined> = { live, waiting, forgotten };

/** How many memories each state has. */
export function memoryCounts(db: Db): Record<MemoryState, number> {
	const row = db
		.select({
			live: sql<number>`coalesce(sum(${live}), 0)`,
			waiting: sql<number>`coalesce(sum(${waiting}), 0)`,
			forgotten: sql<number>`coalesce(sum(${forgotten}), 0)`,
		})
		.from(memories)
		.get();
	return { live: row?.live ?? 0, waiting: row?.waiting ?? 0, forgotten: row?.forgotten ?? 0 };
}

/** Why the workspace takes no more memories, or null when it does. */
function fullRefusal(db: Db, trusted: boolean): MemoryRefusal | null {
	const counts = memoryCounts(db);
	if (counts.live + counts.waiting >= MEMORY_LIMITS.live) {
		return refused(
			`The workspace's memory is full: it keeps at most ${MEMORY_LIMITS.live.toLocaleString("en-US")} memories. An owner or admin can delete some on the Memory page.`,
		);
	}
	if (!trusted && counts.waiting >= MEMORY_LIMITS.waiting) {
		return refused(
			`${MEMORY_LIMITS.waiting} memories already wait for approval, which is the most that may. An owner or admin can approve or dismiss them on the Memory page.`,
		);
	}
	return null;
}

function findMemory(db: Db, id: string): MemoryRow | undefined {
	return db.select().from(memories).where(eq(memories.id, id)).get();
}

/** The memory as the page shows it, with the names its ids have now. */
function toMemory(db: Db, row: MemoryRow): Memory {
	const agentName = (id: string) =>
		db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? null;
	let scopeName: string | null = null;
	if (row.scope === "agent" && row.scopeId !== null) scopeName = agentName(row.scopeId);
	if (row.scope === "repository" && row.scopeId !== null) {
		const repository = db
			.select({ owner: repositories.owner, name: repositories.name })
			.from(repositories)
			.where(eq(repositories.id, row.scopeId))
			.get();
		scopeName = repository ? `${repository.owner}/${repository.name}` : null;
	}
	const run =
		row.runId === null
			? undefined
			: db
					.select({ startedBy: runs.startedBy, trigger: triggers.name, triggerId: runs.triggerId })
					.from(runs)
					.leftJoin(triggers, eq(triggers.id, runs.triggerId))
					.where(eq(runs.id, row.runId))
					.get();
	return {
		id: row.id,
		text: row.text,
		kind: row.kind,
		scope: row.scope,
		scopeId: row.scopeId,
		scopeName,
		author: {
			kind: row.authorKind,
			id: row.authorId,
			name: row.authorKind === "agent" ? agentName(row.authorId) : null,
		},
		run:
			row.runId === null
				? null
				: {
						id: row.runId,
						startedBy: run?.startedBy ?? null,
						// A deleted trigger leaves its runs, which still say a trigger started them.
						trigger: run?.triggerId ? (run.trigger ?? "a deleted trigger") : null,
					},
		source: { label: row.sourceLabel, url: row.sourceUrl },
		trusted: row.trusted,
		approvedBy: row.approvedBy,
		approvedAt: row.approvedAt,
		editedBy: row.editedBy,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		expiresAt: row.expiresAt,
		forgottenAt: row.forgottenAt,
	};
}

/**
 * A page of the workspace's memories in one state, the newest first, or the best match first for
 * a search. A search finds the memories that have every one of its words.
 */
export function listMemories(db: Db, filter: z.output<typeof memoryFilter>): MemoryPage {
	const counts = memoryCounts(db);
	const match = memoryMatch(filter.search, "all");
	// Text without a single word, such as "?!", has nothing to match.
	if (filter.search.trim() !== "" && match === null) return { memories: [], counts, next: null };
	const where = and(
		STATES[filter.state],
		filter.kind === null ? undefined : eq(memories.kind, filter.kind),
		filter.scope === null ? undefined : eq(memories.scope, filter.scope),
	);
	const newest = [desc(memories.createdAt), desc(memories.seq)];
	const rows =
		match === null
			? db
					.select()
					.from(memories)
					.where(where)
					.orderBy(...newest)
					.limit(MEMORY_LIMITS.page + 1)
					.offset(filter.offset)
					.all()
			: db
					.select({ memory: memories })
					.from(memorySearch)
					.innerJoin(memories, eq(memories.seq, memorySearch.rowid))
					.where(and(sql`${memorySearch} match ${match}`, where))
					.orderBy(RANK, ...newest)
					.limit(MEMORY_LIMITS.page + 1)
					.offset(filter.offset)
					.all()
					.map((row) => row.memory);
	return {
		memories: rows.slice(0, MEMORY_LIMITS.page).map((row) => toMemory(db, row)),
		counts,
		next: rows.length > MEMORY_LIMITS.page ? filter.offset + MEMORY_LIMITS.page : null,
	};
}

export function getMemory(db: Db, id: string): Memory | null {
	const row = findMemory(db, id);
	return row ? toMemory(db, row) : null;
}

/** Why a memory cannot be about this agent or repository, or null when it can. */
function scopeProblem(db: Db, scope: MemoryScope, scopeId: string | null): string | null {
	if (scope === "agent") {
		const agent = db
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, scopeId ?? ""), isNull(agents.removedAt)))
			.get();
		return agent ? null : "That agent is not in the workspace";
	}
	if (scope === "repository") {
		const repository = db
			.select({ id: repositories.id })
			.from(repositories)
			.where(and(eq(repositories.id, scopeId ?? ""), isNull(repositories.removedAt)))
			.get();
		return repository ? null : "That repository is not in the workspace";
	}
	// The caller checked that a person is a member: the registry keeps no list of them.
	return null;
}

/** A memory a person typed on the Memory page, which is trusted: an owner or admin wrote it. */
export function addMemory(
	db: Db,
	input: z.output<typeof memoryInput>,
	by: string,
	now: number,
): Memory | MemoryRefusal {
	const problem = scopeProblem(db, input.scope, input.scopeId);
	if (problem) return refused(problem);
	const full = fullRefusal(db, true);
	if (full) return full;
	const row = db
		.insert(memories)
		.values({
			id: crypto.randomUUID(),
			text: input.text,
			kind: input.kind,
			scope: input.scope,
			scopeId: input.scopeId,
			authorKind: "person",
			authorId: by,
			sourceLabel: input.sourceLabel,
			sourceUrl: input.sourceUrl,
			trusted: true,
			createdAt: now,
			updatedAt: now,
			expiresAt: input.expiresAt,
		})
		.returning()
		.get();
	indexMemory(db, row.seq, row.text);
	return toMemory(db, row);
}

/**
 * A person's edit. It leaves who wrote the memory and whether it is trusted as they were, so
 * editing one that waits does not approve it. Null when there is no such memory.
 */
export function editMemory(
	db: Db,
	input: z.output<typeof memoryEditInput>,
	by: string,
	now: number,
): Memory | MemoryRefusal | null {
	const current = findMemory(db, input.id);
	if (!current) return null;
	if (current.forgottenAt !== null) {
		return refused("This memory was forgotten by the agent that wrote it, so it cannot be edited");
	}
	const row = db
		.update(memories)
		.set({
			text: input.text,
			kind: input.kind,
			sourceLabel: input.sourceLabel,
			sourceUrl: input.sourceUrl,
			expiresAt: input.expiresAt,
			editedBy: by,
			updatedAt: now,
		})
		.where(eq(memories.seq, current.seq))
		.returning()
		.get();
	if (row.text !== current.text) {
		unindexMemory(db, row.seq);
		indexMemory(db, row.seq, row.text);
	}
	return toMemory(db, row);
}

/** Makes a waiting memory trusted, so agents recall it. Null when there is no such memory. */
export function approveMemory(
	db: Db,
	id: string,
	by: string,
	now: number,
): Memory | MemoryRefusal | null {
	const current = findMemory(db, id);
	if (!current) return null;
	if (current.forgottenAt !== null) return refused("This memory was forgotten");
	if (current.trusted) return refused("This memory is not waiting for approval");
	const row = db
		.update(memories)
		.set({ trusted: true, approvedBy: by, approvedAt: now, updatedAt: now })
		.where(eq(memories.seq, current.seq))
		.returning()
		.get();
	return toMemory(db, row);
}

/** Removes a memory and its row in the index. Returns it as it was; null when there was none. */
export function deleteMemory(db: Db, id: string): Memory | null {
	const current = findMemory(db, id);
	if (!current) return null;
	const memory = toMemory(db, current);
	db.delete(memories).where(eq(memories.seq, current.seq)).run();
	unindexMemory(db, current.seq);
	mergeIndex(db);
	return memory;
}

/** Removes a memory that waits for approval. Null when there is no such memory. */
export function dismissMemory(db: Db, id: string): Memory | MemoryRefusal | null {
	const current = findMemory(db, id);
	if (!current) return null;
	if (current.trusted) return refused("This memory is not waiting for approval");
	return deleteMemory(db, id);
}

/**
 * Removes the memories about someone whose account is gone (`./forget.ts`). What they wrote about
 * the workspace stays as the team's, under their id, like what else they set up.
 */
export function forgetMemoriesAbout(db: Db, person: string): void {
	const about = and(eq(memories.scope, "person"), eq(memories.scopeId, person));
	const rows = db.select({ seq: memories.seq }).from(memories).where(about).all();
	if (rows.length === 0) return;
	for (const { seq } of rows) unindexMemory(db, seq);
	db.delete(memories).where(about).run();
	mergeIndex(db);
}

/** A run that may use memory now, as its own row and its agent's definition say. */
interface MemoryRun {
	runId: string;
	agentId: string;
	agentName: string;
	conversationId: string | null;
	/** The member whose message started it; null for a trigger's run. */
	person: string | null;
	/** The repository the agent works in; null when it has none. */
	repositoryId: string | null;
	/** Whether what its agent writes is trusted: a person's chat message started it. */
	trusted: boolean;
}

/**
 * Whether content from outside may have started a run: a trigger started it, or it replays, however
 * far back, a run a trigger started, whose words are its history. A link that cannot be followed
 * (a conversation since deleted) counts as outside, so that what cannot be shown is not trusted.
 */
function startedFromOutside(
	db: Db,
	run: { triggerId: string | null; startedBy: string; conversationId: string | null },
): boolean {
	let current: { triggerId: string | null; conversationId: string | null } = {
		triggerId: run.triggerId ?? triggerOf(run.startedBy),
		conversationId: run.conversationId,
	};
	for (let hop = 0; hop < REPLAY_HOPS; hop++) {
		if (current.triggerId !== null || current.conversationId === null) return true;
		const conversation = conversationAtTop(db, current.conversationId);
		if (!conversation || conversation.triggerId !== null) return true;
		if (conversation.replayOf === null) return false;
		const replayed = db
			.select({ triggerId: runs.triggerId, conversationId: runs.conversationId })
			.from(runs)
			.where(eq(runs.id, conversation.replayOf))
			.get();
		if (!replayed) return true;
		current = replayed;
	}
	return true;
}

/** A conversation, or for a team's nested turn the conversation it goes with. */
function conversationAtTop(db: Db, id: string) {
	const columns = {
		rootId: conversations.rootId,
		triggerId: conversations.triggerId,
		replayOf: conversations.replayOf,
	};
	const found = db.select(columns).from(conversations).where(eq(conversations.id, id)).get();
	if (!found || found.rootId === null) return found;
	return db.select(columns).from(conversations).where(eq(conversations.id, found.rootId)).get();
}

/** The run a memory tool was called in, or why it has no memory. */
function memoryRun(db: Db, runId: string, now: number): MemoryRun | MemoryRefusal {
	const found = db
		.select({ run: runs, agentName: agents.name, definition: agentDefinitions })
		.from(runs)
		.innerJoin(agents, eq(agents.id, runs.agentId))
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, runs.agentId))
		.where(eq(runs.id, runId))
		.get();
	// A run still `running` after a run's hour was cut short, and is closed when next listed.
	const going = found?.run.status === "running" && now - found.run.startedAt < RUN_TIMEOUT_MS;
	if (!found || !going) {
		return refused("This run has ended, so it cannot use the workspace's memory");
	}
	const { run, agentName, definition } = found;
	if (!definition.memory) {
		return refused(
			`Memory is turned off for ${agentName}. An owner or admin can turn it on in the agent's settings.`,
		);
	}
	return {
		runId: run.id,
		agentId: run.agentId,
		agentName,
		conversationId: run.conversationId,
		person: run.triggerId === null && triggerOf(run.startedBy) === null ? run.startedBy : null,
		repositoryId: definition.repositoryId,
		trusted: !startedFromOutside(db, run),
	};
}

/**
 * An agent's `remember`, in a run that is going. The memory is trusted only when a person's chat
 * message started the run; otherwise it waits for an owner or admin.
 */
export function rememberInRun(
	db: Db,
	runId: string,
	input: z.output<typeof rememberInput>,
	now: number,
): { outcome: RememberOutcome; event: MemoryAgentEvent } | MemoryRefusal {
	const run = memoryRun(db, runId, now);
	if ("status" in run) return run;
	let scopeId: string | null = null;
	if (input.scope === "agent") scopeId = run.agentId;
	if (input.scope === "repository") {
		if (run.repositoryId === null) {
			return refused(
				`${run.agentName} works in no repository, so there is none to remember this about. Use another scope.`,
			);
		}
		scopeId = run.repositoryId;
	}
	if (input.scope === "person") {
		if (run.person === null) {
			return refused(
				"No person started this run, so there is nobody to remember this about. Use another scope.",
			);
		}
		scopeId = run.person;
	}
	const full = fullRefusal(db, run.trusted);
	if (full) return full;
	const row = db
		.insert(memories)
		.values({
			id: crypto.randomUUID(),
			text: input.text,
			kind: input.kind,
			scope: input.scope,
			scopeId,
			authorKind: "agent",
			authorId: run.agentId,
			runId: run.runId,
			conversationId: run.conversationId,
			trusted: run.trusted,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.get();
	indexMemory(db, row.seq, row.text);
	return {
		outcome: { id: row.id, waiting: !row.trusted },
		event: agentEvent("remembered", run, row),
	};
}

/**
 * An agent's `recall`: the trusted memories it may see that are not forgotten or expired, those
 * with any of the query's words, the best match first and the newest first among equals. A query
 * with no words lists the newest. It may see the workspace's, its own, its repository's, and
 * those about the person whose message started the run.
 */
export function recallInRun(
	db: Db,
	runId: string,
	input: z.output<typeof recallInput>,
	now: number,
): RecallOutcome | MemoryRefusal {
	const run = memoryRun(db, runId, now);
	if ("status" in run) return run;
	const about = (scope: MemoryScope, id: string | null) =>
		id === null ? undefined : and(eq(memories.scope, scope), eq(memories.scopeId, id));
	const where = and(
		live,
		or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
		or(
			eq(memories.scope, "workspace"),
			about("agent", run.agentId),
			about("repository", run.repositoryId),
			about("person", run.person),
		),
		input.scope === null ? undefined : eq(memories.scope, input.scope),
	);
	const limit = Math.min(input.limit, MEMORY_LIMITS.recall);
	const newest = [desc(memories.createdAt), desc(memories.seq)];
	const match = memoryMatch(input.query, "any");
	const rows =
		match === null
			? db
					.select()
					.from(memories)
					.where(where)
					.orderBy(...newest)
					.limit(limit)
					.all()
			: db
					.select({ memory: memories })
					.from(memorySearch)
					.innerJoin(memories, eq(memories.seq, memorySearch.rowid))
					.where(and(sql`${memorySearch} match ${match}`, where))
					.orderBy(RANK, ...newest)
					.limit(limit)
					.all()
					.map((row) => row.memory);
	return { notice: MEMORY_NOTICE, memories: rows.map((row) => toRecalled(db, row)) };
}

function toRecalled(db: Db, row: MemoryRow): RecalledMemory {
	const agent =
		row.authorKind === "agent"
			? db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.authorId)).get()
			: undefined;
	const writer =
		row.authorKind === "agent" ? `the agent ${agent?.name ?? "(removed)"}` : "a person";
	const source = [row.sourceLabel, row.sourceUrl].filter((part) => part !== null).join(" ");
	return {
		id: row.id,
		text: row.text,
		kind: row.kind,
		scope: row.scope,
		writtenBy:
			row.approvedBy === null
				? writer
				: `${writer}, in a run a trigger started; a person approved it`,
		source: source === "" ? null : source,
		date: new Date(row.createdAt).toISOString().slice(0, 10),
	};
}

/**
 * An agent's `forget`: it takes back a memory it wrote itself, which stays for people to read but
 * is never recalled. A run a trigger started takes back only what still waits, so that content
 * from outside cannot remove memory the workspace trusts.
 */
export function forgetInRun(
	db: Db,
	runId: string,
	id: string,
	now: number,
): { event: MemoryAgentEvent } | MemoryRefusal {
	const run = memoryRun(db, runId, now);
	if ("status" in run) return run;
	const current = findMemory(db, id);
	if (!current) return refused("There is no memory with that id");
	if (current.authorKind !== "agent" || current.authorId !== run.agentId) {
		return refused(
			`${run.agentName} did not write this memory, and an agent forgets only what it wrote itself. An owner or admin can delete it on the Memory page.`,
		);
	}
	if (current.forgottenAt !== null) return refused("This memory was forgotten already");
	if (!run.trusted && current.trusted) {
		return refused(
			"A trigger started this run, so it can only take back memories that still wait for approval. An owner or admin can delete this one on the Memory page.",
		);
	}
	db.update(memories)
		.set({ forgottenAt: now, updatedAt: now })
		.where(eq(memories.seq, current.seq))
		.run();
	dropOldestForgotten(db);
	return { event: agentEvent("forgotten", run, current) };
}

/** Keeps the forgotten memories within their limit: the ones forgotten longest ago go. */
function dropOldestForgotten(db: Db): void {
	const extra = memoryCounts(db).forgotten - MEMORY_LIMITS.forgotten;
	if (extra <= 0) return;
	const over = db
		.select({ seq: memories.seq })
		.from(memories)
		.where(forgotten)
		.orderBy(asc(memories.forgottenAt), asc(memories.seq))
		.limit(extra)
		.all();
	for (const { seq } of over) {
		db.delete(memories).where(eq(memories.seq, seq)).run();
		unindexMemory(db, seq);
	}
	mergeIndex(db);
}

function agentEvent(
	action: MemoryAgentEvent["action"],
	run: MemoryRun,
	row: MemoryRow,
): MemoryAgentEvent {
	return {
		action,
		memoryId: row.id,
		excerpt: memoryExcerpt(row),
		agentId: run.agentId,
		agentName: run.agentName,
		runId: run.runId,
		waiting: !row.trusted,
	};
}
