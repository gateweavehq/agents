/**
 * Turns the sample data into what the registry and the conversations take: scans as the scanner
 * would make them, and the history of past conversations, with runs, traces and messages whose
 * numbers add up. Pure, so a test can check it all without a Worker.
 */
import { createHash } from "node:crypto";
import { detect, type TreeFile, wantsFile } from "@gateweave/agents-adapters";
import {
	edgeToolName,
	type ModelSpan,
	type RepositoryInput,
	type RequestTokens,
	type RunSpan,
	requestCost,
	type ScanResult,
} from "@gateweave/agents-model";
import type {
	SampleConversation,
	SampleRun,
	SampleWiki,
	SourceFile,
} from "@gateweave/agents-registry";
import type { UIMessage } from "ai";
import {
	type DemoAgent,
	PAST_CONVERSATIONS,
	SAMPLE_HOST,
	SAMPLE_OWNER,
	type SampleRepositoryData,
	WIKI,
} from "./sample-data";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Git's id for a file with this text, as `git hash-object` computes it. */
export function blobOf(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** The repository as a connection would list it. Nothing reaches it: there is no connection. */
export function repositoryInput(repository: SampleRepositoryData): RepositoryInput {
	return {
		provider: "gitlab",
		externalId: repository.externalId,
		installationId: "demo",
		owner: SAMPLE_OWNER,
		name: repository.name,
		webUrl: `${SAMPLE_HOST}/${SAMPLE_OWNER}/${repository.name}`,
		defaultBranch: repository.defaultBranch,
		private: true,
	};
}

/**
 * A scan of the repository holding these files, as the scanner makes one: the adapters detect
 * what the files the agents read hold, and the scan keeps those files, with their text.
 */
export function sampleScan(files: Record<string, string>, commit: string, at: number): ScanResult {
	const tree = new Map<string, TreeFile>();
	const read: ScanResult["files"] = [];
	for (const [path, content] of Object.entries(files)) {
		const blob = blobOf(content);
		const size = new TextEncoder().encode(content).byteLength;
		const wanted = wantsFile(path);
		tree.set(path, { blob, size, ...(wanted ? { content } : {}) });
		if (wanted) read.push({ path, blob, size, symlink: false, content });
	}
	read.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const detection = detect(tree);
	return {
		commit,
		scannedAt: at,
		agents: detection.agents,
		assets: detection.assets,
		problems: detection.problems,
		files: read,
	};
}

/** A sample agent as the registry made it. */
export interface MadeAgent {
	id: string;
	agent: DemoAgent;
}

/** One conversation's part of the history, for its Durable Object. */
export interface PastConversation {
	conversationId: string;
	messages: UIMessage[];
	runs: { id: string; startedAt: number; endedAt: number; spans: RunSpan[] }[];
}

export interface PastHistory {
	conversations: SampleConversation[];
	runs: SampleRun[];
	/** What each conversation's Durable Object holds. */
	objects: PastConversation[];
}

/** A model request of a sample run, as a recorder would have left it. */
function modelSpan(
	agent: DemoAgent,
	step: number,
	startedAt: number,
	ms: number,
	tokens: RequestTokens,
	finishReason: "stop" | "tool-calls",
): ModelSpan {
	return {
		id: crypto.randomUUID(),
		kind: "model",
		step,
		status: "ok",
		startedAt,
		endedAt: startedAt + ms,
		error: null,
		model: agent.model,
		inputTokens: tokens.input,
		outputTokens: tokens.output,
		cachedInputTokens: tokens.cacheRead,
		cost: requestCost(agent.provider, agent.model, tokens, startedAt),
		finishReason,
		firstTokenMs: Math.round(ms / 5),
		gatewayLogId: null,
	};
}

/** What a run adds up to from its model requests, as `closeRun` in the runtime sums it. */
function totals(spans: readonly RunSpan[]) {
	const models = spans.filter((span): span is ModelSpan => span.kind === "model");
	const sum = (pick: (span: ModelSpan) => number) =>
		models.reduce((total, span) => total + pick(span), 0);
	return {
		steps: models.length,
		inputTokens: sum((span) => span.inputTokens),
		outputTokens: sum((span) => span.outputTokens),
		cachedInputTokens: sum((span) => span.cachedInputTokens),
		cost: models.some((span) => span.cost === null) ? null : sum((span) => span.cost ?? 0),
	};
}

function tokens(input: number, output: number, cacheRead = 0): RequestTokens {
	return { input, output, cacheRead, cacheWrite: 0 };
}

function userMessage(text: string): UIMessage {
	return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

function answer(text: string): UIMessage {
	return { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text }] };
}

