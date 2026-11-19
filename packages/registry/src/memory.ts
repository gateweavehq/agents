/**
 * The workspace's memory (AGT-107): short notes its people and agents keep, recalled by keyword.
 *
 * A memory says who or what wrote it and, for an agent, in which run. An agent reads what
 * outsiders wrote: a trigger's event, and in any run an issue, a page or a tool's result. A
 * memory is recalled by every later run that can see it, so one poisoned text would steer them
 * long after its own run ended. So what an agent writes is trusted at once only when both hold:
 *
 * - a person's chat message started the run, which is read here, from the run's own row and
 *   never taken from the caller; and
 * - it is about the agent itself or about that person, so it reaches only that agent's runs, or
 *   that person's.
 *
 * Whatever an agent writes about the workspace or a repository, which every agent or every agent
 * of that repository would recall, and whatever it writes in a run a trigger started, waits: no
 * agent recalls it until an owner or admin approves it. What stays possible: a note an agent
 * keeps for itself in a chat can carry what it read from an outsider during that chat. That is
 * why `recall` hands memories over as notes with their source, never as instructions.
 *
 * An FTS5 table, `memory_search`, holds each memory's text under the memory's `seq`. Every write
 * here changes the row and the index together, inside the caller's transaction.
 */
import {
	MEMORY_LIMITS,
	MEMORY_NOTICE,
	MEMORY_OWN_SCOPES,
	type Memory,
	type MemoryAgentEvent,
	type MemoryOrigin,
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
import { and, asc, count, desc, eq, gt, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { z } from "zod";
import {
	agentDefinitions,
	agents,
	conversations,
	type MemoryRow,
	memories,
	outsideTasks,
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
 * It rewrites the whole index, so only what a person does merges it: an agent's `forget` never
 * does, however often a run calls it.
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
						origin: row.origin ?? "unknown",
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
 * Removes what the workspace's memory holds of someone whose account is gone (`./forget.ts`):
 * the memories about them, and whatever an agent wrote in a run they started, whatever it is
 * about, since it came out of a conversation that was theirs alone and may say something of
 * them. What they typed on the Memory page themselves stays as the team's, under their id, like
 * what else they set up, and so does what other people wrote and what agents wrote in other
 * people's runs.
 */
export function forgetMemoriesOf(db: Db, person: string): void {
	const theirRuns = db.select({ id: runs.id }).from(runs).where(eq(runs.startedBy, person));
	const theirs = or(
		and(eq(memories.scope, "person"), eq(memories.scopeId, person)),
		and(eq(memories.authorKind, "agent"), sql`${memories.runId} IN ${theirRuns}`),
	);
	const rows = db.select({ seq: memories.seq }).from(memories).where(theirs).all();
	if (rows.length === 0) return;
	for (const { seq } of rows) unindexMemory(db, seq);
	db.delete(memories).where(theirs).run();
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
	/** What started it. Anything but `person` is from outside. */
	origin: MemoryOrigin;
}

/**
 * What started a run: a person's chat message, a trigger, or a replay, however far back, of a run
 * a trigger started, whose words are its history. A link that cannot be followed (a conversation
 * since deleted) answers `unknown`, so that what cannot be shown is not trusted: all but `person`
 * count as content from outside.
 */
function runOrigin(
	db: Db,
	run: { triggerId: string | null; startedBy: string; conversationId: string | null },
): MemoryOrigin {
	let current = run;
	for (let hop = 0; hop < REPLAY_HOPS; hop++) {
		const replay = hop > 0;
		if ((current.triggerId ?? triggerOf(current.startedBy)) !== null) {
			return replay ? "replay" : "trigger";
		}
		if (current.conversationId === null) return "unknown";
		const conversation = conversationAtTop(db, current.conversationId);
		if (!conversation) return "unknown";
		if (conversation.triggerId !== null) return replay ? "replay" : "trigger";
		// An MCP client's task is outside content, however its conversation came to name a person:
		// its words are the client's, not something the person typed.
		if (outsideTaskConversation(db, conversation.id)) return "outside";
		if (conversation.replayOf === null) return "person";
		const replayed = db
			.select({
				triggerId: runs.triggerId,
				startedBy: runs.startedBy,
				conversationId: runs.conversationId,
			})
			.from(runs)
			.where(eq(runs.id, conversation.replayOf))
			.get();
		if (!replayed) return "unknown";
		current = replayed;
	}
	return "unknown";
}

/** Whether an outside task (`run_agent`) opened the conversation, begun or not. */
function outsideTaskConversation(db: Db, conversationId: string): boolean {
	return (
		db
			.select({ id: outsideTasks.conversationId })
			.from(outsideTasks)
			.where(eq(outsideTasks.conversationId, conversationId))
			.get() !== undefined
	);
}

/** A conversation, or for a team's nested turn the conversation it goes with. */
function conversationAtTop(db: Db, id: string) {
	const columns = {
		id: conversations.id,
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
	// Deleting a conversation, or the account of whoever started it, takes the run's link to it
	// while the turn may still be going. What it wrote then would outlive what was just removed.
	if (run.conversationId === null) {
		return refused("This run's conversation was deleted, so it cannot use the workspace's memory");
	}
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
		origin: runOrigin(db, run),
	};
}

/**
 * Why a run's agent writes no more to memory, or null when it may. Without it a run could store
 * and take back in a loop, each round an index write, two audit entries and, past the limit on
 * forgotten memories, the end of one kept for people to read.
 */
function runLimitRefusal(
	db: Db,
	run: MemoryRun,
	action: "remember" | "forget",
): MemoryRefusal | null {
	const [limit, by] =
		action === "remember"
			? [MEMORY_LIMITS.runRemembers, eq(memories.runId, run.runId)]
			: [MEMORY_LIMITS.runForgets, eq(memories.forgottenRunId, run.runId)];
	const done = db.select({ n: count() }).from(memories).where(by).get()?.n ?? 0;
	if (done < limit) return null;
	return refused(
		action === "remember"
			? `This run has stored ${limit} memories, which is the most one run may. Go on without storing more.`
			: `This run has taken back ${limit} memories, which is the most one run may. An owner or admin can delete others on the Memory page.`,
	);
}

/**
 * An agent's `remember`, in a run that is going. The memory is trusted at once only when a
 * person's chat message started the run and it is about the agent itself or that person.
 * Otherwise it waits for an owner or admin: what every agent would recall is theirs to let in,
 * whatever the run read before it wrote.
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
	const over = runLimitRefusal(db, run, "remember");
	if (over) return over;
	const trusted = run.origin === "person" && MEMORY_OWN_SCOPES.includes(input.scope);
	const full = fullRefusal(db, trusted);
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
			origin: run.origin,
			trusted,
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

/** Where an agent's memory that waited came from, in the words `recall` gives the model. */
const ORIGIN_WORDS: Record<MemoryOrigin, string> = {
	person: "in a run a person's message started",
	trigger: "in a run a trigger started",
	replay: "in a replay of a run a trigger started",
	outside: "in a run an outside task started",
	unknown: "in a run whose start could not be read",
};

/**
 * Who or what wrote a memory, as the model reads it: the agent or a person, that a person changed
 * its words since, and for one that waited, where it came from and that a person approved it.
 */
function provenance(db: Db, row: MemoryRow): string {
	const agent =
		row.authorKind === "agent"
			? db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.authorId)).get()
			: undefined;
	const writer =
		row.authorKind === "agent" ? `the agent ${agent?.name ?? "(removed)"}` : "a person";
	// Only an agent's: a person's memory edited by a person is still a person's.
	const edited =
		row.authorKind === "agent" && row.editedBy !== null ? `${writer}, edited by a person` : writer;
	if (row.approvedBy === null) return edited;
	return `${edited}, ${ORIGIN_WORDS[row.origin ?? "unknown"]}; a person approved it`;
}

function toRecalled(db: Db, row: MemoryRow): RecalledMemory {
	const source = [row.sourceLabel, row.sourceUrl].filter((part) => part !== null).join(" ");
	return {
		id: row.id,
		text: row.text,
		kind: row.kind,
		scope: row.scope,
		writtenBy: provenance(db, row),
		source: source === "" ? null : source,
		date: new Date(row.createdAt).toISOString().slice(0, 10),
	};
}

/** Why a run counts as from outside, to begin a refusal with. */
const NOT_A_PERSONS: Record<Exclude<MemoryOrigin, "person">, string> = {
	trigger: "A trigger started this run",
	replay: "This run replays one a trigger started",
	outside: "An outside task started this run",
	unknown: "What started this run could not be read",
};

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
	if (run.origin !== "person" && current.trusted) {
		return refused(
			`${NOT_A_PERSONS[run.origin]}, so it can only take back memories that still wait for approval. An owner or admin can delete this one on the Memory page.`,
		);
	}
	const over = runLimitRefusal(db, run, "forget");
	if (over) return over;
	db.update(memories)
		.set({ forgottenAt: now, forgottenRunId: run.runId, updatedAt: now })
		.where(eq(memories.seq, current.seq))
		.run();
	dropOldestForgotten(db);
	return { event: agentEvent("forgotten", run, current) };
}

/**
 * Keeps the forgotten memories within their limit: the ones forgotten longest ago go. The index
 * is not merged for it, since an agent's call brings it about (`mergeIndex`): what is left of
 * their words in the index's pages goes with the next memory a person deletes.
 */
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
		scope: row.scope,
		agentId: run.agentId,
		agentName: run.agentName,
		runId: run.runId,
		origin: run.origin,
		waiting: !row.trusted,
	};
}
