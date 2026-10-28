/**
 * A team's edges as tools for one turn: `delegate__<name>`, `ask__<name>` and `report__<name>`,
 * one for each edge the registry says the turn's agent can take where it stands. Taking one runs a
 * turn of the agent at the other end, in a conversation of its own (`ConversationAgent`), which
 * sees only what the tool sends it.
 */
import type { TurnEdge } from "@gateweave/agents-model";
import { type ToolSet, tool } from "ai";
import { z } from "zod";

/** Providers take tool names of up to 64 letters, digits, `_` and `-`. */
const TOOL_NAME = { length: 64, unsafe: /[^A-Za-z0-9_-]/g };

/** The longest text one edge carries, as the registry takes a message. */
const MAX_TEXT = 100_000;

/**
 * Takes an edge with this text. Returns what the calling model reads: the answer, or that a
 * report went out. Throws with why it could not, in words the model reads too.
 */
export type TakeEdge = (edge: TurnEdge, text: string, signal?: AbortSignal) => Promise<string>;

export function edgeTools(edges: TurnEdge[], take: TakeEdge): ToolSet {
	const tools: ToolSet = {};
	for (const edge of edges) {
		tools[nameOf(tools, `${edge.kind}__${edge.name.replace(TOOL_NAME.unsafe, "_")}`)] = edgeTool(
			edge,
			take,
		);
	}
	return tools;
}

function edgeTool(edge: TurnEdge, take: TakeEdge): ToolSet[string] {
	const { name } = edge;
	const who = edge.lead === null ? name : `${name}, a team that ${edge.lead} answers for`;
	const about = edge.description ? ` About ${name}: ${edge.description}` : "";
	const text = (what: string) => z.string().min(1).max(MAX_TEXT).describe(what);
	switch (edge.kind) {
		case "delegate":
			return tool({
				description: `Hands a task to ${who} and waits for the result. ${name} works on it with its own tools and sees nothing but the task, so give it everything it needs.${about}`,
				inputSchema: z.object({ task: text("The task, with everything needed to do it") }),
				execute: ({ task }, { abortSignal }) => take(edge, task, abortSignal),
			});
		case "ask":
			return tool({
				description: `Asks ${who} one question and waits for the answer. ${name} answers from what it knows, without tools, and sees nothing but the question.${about}`,
				inputSchema: z.object({ question: text("The question, with what is needed to answer it") }),
				execute: ({ question }, { abortSignal }) => take(edge, question, abortSignal),
			});
		case "report":
			return tool({
				description: `Sends ${who} a message and goes on without waiting for an answer. ${name} takes a turn of its own on it and sees nothing but the message.${about}`,
				inputSchema: z.object({ message: text("The message") }),
				// A report goes on by itself, so the turn stopping does not stop it.
				execute: ({ message }) => take(edge, message),
			});
	}
}

/** `base`, cut to length, or with a number after it when an edge to a namesake took it. */
function nameOf(tools: ToolSet, base: string): string {
	let name = base.slice(0, TOOL_NAME.length);
	for (let n = 2; name in tools; n++) {
		const suffix = `_${n}`;
		name = `${base.slice(0, TOOL_NAME.length - suffix.length)}${suffix}`;
	}
	return name;
}