/**
 * The conversations the visitor seems to have had: one with the team, whose lead handed work to
 * the other two, and one each with the reviewer and the docs writer. Each run's totals are its
 * trace's, and each trace's costs are list prices for its tokens.
 */
export function pastHistory(
	agents: { lead: MadeAgent; reviewer: MadeAgent; writer: MadeAgent },
	teamId: string,
	now: number,
): PastHistory {
	const history: PastHistory = { conversations: [], runs: [], objects: [] };
	const { lead, reviewer, writer } = agents;

	// With the team: the lead hands the review and the notes over, each in a conversation of its own.
	const release = PAST_CONVERSATIONS.release;
	const releaseId = crypto.randomUUID();
	const leadRunId = crypto.randomUUID();
	const at = now - release.hoursAgo * HOUR_MS;
	const handOff = lead.agent.script.handOff ?? "";
	const first = modelSpan(lead.agent, 0, at + 400, 2_600, tokens(1_840, 132), "tool-calls");
	const nested = [reviewer, writer].map((member, index) => {
		const conversationId = crypto.randomUUID();
		const runId = crypto.randomUUID();
		const edgeSpanId = crypto.randomUUID();
		const startedAt = first.endedAt ?? at;
		const spans: RunSpan[] =
			index === 0
				? [modelSpan(member.agent, 0, startedAt + 150, 14_200, tokens(9_620, 384, 6_144), "stop")]
				: [modelSpan(member.agent, 0, startedAt + 120, 6_800, tokens(3_210, 296), "stop")];
		const endedAt = (spans.at(-1)?.endedAt ?? startedAt) + 90;
		return { member, conversationId, runId, edgeSpanId, startedAt, endedAt, spans };
	});
	const edgesEnd = Math.max(...nested.map((each) => each.endedAt));
	const second = modelSpan(lead.agent, 1, edgesEnd + 60, 9_400, tokens(4_380, 612, 1_536), "stop");
	const leadSpans: RunSpan[] = [
		first,
		...nested.map(
			(each): RunSpan => ({
				id: each.edgeSpanId,
				kind: "edge",
				step: 0,
				status: "ok",
				startedAt: each.startedAt,
				endedAt: each.endedAt + 40,
				error: null,
				edge: "delegate",
				to: each.member.id,
				childRunId: each.runId,
			}),
		),
		second,
	];
	const leadEnd = (second.endedAt ?? edgesEnd) + 120;
	history.conversations.push({
		id: releaseId,
		agentId: lead.id,
		teamId,
		rootId: null,
		title: release.text,
		startedAt: at,
		updatedAt: leadEnd,
	});
	history.runs.push({
		id: leadRunId,
		agentId: lead.id,
		conversationId: releaseId,
		provider: lead.agent.provider,
		model: lead.agent.model,
		status: "succeeded",
		error: null,
		...totals(leadSpans),
		startedAt: at,
		endedAt: leadEnd,
		teamPath: [teamId],
		parent: null,
	});
	history.objects.push({
		conversationId: releaseId,
		messages: [
			userMessage(release.text),
			{
				id: crypto.randomUUID(),
				role: "assistant",
				parts: [
					...nested.map((each, index) => ({
						type: `tool-${edgeToolName("delegate", each.member.agent.name)}` as const,
						toolCallId: `demo-call-${index + 1}`,
						state: "output-available" as const,
						input: { task: handOff },
						output: each.member.agent.script.answer,
					})),
					{ type: "text" as const, text: lead.agent.script.afterTeam ?? "" },
				],
			},
		],
		runs: [{ id: leadRunId, startedAt: at, endedAt: leadEnd, spans: leadSpans }],
	});
	for (const each of nested) {
		history.conversations.push({
			id: each.conversationId,
			agentId: each.member.id,
			teamId: null,
			rootId: releaseId,
			title: handOff,
			startedAt: each.startedAt,
			updatedAt: each.endedAt,
		});
		history.runs.push({
			id: each.runId,
			agentId: each.member.id,
			conversationId: each.conversationId,
			provider: each.member.agent.provider,
			model: each.member.agent.model,
			status: "succeeded",
			error: null,
			...totals(each.spans),
			startedAt: each.startedAt,
			endedAt: each.endedAt,
			teamPath: [teamId],
			parent: {
				parentRunId: leadRunId,
				parentSpanId: each.edgeSpanId,
				rootRunId: leadRunId,
				edge: "delegate",
				depth: 1,
			},
		});
		history.objects.push({
			conversationId: each.conversationId,
			messages: [userMessage(handOff), answer(each.member.agent.script.answer)],
			runs: [
				{ id: each.runId, startedAt: each.startedAt, endedAt: each.endedAt, spans: each.spans },
			],
		});
	}

	// One each with the reviewer and the docs writer.
	const alone = [
		{ member: reviewer, ...PAST_CONVERSATIONS.review, request: tokens(11_480, 402, 6_144) },
		{ member: writer, ...PAST_CONVERSATIONS.notes, request: tokens(2_960, 188) },
	];
	for (const { member, text, hoursAgo, request } of alone) {
		const conversationId = crypto.randomUUID();
		const runId = crypto.randomUUID();
		const startedAt = now - hoursAgo * HOUR_MS;
		const spans: RunSpan[] = [modelSpan(member.agent, 0, startedAt + 300, 11_000, request, "stop")];
		const endedAt = (spans.at(-1)?.endedAt ?? startedAt) + 100;
		history.conversations.push({
			id: conversationId,
			agentId: member.id,
			teamId: null,
			rootId: null,
			title: text,
			startedAt,
			updatedAt: endedAt,
		});
		history.runs.push({
			id: runId,
			agentId: member.id,
			conversationId,
			provider: member.agent.provider,
			model: member.agent.model,
			status: "succeeded",
			error: null,
			...totals(spans),
			startedAt,
			endedAt,
			teamPath: null,
			parent: null,
		});
		history.objects.push({
			conversationId,
			messages: [userMessage(text), answer(member.agent.script.answer)],
			runs: [{ id: runId, startedAt, endedAt, spans }],
		});
	}
	return history;
}

