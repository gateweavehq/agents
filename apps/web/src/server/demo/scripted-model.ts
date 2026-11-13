/**
 * The model the public demo's agents answer with: a stand-in that streams answers written in
 * advance, so a visitor's message costs nothing and reaches no provider. What it says depends on
 * which agent asks and which of its team's edges it can take, never on what the visitor wrote, so
 * nothing they type can steer it. It reports tokens as a model would, from the lengths of what it
 * read and wrote, so runs and traces show the numbers a real turn would have.
 */
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4Prompt,
	LanguageModelV4StreamPart,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { DEMO_AGENTS } from "./sample-data";

/** The edge tools a team's agent may take, in the order the script prefers them. */
const EDGE_PREFIXES = ["delegate__", "ask__", "report__"] as const;

/** The input each kind of edge takes (`packages/runtime/src/edges.ts`). */
const EDGE_INPUT: Record<(typeof EDGE_PREFIXES)[number], string> = {
	delegate__: "task",
	ask__: "question",
	report__: "message",
};

/** How long the script waits between the pieces it streams, so an answer arrives as one does. */
const CHUNK_DELAY_MS = 15;

/** Words per streamed piece. */
const CHUNK_WORDS = 4;

export interface ScriptedAgent {
	name: string;
	model: string;
}

/** A stand-in for `agent`'s model that streams its script. */
export function scriptedModel(
	agent: ScriptedAgent,
	options: { chunkDelayInMs?: number } = {},
): LanguageModelV4 {
	const delay = options.chunkDelayInMs ?? CHUNK_DELAY_MS;
	return {
		specificationVersion: "v4",
		provider: "demo-script",
		modelId: agent.model,
		supportedUrls: {},
		async doGenerate(call) {
			const step = scriptedStep(agent, call);
			return {
				content:
					step.kind === "text"
						? [{ type: "text", text: step.text }]
						: step.calls.map((tool) => ({ type: "tool-call", ...tool })),
				finishReason: {
					unified: step.kind === "text" ? "stop" : "tool-calls",
					raw: undefined,
				},
				usage: usageOf(call.prompt, step),
				warnings: [],
			};
		},
		async doStream(call) {
			const step = scriptedStep(agent, call);
			return {
				stream: simulateReadableStream({
					chunks: streamParts(agent, call.prompt, step),
					chunkDelayInMs: delay,
				}),
			};
		},
	};
}

/** What the script does at this step: write an answer, or take the team's edges. */
export type ScriptedStep =
	| { kind: "text"; text: string }
	| { kind: "tools"; calls: { toolCallId: string; toolName: string; input: string }[] };

/**
 * The script's next step. An agent that can take its team's edges takes each of them once, at its
 * first step, and answers once their results are back; any other answers at once.
 */
export function scriptedStep(
	agent: ScriptedAgent,
	call: Pick<LanguageModelV4CallOptions, "prompt" | "tools">,
): ScriptedStep {
	const resultsBack = call.prompt.some((message) => message.role === "tool");
	const script = DEMO_AGENTS.find((each) => each.name === agent.name)?.script;
	const edges = (call.tools ?? [])
		.map((tool) => tool.name)
		.filter((name) => EDGE_PREFIXES.some((prefix) => name.startsWith(prefix)));
	if (!resultsBack && edges.length > 0) {
		return {
			kind: "tools",
			calls: edges.map((toolName, index) => {
				const prefix = EDGE_PREFIXES.find((each) => toolName.startsWith(each)) ?? "delegate__";
				const text = script?.handOff ?? GENERIC_HAND_OFF;
				return {
					toolCallId: `demo-call-${index + 1}`,
					toolName,
					input: JSON.stringify({ [EDGE_INPUT[prefix]]: text }),
				};
			}),
		};
	}
	if (resultsBack) return { kind: "text", text: script?.afterTeam ?? GENERIC_AFTER_TEAM };
	return { kind: "text", text: script?.answer ?? genericAnswer(agent) };
}

const GENERIC_HAND_OFF =
	"Please take a look at this for the team and send back what you find, in a few short points.";

const GENERIC_AFTER_TEAM =
	"I asked my team and put their answers together. In this demo every agent answers from a script, so this is the shape of a team's turn rather than a real answer: open the run in Runs to see each turn it led to, with its tokens and estimated cost.";

function genericAnswer(agent: ScriptedAgent): string {
	return `This is the public demo, so I answer from a script, and nothing you write here reaches a model. In a workspace of your own, ${agent.name} would answer with ${agent.model}, using its instructions, its MCP servers and its team, with the workspace's own key. The run this message started is in Runs, with its trace and an estimate of what it would have cost.`;
}

function streamParts(
	agent: ScriptedAgent,
	prompt: LanguageModelV4Prompt,
	step: ScriptedStep,
): LanguageModelV4StreamPart[] {
	const parts: LanguageModelV4StreamPart[] = [
		{ type: "stream-start", warnings: [] },
		{
			type: "response-metadata",
			id: `demo-${crypto.randomUUID()}`,
			modelId: agent.model,
			timestamp: new Date(),
		},
	];
	if (step.kind === "text") {
		parts.push({ type: "text-start", id: "text-1" });
		for (const delta of pieces(step.text)) parts.push({ type: "text-delta", id: "text-1", delta });
		parts.push({ type: "text-end", id: "text-1" });
	} else {
		for (const tool of step.calls) parts.push({ type: "tool-call", ...tool });
	}
	parts.push({
		type: "finish",
		finishReason: { unified: step.kind === "text" ? "stop" : "tool-calls", raw: undefined },
		usage: usageOf(prompt, step),
	});
	return parts;
}

/** The text in pieces of a few words, each with the space before the next. */
function pieces(text: string): string[] {
	const words = text.split(/(?<= )/);
	const out: string[] = [];
	for (let at = 0; at < words.length; at += CHUNK_WORDS) {
		out.push(words.slice(at, at + CHUNK_WORDS).join(""));
	}
	return out;
}

/** Tokens as a model would count them, near enough: about four characters each. */
function usageOf(prompt: LanguageModelV4Prompt, step: ScriptedStep): LanguageModelV4Usage {
	const read = JSON.stringify(prompt).length;
	const written = step.kind === "text" ? step.text.length : JSON.stringify(step.calls).length;
	const input = Math.ceil(read / 4);
	const output = Math.ceil(written / 4);
	return {
		inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: output, text: output, reasoning: 0 },
	};
}
