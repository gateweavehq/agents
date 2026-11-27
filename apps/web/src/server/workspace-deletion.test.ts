import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb, type Database, schema } from "./db";
import {
	deleteWorkspaceWithData,
	finishWorkspaceDeletion,
	retryWorkspaceDeletions,
} from "./workspace-deletion";

// Real D1 queries, with stand-ins for the objects: local workerd has no jurisdictions, and these
// tests are about what fails and what is tried again.
const world = vi.hoisted(() => {
	/** Each place's registries, by workspace: the conversations each lists, until it is destroyed. */
	const registries = new Map<string, Map<string, string[]>>();
	/** Conversations whose destroy or forget fails, as `place/name`. */
	const failing = new Set<string>();
	/** Conversation objects a deletion finished, as the registry records them, by `place/workspace`. */
	const forgotten = new Map<string, Set<string>>();
	const deleted: string[] = [];
	/** Runs inside a registry's destroy, to change D1 while a deletion is under way. */
	const meanwhile = { onDestroy: async (_place: string, _workspaceId: string) => {} };
	function placeOf(place: string) {
		let workspaces = registries.get(place);
		if (!workspaces) {
			workspaces = new Map();
			registries.set(place, workspaces);
		}
		return workspaces;
	}
	function forgottenIn(place: string, workspaceId: string) {
		const key = `${place}/${workspaceId}`;
		let ids = forgotten.get(key);
		if (!ids) {
			ids = new Set();
			forgotten.set(key, ids);
		}
		return ids;
	}
	function conversation(place: string, name: string) {
		const act = async () => {
			if (failing.has(`${place}/${name}`)) throw new Error("unreachable");
			deleted.push(`${place}/${name}`);
			return "forgotten";
		};
		return { destroy: act, moveForget: act };
	}
	const env = {
		REGISTRY: {
			place: (place: string) => ({
				getByName: (workspaceId: string) => ({
					conversationIds: async () => placeOf(place).get(workspaceId) ?? [],
					conversationsToDestroy: async () =>
						(placeOf(place).get(workspaceId) ?? []).filter(
							(id) => !forgottenIn(place, workspaceId).has(id),
						),
					noteConversationsDestroyed: async (ids: string[]) => {
						for (const id of ids) forgottenIn(place, workspaceId).add(id);
					},
					destroy: async () => {
						await meanwhile.onDestroy(place, workspaceId);
						placeOf(place).delete(workspaceId);
						forgotten.delete(`${place}/${workspaceId}`);
						deleted.push(`${place}/registry`);
					},
				}),
			}),
		},
		CONVERSATIONS: {
			place: (place: string) => ({ getByName: (name: string) => conversation(place, name) }),
		},
	};
	return { registries, failing, forgotten, deleted, meanwhile, placeOf, env, target: vi.fn() };
});

vi.mock("cloudflare:workers", () => ({ env: world.env }));
vi.mock("./jurisdiction", () => ({ deploymentJurisdiction: world.target }));
vi.mock("@gateweave/agents-registry", () => ({
	objectsIn: (binding: { place(place: string): unknown }, place?: string | null) =>
		binding.place(place ?? ""),
}));
vi.mock("agents", () => ({
	getAgentByName: async (namespace: { getByName(name: string): unknown }, name: string) =>
		namespace.getByName(name),
}));
vi.mock("@gateweave/agents-runtime", () => ({
	conversationName: (workspaceId: string, id: string) => `${workspaceId}:${id}`,
	destroyConversationObject: (conversation: { destroy(): Promise<void> }) => conversation.destroy(),
}));

const { workspaceDeletion, workspaceLocation, organization } = schema;
let mf: Miniflare;
let db: Database;

beforeAll(async () => {
	mf = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch: () => new Response() };",
			d1Databases: { DB: "workspace-deletion-test" },
		}),
	);
	const d1 = await mf.getD1Database("DB");
	const migrations = resolve(import.meta.dirname, "../../migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	db = createDb(d1 as unknown as D1Database);
});

afterAll(async () => {
	await mf?.dispose();
});

beforeEach(async () => {
	vi.clearAllMocks();
	world.target.mockReturnValue(null);
	world.registries.clear();
	world.failing.clear();
	world.forgotten.clear();
	world.deleted.length = 0;
	world.meanwhile.onDestroy = async () => {};
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
	await db.delete(workspaceDeletion).run();
	await db.delete(workspaceLocation).run();
	await db.delete(organization).run();
});