/** Lines in a file, as the wiki's writer counts them: its last newline starts no line. */
function linesOf(text: string): number {
	return text.replace(/\r?\n$/, "").split("\n").length;
}

/** The wiki of a repository with these files, written a while before the sandbox opened. */
export function sampleWiki(
	repositoryId: string,
	repository: SampleRepositoryData,
	now: number,
): SampleWiki {
	const files = { ...repository.code, ...repository.agentFiles };
	const startedAt = now - WIKI.hoursAgo * HOUR_MS;
	const sources: SourceFile[] = Object.entries(files).map(([path, text]) => ({
		path,
		blob: blobOf(text),
		size: new TextEncoder().encode(text).byteLength,
		symlink: false,
	}));
	return {
		repositoryId,
		model: WIKI.model,
		commit: repository.commit,
		// The tree's id only says which tree the pages read; nothing reads it again here.
		tree: blobOf(JSON.stringify(Object.keys(files).sort())),
		plan: {
			steered: false,
			steeringProblem: null,
			notes: [],
			pages: WIKI.pages.map(({ title, purpose, files: read }) => ({
				title,
				purpose,
				parent: null,
				notes: [],
				files: read,
			})),
		},
		files: sources,
		pages: Object.fromEntries(
			WIKI.pages.map((page) => [
				page.title,
				{
					body: page.body,
					sources: page.files.map((path) => ({ path, lines: linesOf(files[path] ?? "") })),
				},
			]),
		),
		usage: { tokens: { input: 48_200, output: 6_350, cacheRead: 12_000, cacheWrite: 0 } },
		startedAt,
		finishedAt: startedAt + 4 * MINUTE_MS,
	};
}
