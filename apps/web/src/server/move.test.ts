import { beforeEach, expect, it, vi } from "vitest";
import { type Database, schema } from "./db";
import { forgetMovedCopies, moveWorkspaces } from "./move";
import { RegistryDO } from "./registry-do";
import { deleteWorkspaceData } from "./workspace-deletion";

const deps = vi.hoisted(() => ({
	env: { REGISTRY: {}, CONVERSATIONS: {}, SANDBOX_METER: undefined },
	select: vi.fn(),
	target: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: deps.env }));
vi.mock("./auth", () => ({ db: { select: deps.select } }));
vi.mock("./jurisdiction", () => ({ deploymentJurisdiction: deps.target }));
vi.mock("./audit", () => ({}));
vi.mock("./demo/fill", () => ({}));
vi.mock("./demo/mode", () => ({}));
vi.mock("./email", () => ({}));
vi.mock("./email/templates", () => ({}));
vi.mock("@gateweave/agents-registry", () => ({
	METER_NAME: "meter",
	objectsIn: (binding: Record<string, unknown>, place?: string) => binding[place ?? ""],
	RegistryDO: class {
		ctx = { id: { name: "workspace", jurisdiction: "eu" } };
		env = deps.env;
		movedFrom() {
			return "";
		}
	},
}));
vi.mock("agents", () => ({
	getAgentByName: (namespace: { getByName(name: string): unknown }, name: string) =>
		namespace.getByName(name),
}));
vi.mock("@gateweave/agents-runtime", () => ({
	conversationName: (workspace: string, id: string) => `${workspace}:${id}`,
	destroyConversationObject: (conversation: { destroy(): Promise<void> }) => conversation.destroy(),
}));

const location = {
	workspaceId: "workspace",
	jurisdiction: "eu",
	movedFrom: "",
	movedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
};

function query(row: typeof location | undefined) {
	const statement = {
		from: () => statement,
		leftJoin: () => statement,
		where: () => statement,
		orderBy: () => statement,
		limit: () => statement,
		get: async () => row,
		all: async () => (row ? [row] : []),
		run: vi.fn(),
	};
	deps.select.mockReturnValue(statement);
	const deleted: unknown[] = [];
	const db = {
		select: deps.select,
		update: () => ({ set: () => statement }),
		delete: (table: unknown) => {
			deleted.push(table);
			return statement;
		},
		batch: vi.fn(),
	};
	return { db: db as unknown as Database, statement, batch: db.batch, deleted };
}

function place(name: string, registry: object, conversations: Record<string, object>) {
	const registryNamespace = { getByName: vi.fn().mockReturnValue(registry) };
	const conversationNamespace = {
		getByName: vi.fn((id: string) => conversations[id]),
	};
	Object.assign(deps.env.REGISTRY, { [name]: registryNamespace });
	Object.assign(deps.env.CONVERSATIONS, { [name]: conversationNamespace });
	return { registry: registryNamespace.getByName, conversation: conversationNamespace.getByName };
}

class DeletingRegistry extends RegistryDO {
	override destroyConversation(id: string) {
		return super.destroyConversation(id);
	}
}

beforeEach(() => {
	vi.resetAllMocks();
	deps.target.mockReturnValue(null);
	deps.env.REGISTRY = {};
	deps.env.CONVERSATIONS = {};
});

it("resumes a large copy across runs without calling a forgotten conversation again", async () => {
	const { db, statement } = query(location);
	const pending = new Set(["one", "two", "three", "four", "five"]);
	const registry = {
		moveConversationsToForget: async () => [...pending],
		moveNoteForgotten: async (ids: string[]) => {
			for (const id of ids) pending.delete(id);
		},
		moveForget: vi.fn(async () => {
			expect(pending.size).toBe(0);
		}),
	};
	const conversations = Object.fromEntries(
		[...pending].map((id) => [
			`workspace:${id}`,
			{ moveForget: vi.fn().mockResolvedValue("forgotten") },
		]),
	);
	place("", registry, conversations);
	for (const remaining of [3, 1]) {
		await forgetMovedCopies(db, 2);
		expect(pending.size).toBe(remaining);
		expect(statement.run).not.toHaveBeenCalled();
	}
	await forgetMovedCopies(db, 2);
	expect(registry.moveForget).toHaveBeenCalledOnce();
	expect(statement.run).toHaveBeenCalledOnce();
	for (const conversation of Object.values(conversations)) {
		expect(conversation.moveForget).toHaveBeenCalledOnce();
	}
});

