/**
 * A team's edges as tools for one turn: `delegate__<name>`, `ask__<name>` and `report__<name>`,
 * one for each edge the registry says the turn's agent can take where it stands. Taking one runs a
 * turn of the agent at the other end, in a conversation of its own (`ConversationAgent`), which
 * sees only what the tool sends it.
 */
import { EDGE_TOOL_NAME_LENGTH, edgeToolName, type TurnEdge } from "@gateweave/agents-model";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { decisionFor, missingTarget, refusalFor } from "./target-rule";
import type { RunRecorder } from "./trace";

/** The longest text one edge carries, as the registry takes a message. */
const MAX_TEXT = 100_000;

/**
 * Takes an edge with this text. Returns what the calling model reads: the answer, or that a
 * report went out. `call` names the call as the chat will: `toolCallId` is the id the loop gave
 * it, and `toolName` the tool's name, which an engine's chat knows the call by instead. The run
 * the edge starts is tied back to the call through one of them. Throws with why it could not, in
 * words the model reads too.
 */
export type TakeEdge = (
	edge: TurnEdge,
	text: string,
	call: { toolCallId: string; toolName: string; span: string },
	signal?: AbortSignal,
) => Promise<string>;

export function edgeTools(run: RunRecorder, edges: TurnEdge[], take: TakeEdge): ToolSet {
	const tools: ToolSet = {};
	for (const edge of edges) {
		const name = nameOf(tools, edgeToolName(edge.kind, edge.name));
		tools[name] = edgeTool(edge, name, async (edge, text, call, signal) => {
			const missing = await missingTarget(run, text);
			const span = run.edgeStarted(edge.kind, edge.name, undefined, decisionFor(missing));
			if (missing && run.targets.mode === "enforce") {
				run.edgeRefused(span);
				throw refusalFor(missing);
			}
			return take(edge, text, { ...call, span }, signal);
		});
	}
	return tools;
}

function edgeTool(
	edge: TurnEdge,
	toolName: string,
	take: (
		edge: TurnEdge,
		text: string,
		call: { toolName: string; toolCallId: string },
		signal?: AbortSignal,
	) => Promise<string>,
): ToolSet[string] {
	const { name } = edge;
	const who = edge.lead === null ? name : `${name}, a team that ${edge.lead} answers for`;
	const about = edge.description ? ` About ${name}: ${edge.description}` : "";
	const text = (what: string) => z.string().min(1).max(MAX_TEXT).describe(what);
	switch (edge.kind) {
		case "delegate":
			return tool({
				description: `Hands a task to ${who} and waits for the result. ${name} works on it with its own tools and sees nothing but the task, so give it everything it needs.${about}`,
				inputSchema: z.object({ task: text("The task, with everything needed to do it") }),
				execute: ({ task }, { toolCallId, abortSignal }) =>
					take(edge, task, { toolCallId, toolName }, abortSignal),
			});
		case "ask":
			return tool({
				description: `Asks ${who} one question and waits for the answer. ${name} answers from what it knows, without tools, and sees nothing but the question.${about}`,
				inputSchema: z.object({ question: text("The question, with what is needed to answer it") }),
				execute: ({ question }, { toolCallId, abortSignal }) =>
					take(edge, question, { toolCallId, toolName }, abortSignal),
			});
		case "report":
			return tool({
				description: `Sends ${who} a message and goes on without waiting for an answer. ${name} takes a turn of its own on it and sees nothing but the message.${about}`,
				inputSchema: z.object({ message: text("The message") }),
				// A report goes on by itself, so the turn stopping does not stop it.
				execute: ({ message }, { toolCallId }) => take(edge, message, { toolCallId, toolName }),
			});
	}
}

/** `base`, cut to length, or with a number after it when an edge to a namesake took it. */
function nameOf(tools: ToolSet, base: string): string {
	let name = base.slice(0, EDGE_TOOL_NAME_LENGTH);
	for (let n = 2; name in tools; n++) {
		const suffix = `_${n}`;
		name = `${base.slice(0, EDGE_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
	}
	return name;
}