const note = (workspaceId: string) =>
	db.select().from(workspaceDeletion).where(eq(workspaceDeletion.workspaceId, workspaceId)).get();
const location = (workspaceId: string) =>
	db.select().from(workspaceLocation).where(eq(workspaceLocation.workspaceId, workspaceId)).get();

async function noted(workspaceId: string, deletedAt = 1, lastTriedAt: number | null = null) {
	await db.insert(workspaceDeletion).values({ workspaceId, deletedAt, lastTriedAt }).run();
}

async function workspace(id: string) {
	await db
		.insert(organization)
		.values({ id, name: id, slug: id, createdAt: new Date(0) })
		.run();
}

async function placed(workspaceId: string, jurisdiction: string, movedFrom: string | null = null) {
	await db
		.insert(workspaceLocation)
		.values({ workspaceId, jurisdiction, movedFrom, movedAt: movedFrom === null ? null : 1 })
		.run();
}

it("keeps a registry whose conversation failed, and finishes it on the next daily run", async () => {
	await placed("doomed", "eu");
	await noted("doomed");
	world.placeOf("eu").set("doomed", ["one", "two"]);
	world.failing.add("eu/doomed:two");

	await expect(finishWorkspaceDeletion(db, "doomed")).rejects.toThrow(
		"1 of the workspace's conversations are left for the next try",
	);
	expect(world.deleted).toEqual(["eu/doomed:one"]);
	expect(world.placeOf("eu").get("doomed")).toEqual(["one", "two"]);
	expect(await location("doomed")).toBeDefined();
	expect((await note("doomed"))?.lastTriedAt).toEqual(expect.any(Number));

	world.failing.clear();
	await retryWorkspaceDeletions(db);
	expect(world.deleted).toContain("eu/doomed:two");
	expect(world.deleted.at(-1)).toBe("eu/registry");
	expect(world.placeOf("eu").has("doomed")).toBe(false);
	expect(await location("doomed")).toBeUndefined();
	expect(await note("doomed")).toBeUndefined();
});

it("keeps an old copy that refuses to be forgotten, with its row and note", async () => {
	await placed("moved", "eu", "");
	await noted("moved");
	world.placeOf("eu").set("moved", ["one"]);
	world.placeOf("").set("moved", ["one"]);
	world.failing.add("/moved:one");

	await expect(finishWorkspaceDeletion(db, "moved")).rejects.toThrow("1 of the workspace's");
	expect(world.deleted).toEqual(["eu/moved:one", "eu/registry"]);
	expect(world.placeOf("").has("moved")).toBe(true);
	expect(await location("moved")).toBeDefined();
	expect(await note("moved")).toBeDefined();

	world.failing.clear();
	await retryWorkspaceDeletions(db);
	expect(world.deleted.slice(2)).toEqual(["eu/registry", "/moved:one", "/registry"]);
	expect(await location("moved")).toBeUndefined();
	expect(await note("moved")).toBeUndefined();
});

it("notes a location row whose workspace is gone and deletes its objects, and leaves a live one's", async () => {
	await placed("orphan", "eu");
	await placed("live", "eu");
	await workspace("live");
	world.placeOf("eu").set("orphan", ["one"]);
	world.placeOf("eu").set("live", ["two"]);

	await retryWorkspaceDeletions(db);
	expect(world.deleted).toEqual(["eu/orphan:one", "eu/registry"]);
	expect(await location("orphan")).toBeUndefined();
	expect(await note("orphan")).toBeUndefined();
	expect(await location("live")).toBeDefined();
	expect(await note("live")).toBeUndefined();
	expect(world.placeOf("eu").get("live")).toEqual(["two"]);
});

it("never deletes a workspace that is still there, and drops its note", async () => {
	await workspace("live");
	await placed("live", "eu");
	await noted("live");
	world.placeOf("eu").set("live", ["one"]);

	await expect(finishWorkspaceDeletion(db, "live")).rejects.toThrow("still there");
	await noted("live");
	await retryWorkspaceDeletions(db);
	expect(world.deleted).toEqual([]);
	expect(await note("live")).toBeUndefined();
	expect(await location("live")).toBeDefined();
});

