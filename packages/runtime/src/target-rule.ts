import {
	normalizeAllowedTarget,
	type ToolTarget,
	targetsIn,
	targetTrusted,
} from "@gateweave/agents-model";
import type { ConversationTurn } from "@gateweave/agents-registry";
import type { UIMessage } from "ai";
import type { RunRecorder } from "./trace";

export interface ParentTargets {
	tainted: boolean;
	trusted: string[];
	texts?: string[];
}

function outsideMessage(message: UIMessage): boolean {
	if (message.role !== "user") return false;
	const metadata = message.metadata;
	// Chat messages have no source marker. Every marked delivery is outside content.
	if (metadata && typeof metadata === "object" && "source" in metadata) return true;
	// Deliveries saved before trigger metadata existed still carry the event introducer.
	return message.parts.some(
		(part) => part.type === "text" && part.text.includes("\n\nThe event, as it was sent:\n\n```"),
	);
}

/** The only destinations carried across an edge are the ones its parent already trusted. */
export function startTargetRule(
	policy: RunRecorder["targets"],
	turn: ConversationTurn,
	messages: UIMessage[],
	memberEmails: () => Promise<string[]>,
	mode?: string,
	parent?: ParentTargets,
): void {
	const { agent } = turn;
	policy.mode = mode === "enforce" ? "enforce" : "log";
	// A new edge inherits its caller's taint. Only earlier deliveries can add to it.
	policy.tainted =
		(parent?.tainted ?? turn.origin !== "person") ||
		messages.some((message, i) => (!parent || i < messages.length - 1) && outsideMessage(message));
	policy.anyTarget = agent.anyTarget ?? false;
	const personHistory = turn.origin === "person" || turn.origin === "replay";
	if (!policy.tainted && personHistory) {
		policy.tainted = messages.some(
			(message) =>
				message.role === "assistant" &&
				message.parts.some((part) => {
					const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
					return (
						(part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
						name !== "remember" &&
						name !== "forget" &&
						"state" in part &&
						(part.state === "output-available" || part.state === "output-error")
					);
				}),
		);
	}
	const sources = () => {
		const trusted = [...(parent?.trusted ?? []), ...(agent.allowedTargets ?? [])];
		for (const host of turn.mcpHosts ?? []) {
			const normalized = normalizeAllowedTarget(host);
			if (normalized) trusted.push(normalized);
		}
		const texts = [...(parent?.texts ?? [])];
		if (agent.instructions) texts.push(agent.instructions);
		if (turn.triggerPrompt) texts.push(turn.triggerPrompt);
		if (personHistory && !parent)
			for (const message of messages) {
				if (message.role !== "user" || outsideMessage(message)) continue;
				for (const part of message.parts) if (part.type === "text") texts.push(part.text);
			}
		return { trusted, texts };
	};
	policy.source = sources;
	let build: Promise<void> | undefined;
	const buildTrusted = async () => {
		const { trusted, texts } = sources();
		for (const value of trusted) policy.trusted.add(value);
		for (const value of await memberEmails()) {
			const target = normalizeAllowedTarget(value);
			if (target) policy.trusted.add(target);
		}
		for (const text of texts) {
			for (const target of targetsIn(text, true)) policy.trusted.add(target.value);
		}
		policy.source = () => ({ trusted: [...policy.trusted], texts: [] });
	};
	policy.buildTrusted = () => (build ??= buildTrusted());
}

// Each is bounded, so a body of unclosed brackets costs a fixed amount per character, not a rescan.
// Every bracketed destination, whatever opened it.
const destination = /\]\(\s{0,10}<?([^\s)>]{1,4000})/g;
// The `]` that ends a plain link: text with no bracket, backslash or line break, and no `!` before.
const plainLinkEnd = /(?<![!\\])\[[^[\]\\\r\n]{0,500}\](?=\()/g;
const htmlOrReference =
	/<(?:img|source|video)\b[^>]{0,1000}?\s(?:src|srcset|poster)\s{0,10}=\s{0,10}["']?([^"'>]{1,4000})|^ {0,3}\[[^\]\r\n]{1,500}\]:[ \t]{0,10}<?(\S{1,4000})/gim;

/**
 * The addresses a page may fetch when it shows `text`: Markdown and HTML images, and reference
 * definitions, which an image can use. A link is followed only by a reader who chooses to, but
 * only a plain one is taken for a link: an image's description may nest brackets, escapes and code
 * spans, so any other bracketed destination counts as an image's.
 */
export function fetchedBy(text: string): string[] {
	const plain = new Set<number>();
	for (const match of text.matchAll(plainLinkEnd)) plain.add(match.index + match[0].length - 1);
	const found: string[] = [];
	for (const match of text.matchAll(destination))
		if (!plain.has(match.index)) found.push(match[1] ?? "");
	for (const match of text.matchAll(htmlOrReference)) found.push(match[1] ?? match[2] ?? "");
	return found;
}

export async function missingTarget(
	run: RunRecorder,
	input: unknown,
	contentFields?: readonly string[],
): Promise<ToolTarget | undefined> {
	if (!run.targets.tainted || run.targets.anyTarget) return;
	await run.targets.buildTrusted?.();
	const destinations =
		contentFields && input && typeof input === "object"
			? Object.fromEntries(
					Object.entries(input).map(([key, value]) => [
						key,
						contentFields.includes(key) && typeof value === "string" ? fetchedBy(value) : value,
					]),
				)
			: input;
	for (const target of targetsIn(destinations)) {
		if (!targetTrusted(target, run.targets.trusted)) return target;
	}
}

export function decisionFor(target?: ToolTarget) {
	return target && { decision: "would_refuse" as const, kind: target.kind, host: target.host };
}

export function refusalFor(target: ToolTarget) {
	return new Error(
		`The target ${target.value} has no trusted source. Add it to the agent's allowed targets, or say it in the chat.`,
	);
}
