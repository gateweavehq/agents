import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	MOVING_MESSAGE,
	type MoveTarget,
	moveWorkspace,
	type WorkspaceMove,
} from "@gateweave/agents-registry";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationName, MOVED_IN } from "../src";
import { anthropicStream, ask, connect, fakeModel, KEY } from "./support";

// Moving a workspace's registry and conversations to other Durable Objects (`move.ts` in the
// registry package), as the app does to keep them in a jurisdiction. Local workerd has no
// jurisdictions, so these move a workspace to another workspace id instead: its objects' names
// change, which to the move is just another set of stubs, and the copied conversations reach the
// copied registry by their names.

afterEach(() => {
	vi.restoreAllMocks();
});

/** A workspace with an agent, a key and a conversation that took one turn. */
async function workspaceWithTalk() {
	const workspaceId = crypto.randomUUID();
	const registry = env.REGISTRY.getByName(workspaceId);
	const rules = await registry.createLibraryAsset({
		kind: "instructions",
		name: "rules",
		text: "Answer in one word.\n",
	});
	const agent = await registry.createAgent({
		name: "Reviewer",
		description: null,
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: rules, version: 1 },
	});
	await registry.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
	const started = await registry.startConversation(agent.id, "user-ada");
	const conversationId = started?.id ?? "";
	const stub = await getAgentByName(
		env.CONVERSATIONS,
		conversationName(workspaceId, conversationId),
	);
	fakeModel(() => anthropicStream("Looks good."));
	const socket = await connect(stub);
	const turn = await ask(socket, `Review my change, please. ${"Some context. ".repeat(300)}`);
	expect(turn.error).toBeNull();
	socket.close();
	vi.restoreAllMocks();
	return { workspaceId, conversationId, registry, stub };
}

/** The objects of workspace `from` and of `to`, named for each, as the app's move passes them. */
function movingTo(
	from: string,
	to: string,
	options: {
		record?: () => Promise<void>;
		target?: (target: MoveTarget) => MoveTarget;
	} = {},
): WorkspaceMove {
	const restarting = (stub: MoveTarget): MoveTarget => {
		const target = options.target ? options.target(stub) : stub;
		return {
			moveIn: (token, manifest) => target.moveIn(token, manifest),
			moveWrite: (token, page) => target.moveWrite(token, page),
			moveWriteKeys: (token, entries) => target.moveWriteKeys(token, entries),
			moveCheck: (token, manifest) => target.moveCheck(token, manifest),
			moveDigest: () => target.moveDigest(),
			async moveStart(place) {
				try {
					await target.moveStart(place);
				} catch (error) {
					if ((error instanceof Error ? error.message : String(error)) !== MOVED_IN) throw error;
				}
			},
		};
	};
	return {
		registry: { from: env.REGISTRY.getByName(from), to: env.REGISTRY.getByName(to) },
		conversation: (id) => ({
			from: env.CONVERSATIONS.getByName(conversationName(from, id)),
			to: restarting(env.CONVERSATIONS.getByName(conversationName(to, id))),
		}),
		from: "",
		to: "elsewhere",
		record: options.record ?? (async () => {}),
	};
}

async function messagesOf(stub: { fetch(url: string): Promise<Response> }) {
	const response = await stub.fetch("http://conversation/get-messages");
	return {
		status: response.status,
		body: response.ok ? ((await response.json()) as unknown[]) : [],
	};
}