it("forgets due copies before it queries for new moves", async () => {
	const { db, statement } = query(location);
	deps.select.mockReset();
	deps.select.mockReturnValueOnce(statement).mockImplementationOnce(() => {
		expect(statement.run).toHaveBeenCalledOnce();
		statement.all = async () => [];
		return statement;
	});
	deps.target.mockReturnValue("eu");
	place("", { moveConversationsToForget: async () => [], moveForget: async () => "forgotten" }, {});
	await moveWorkspaces(db);
	expect(deps.select).toHaveBeenCalledTimes(2);
});

it.each(["forgotten", "empty"])(
	"completes deletion of a listed old conversation after %s",
	async (result) => {
		query(location);
		const destroy = vi.fn();
		const moveForget = vi.fn().mockResolvedValue(result);
		const moveNoteForgotten = vi.fn();
		place("eu", {}, { "workspace:one": { destroy } });
		place(
			"",
			{ moveConversationsToForget: async () => ["one"], moveNoteForgotten },
			{
				"workspace:one": { moveForget },
			},
		);
		await new DeletingRegistry({} as DurableObjectState, {} as Cloudflare.Env).destroyConversation(
			"one",
		);
		expect(destroy).toHaveBeenCalledOnce();
		expect(moveForget).toHaveBeenCalledOnce();
		expect(moveNoteForgotten).toHaveBeenCalledExactlyOnceWith(["one"]);
	},
);

it("leaves the old place's conversation untouched when the conversation started after the move", async () => {
	query(location);
	const destroy = vi.fn();
	place("eu", {}, { "workspace:new": { destroy } });
	const old = place("", { moveConversationsToForget: async () => ["one"] }, {});
	await new DeletingRegistry({} as DurableObjectState, {} as Cloudflare.Env).destroyConversation(
		"new",
	);
	expect(destroy).toHaveBeenCalledOnce();
	expect(old.conversation).not.toHaveBeenCalled();
});

it("deletes both workspace copies and forgets the sealed conversation through its own RPC", async () => {
	const { db, batch } = query(location);
	const liveRegistry = { conversationIds: async () => ["one"], destroy: vi.fn() };
	const oldRegistry = { conversationIds: async () => ["one"], destroy: vi.fn() };
	const destroy = vi.fn();
	const moveForget = vi.fn();
	place("eu", liveRegistry, { "workspace:one": { destroy } });
	place("", oldRegistry, { "workspace:one": { moveForget } });
	await deleteWorkspaceData(db, "workspace");
	expect(destroy).toHaveBeenCalledOnce();
	expect(moveForget).toHaveBeenCalledOnce();
	expect(liveRegistry.destroy).toHaveBeenCalledOnce();
	expect(oldRegistry.destroy).toHaveBeenCalledOnce();
	// Its location row and its deletion note, together.
	expect(batch).toHaveBeenCalledOnce();
});

it.each(["conversationIds", "destroy"] as const)(
	"cleans the sealed copy before rejecting when the live registry's %s fails",
	async (rpc) => {
		const { db, statement, batch, deleted } = query(location);
		const failure = new Error("registry unreachable");
		const events: string[] = [];
		const liveRegistry = {
			conversationIds: vi.fn().mockResolvedValue(["one"]),
			destroy: vi.fn().mockResolvedValue(undefined),
		};
		liveRegistry[rpc].mockImplementation(async () => {
			await Promise.resolve();
			events.push("live registry rejected");
			throw failure;
		});
		const oldRegistry = {
			conversationIds: async () => {
				events.push("sealed registry listed");
				return ["one"];
			},
			destroy: async () => {
				events.push("sealed registry destroy started");
				await Promise.resolve();
				events.push("sealed registry destroyed");
			},
		};
		const moveForget = async () => {
			await Promise.resolve();
			events.push("sealed conversation forgotten");
		};
		place("eu", liveRegistry, { "workspace:one": { destroy: vi.fn() } });
		place("", oldRegistry, { "workspace:one": { moveForget } });

		const deletion = deleteWorkspaceData(db, "workspace").catch((error) => {
			events.push("deletion rejected");
			throw error;
		});
		await expect(deletion).rejects.toBe(failure);
		expect(events).toEqual([
			"live registry rejected",
			"sealed registry listed",
			"sealed conversation forgotten",
			"sealed registry destroy started",
			"sealed registry destroyed",
			"deletion rejected",
		]);
		expect(deleted).toEqual([]);
		expect(statement.run).not.toHaveBeenCalled();
		expect(batch).not.toHaveBeenCalled();
	},
);

