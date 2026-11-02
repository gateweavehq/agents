/**
 * Replaying a run from one of its model requests (AGT-73): a new conversation gets this
 * conversation's messages up to that request, and the agent, as it is now, answers from there.
 * Each run remembers the person's message it answered (`run_messages`), and the steps of its
 * answer are the `step-start` parts of the message that follows.
 */
import type { UIMessage } from "ai";
import type { Sql } from "./trace";

export function createRunMessages(sql: Sql): void {
	sql`CREATE TABLE IF NOT EXISTS run_messages (
		run_id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL
	)`;
}

/** Remembers the message a run answers: the last of the person's when it began. */
export function recordRunMessage(sql: Sql, runId: string, messages: UIMessage[]): void {
	const asked = messages.findLast((message) => message.role === "user");
	if (!asked) return;
	sql`INSERT OR IGNORE INTO run_messages (run_id, message_id) VALUES (${runId}, ${asked.id})`;
}

export function runMessageOf(sql: Sql, runId: string): string | null {
	const [row] = sql<{ message_id: string }>`
		SELECT message_id FROM run_messages WHERE run_id = ${runId}`;
	return row?.message_id ?? null;
}

/**
 * The messages a replay from model request `step` starts with: everything up to the message the
 * run answered, and of its answer, the steps before `step`, with their tool calls and results.
 * Null when the message is no longer there.
 */
export function replayHistory(
	messages: UIMessage[],
	messageId: string,
	step: number,
): UIMessage[] | null {
	const at = messages.findIndex((message) => message.id === messageId);
	if (at === -1) return null;
	const history = messages.slice(0, at + 1);
	const answer = messages[at + 1];
	if (step === 0 || !answer || answer.role !== "assistant") return history;
	const starts = answer.parts.flatMap((part, index) => (part.type === "step-start" ? [index] : []));
	const cut = starts[step] ?? answer.parts.length;
	const parts = answer.parts.slice(0, cut);
	if (parts.length === 0) return history;
	return [...history, { ...answer, id: crypto.randomUUID(), parts }];
}