describe("moving a workspace", () => {
	it("copies the registry and every conversation, which carry on where they went", async () => {
		const { workspaceId, conversationId, registry, stub } = await workspaceWithTalk();
		const before = await messagesOf(stub);
		expect(before.body).toHaveLength(2);
		const moved = crypto.randomUUID();
		let recorded = 0;

		const report = await moveWorkspace(
			movingTo(workspaceId, moved, {
				record: async () => {
					recorded++;
				},
			}),
			{ pageChars: 2000, retryMs: 1 },
		);
		expect(report).toMatchObject({ moved: true, conversations: 1, finished: false });
		expect(recorded).toBe(1);

		// The copy has the messages, and its registry the conversation, its run and the key.
		const copy = await getAgentByName(env.CONVERSATIONS, conversationName(moved, conversationId));
		expect((await messagesOf(copy)).body).toEqual(before.body);
		const copiedRegistry = env.REGISTRY.getByName(moved);
		expect((await copiedRegistry.getConversation(conversationId, "user-ada"))?.title).toBe(
			(await registry.getConversation(conversationId, "user-ada"))?.title,
		);
		expect(await copiedRegistry.listProviderKeys()).toEqual(await registry.listProviderKeys());

		// The old objects are sealed: the conversation takes no socket, the registry no write.
		expect((await messagesOf(stub)).status).toBe(503);
		const late = await registry
			.createLibraryAsset({ kind: "instructions", name: "late", text: "Too late.\n" })
			.then(
				() => null,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
		expect(late).toContain(MOVING_MESSAGE);

		// The copy takes the next turn, with the history it came with.
		const requests = fakeModel(() => anthropicStream("Still good."));
		const socket = await connect(copy);
		const turn = await ask(socket, "And now?");
		expect(turn).toMatchObject({ text: "Still good.", error: null });
		expect(JSON.stringify(requests[0]?.body.messages)).toContain("Review my change, please");
		socket.close();
		expect((await messagesOf(copy)).body).toHaveLength(4);
	});

	it("leaves the workspace working where it was when a copy doesn't check out", async () => {
		const { workspaceId, conversationId, registry, stub } = await workspaceWithTalk();
		const moved = crypto.randomUUID();
		const broken = (target: MoveTarget): MoveTarget => ({
			moveIn: (token, manifest) => target.moveIn(token, manifest),
			moveWrite: (token, page) => target.moveWrite(token, page),
			moveWriteKeys: (token, entries) => target.moveWriteKeys(token, entries),
			moveDigest: () => target.moveDigest(),
			moveStart: (place) => target.moveStart(place),
			moveCheck: async () => {
				throw new Error("The copy's row counts differ in trace_runs.");
			},
		});

		await expect(
			moveWorkspace(movingTo(workspaceId, moved, { target: broken }), { retryMs: 1 }),
		).rejects.toThrow("row counts differ");

		// Thawed: the registry takes writes and the conversation its socket and the next turn.
		await registry.createLibraryAsset({ kind: "instructions", name: "after", text: "Fine.\n" });
		expect((await messagesOf(stub)).body).toHaveLength(2);
		fakeModel(() => anthropicStream("Still here."));
		const socket = await connect(stub);
		expect(await ask(socket, "Are you there?")).toMatchObject({ text: "Still here." });
		socket.close();
		expect(conversationId).not.toBe("");
	});

	it("finishes a move that died after its commit, from the sealed registry", async () => {
		const { workspaceId, conversationId } = await workspaceWithTalk();
		const moved = crypto.randomUUID();
		let tries = 0;
		await expect(
			moveWorkspace(
				movingTo(workspaceId, moved, {
					record: async () => {
						tries++;
						throw new Error("D1 is unreachable");
					},
				}),
				{ retryMs: 1 },
			),
		).rejects.toThrow("D1 is unreachable");
		expect(tries).toBe(5);

		let recorded = false;
		const report = await moveWorkspace(
			movingTo(workspaceId, moved, {
				record: async () => {
					recorded = true;
				},
			}),
			{ retryMs: 1 },
		);
		expect(report).toMatchObject({ moved: true, finished: true });
		expect(recorded).toBe(true);
		const copy = await getAgentByName(env.CONVERSATIONS, conversationName(moved, conversationId));
		expect((await messagesOf(copy)).body).toHaveLength(2);
	});

	it("waits while a turn is under way", async () => {
		const { workspaceId, stub } = await workspaceWithTalk();
		// A model that never answers keeps the run going.
		fakeModel(
			() =>
				new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
		);
		const socket = await connect(stub);
		void ask(socket, "Take your time").catch(() => {});
		const registry = env.REGISTRY.getByName(workspaceId);
		await vi.waitFor(
			async () => {
				expect((await registry.listRuns())[0]?.status).toBe("running");
			},
			{ timeout: 5000 },
		);

		const report = await moveWorkspace(movingTo(workspaceId, crypto.randomUUID()), {
			retryMs: 1,
		});
		expect(report).toEqual({ moved: false, busy: 1 });
		// Nothing froze: the registry still takes writes.
		await registry.createLibraryAsset({ kind: "instructions", name: "meanwhile", text: "Ok.\n" });
		socket.close();
	});

	// A conversation copied early waits, idle, for the rest of the workspace, and may be evicted.
	it("keeps a conversation frozen through a restart", async () => {
		const { stub } = await workspaceWithTalk();
		const token = crypto.randomUUID();
		expect(await stub.moveOut(token, "eu")).toMatchObject({ frozen: true });

		await runInDurableObject(stub, (_instance: unknown, state) => state.abort("restart")).catch(
			() => {},
		);
		const fresh = env.CONVERSATIONS.get(stub.id);
		expect((await messagesOf(fresh)).status).toBe(503);
		const page = await fresh.moveRead(token, { table: 0, after: null });
		expect(page.tables.length).toBeGreaterThan(0);
		expect(await fresh.moveThaw(token)).toBe("thawed");
		expect((await messagesOf(fresh)).body).toHaveLength(2);
	});
});