it("keeps a refused old copy's registry and location row for the daily run to retry", async () => {
	const { db, statement, batch } = query(location);
	const liveRegistry = { conversationIds: async () => ["one"], destroy: vi.fn() };
	const oldRegistry = { conversationIds: async () => ["one"], destroy: vi.fn() };
	const destroy = vi.fn();
	const moveForget = vi
		.fn()
		.mockRejectedValue(new Error("Only a sealed object can forget a moved copy."));
	place("eu", liveRegistry, { "workspace:one": { destroy } });
	place("", oldRegistry, { "workspace:one": { moveForget } });
	await expect(deleteWorkspaceData(db, "workspace")).rejects.toThrow(
		"1 of the workspace's conversations are left for the next try",
	);
	expect(moveForget).toHaveBeenCalledTimes(3);
	expect(destroy).toHaveBeenCalledOnce();
	expect(liveRegistry.destroy).toHaveBeenCalledOnce();
	expect(oldRegistry.destroy).not.toHaveBeenCalled();
	expect(statement.run).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});

it("keeps the registry of a conversation that could not be deleted, for the next try", async () => {
	const { db, statement, batch } = query(location);
	const liveRegistry = { conversationIds: async () => ["one", "two"], destroy: vi.fn() };
	const oldRegistry = { conversationIds: async () => [], destroy: vi.fn() };
	const deleted = vi.fn();
	const failed = vi.fn().mockRejectedValue(new Error("unreachable"));
	place("eu", liveRegistry, {
		"workspace:one": { destroy: deleted },
		"workspace:two": { destroy: failed },
	});
	place("", oldRegistry, {});
	await expect(deleteWorkspaceData(db, "workspace")).rejects.toThrow(
		"1 of the workspace's conversations are left for the next try",
	);
	expect(deleted).toHaveBeenCalledOnce();
	expect(liveRegistry.destroy).not.toHaveBeenCalled();
	// The other place is still emptied.
	expect(oldRegistry.destroy).toHaveBeenCalledOnce();
	expect(statement.run).not.toHaveBeenCalled();
	expect(batch).not.toHaveBeenCalled();
});

it("finishes the deletion when a refused old copy forget answers on a retry", async () => {
	const { db, batch } = query(location);
	const liveRegistry = { conversationIds: async () => ["one"], destroy: vi.fn() };
	const oldRegistry = { conversationIds: async () => ["one"], destroy: vi.fn() };
	const destroy = vi.fn();
	const moveForget = vi
		.fn()
		.mockRejectedValueOnce(new Error("Only a sealed object can forget a moved copy."))
		.mockResolvedValue("forgotten");
	place("eu", liveRegistry, { "workspace:one": { destroy } });
	place("", oldRegistry, { "workspace:one": { moveForget } });
	await deleteWorkspaceData(db, "workspace");
	expect(moveForget).toHaveBeenCalledTimes(2);
	expect(oldRegistry.destroy).toHaveBeenCalledOnce();
	expect(batch).toHaveBeenCalledOnce();
});

it("deletes the default place and the deployment's when the workspace has no location row", async () => {
	const { db, batch, deleted } = query(undefined);
	deps.target.mockReturnValue("eu");
	const destroy = vi.fn();
	// What a first move that gave up left behind, which no row records.
	const halfFilled = vi.fn();
	const leftBehind = vi.fn();
	place("", { conversationIds: async () => [], destroy }, {});
	place(
		"eu",
		{ conversationIds: async () => ["one"], destroy: halfFilled },
		{ "workspace:one": { destroy: leftBehind } },
	);
	await deleteWorkspaceData(db, "workspace");
	expect(destroy).toHaveBeenCalledOnce();
	expect(leftBehind).toHaveBeenCalledOnce();
	expect(halfFilled).toHaveBeenCalledOnce();
	// Only its deletion note: there is no location row to delete.
	expect(deleted).toEqual([schema.workspaceDeletion]);
	expect(batch).not.toHaveBeenCalled();
});