it("keeps the note when a move records a new place during the deletion, and deletes there next", async () => {
	// One read no row, one read its old place: a move recorded where it went meanwhile.
	await noted("racing");
	await placed("racing-on", "eu");
	await noted("racing-on");
	world.placeOf("").set("racing", ["one"]);
	world.placeOf("eu").set("racing-on", ["two"]);
	world.meanwhile.onDestroy = async (place, workspaceId) => {
		if (workspaceId === "racing" && place === "") {
			await db
				.insert(workspaceLocation)
				.values({ workspaceId, jurisdiction: "eu", movedFrom: "", movedAt: 2 })
				.run();
		}
		if (workspaceId === "racing-on" && place === "eu") {
			await db
				.update(workspaceLocation)
				.set({ jurisdiction: "fr", movedFrom: "eu", movedAt: 2 })
				.where(eq(workspaceLocation.workspaceId, workspaceId))
				.run();
		}
	};
	world.placeOf("eu").set("racing", ["one"]);
	world.placeOf("fr").set("racing-on", ["two"]);

	await finishWorkspaceDeletion(db, "racing");
	await finishWorkspaceDeletion(db, "racing-on");
	expect(await note("racing")).toBeDefined();
	expect(await note("racing-on")).toBeDefined();
	expect(world.placeOf("eu").has("racing")).toBe(true);
	expect(world.placeOf("fr").has("racing-on")).toBe(true);

	world.meanwhile.onDestroy = async () => {};
	await retryWorkspaceDeletions(db);
	for (const id of ["racing", "racing-on"]) {
		expect(await note(id)).toBeUndefined();
		expect(await location(id)).toBeUndefined();
	}
	expect(world.placeOf("eu").has("racing")).toBe(false);
	expect(world.placeOf("fr").has("racing-on")).toBe(false);
});

it("finishes two a run, those never tried first", async () => {
	await noted("tried", 1, 5);
	await noted("first", 2);
	await noted("second", 3);

	await retryWorkspaceDeletions(db);
	expect(await note("first")).toBeUndefined();
	expect(await note("second")).toBeUndefined();
	expect(await note("tried")).toBeDefined();
});

it("makes bounded progress through a large workspace over several daily runs", async () => {
	await placed("big", "eu");
	await noted("big");
	world.placeOf("eu").set(
		"big",
		Array.from({ length: 205 }, (_, index) => `conversation-${index}`),
	);

	await retryWorkspaceDeletions(db);
	expect(world.deleted.filter((name) => name.startsWith("eu/big:"))).toHaveLength(200);
	expect(world.deleted).not.toContain("eu/registry");
	expect(world.placeOf("eu").has("big")).toBe(true);
	expect(await note("big")).toBeDefined();

	await retryWorkspaceDeletions(db);
	expect(world.deleted.filter((name) => name.startsWith("eu/big:"))).toHaveLength(205);
	expect(world.deleted.at(-1)).toBe("eu/registry");
	expect(world.placeOf("eu").has("big")).toBe(false);
	expect(await note("big")).toBeUndefined();
	expect(await location("big")).toBeUndefined();
});

it("deletes a workspace the app deletes itself even when its objects fail, and leaves them a note", async () => {
	await workspace("visitor");
	await placed("visitor", "eu");
	world.placeOf("eu").set("visitor", ["one"]);
	world.failing.add("eu/visitor:one");

	await deleteWorkspaceWithData(db, "visitor");
	expect(
		await db.select().from(organization).where(eq(organization.id, "visitor")).get(),
	).toBeUndefined();
	expect((await note("visitor"))?.lastTriedAt).toEqual(expect.any(Number));
	expect(world.placeOf("eu").get("visitor")).toEqual(["one"]);

	world.failing.clear();
	await retryWorkspaceDeletions(db);
	expect(await note("visitor")).toBeUndefined();
	expect(await location("visitor")).toBeUndefined();
	expect(world.placeOf("eu").has("visitor")).toBe(false);
});

it("deletes the deployment's place too when the workspace has no location row", async () => {
	world.target.mockReturnValue("eu");
	await noted("unplaced");
	world.placeOf("").set("unplaced", ["one"]);
	// A first move that gave up, which no row records.
	world.placeOf("eu").set("unplaced", ["one"]);

	await finishWorkspaceDeletion(db, "unplaced");
	expect(world.deleted).toEqual(
		expect.arrayContaining(["/unplaced:one", "/registry", "eu/unplaced:one", "eu/registry"]),
	);
	expect(await note("unplaced")).toBeUndefined();
});
