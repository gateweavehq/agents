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
	const metadata = message.metadata;
	if (
		metadata &&
		typeof metadata === "object" &&
		"source" in metadata &&
		(metadata.source === "trigger" || metadata.source === "edge")
	)
		return true;
	// Deliveries saved before trigger metadata existed still carry the event introducer.
	return (
		message.role === "user" &&
		message.parts.some(
			(part) => part.type === "text" && part.text.includes("\n\nThe event, as it was sent:\n\n```"),
		)
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

export async function missingTarget(
	run: RunRecorder,
	input: unknown,
): Promise<ToolTarget | undefined> {
	if (!run.targets.tainted || run.targets.anyTarget) return;
	await run.targets.buildTrusted?.();
	for (const target of targetsIn(input)) {
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
