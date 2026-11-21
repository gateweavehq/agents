import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";
const empty = { projects: 0, repositories: 0, agents: 0, assets: 0 };

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

async function notes(workspaceId: string): Promise<number> {
	const row = await agents.db
		.prepare("SELECT count(*) AS n FROM workspace_deletion WHERE workspace_id = ?")
		.bind(workspaceId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

it("deletes what a workspace held and keeps no note once it is done", async () => {
	const { headers } = await signUp(agents, origin, "dee");
	const id = await createWorkspace(agents, origin, headers, "gone-at-once");
	await (await agents.registry(id)).createProject({ name: "Gone", description: null });

	const response = await agents.fetch(`${origin}/api/auth/organization/delete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ organizationId: id }),
	});
	expect(response.status).toBe(200);
	expect(await (await agents.registry(id)).overview()).toEqual(empty);
	expect(await notes(id)).toBe(0);
});

it("finishes on the daily run a deletion whose request couldn't", async () => {
	const { headers } = await signUp(agents, origin, "hal");
	const id = await createWorkspace(agents, origin, headers, "half-gone");
	await (await agents.registry(id)).createProject({ name: "Left", description: null });
	// What a request that failed after its batch leaves: the row and its members gone, the note
	// there, and the registry with everything in it.
	await agents.db.batch([
		agents.db
			.prepare("INSERT INTO workspace_deletion (workspace_id, deleted_at) VALUES (?1, ?2)")
			.bind(id, Date.now()),
		agents.db.prepare("DELETE FROM organization WHERE id = ?1").bind(id),
	]);
	expect((await (await agents.registry(id)).overview()).projects).toBe(1);

	await agents.runScheduled();
	expect(await (await agents.registry(id)).overview()).toEqual(empty);
	expect(await notes(id)).toBe(0);
	expect(agents.logs.map((log) => log.message)).toContainEqual(
		expect.stringContaining(`deletion: workspace ${id} is deleted`),
	);
});

it("keeps the note its request wrote when the deletion can't finish, for the daily run", async () => {
	const { headers } = await signUp(agents, origin, "kit");
	const id = await createWorkspace(agents, origin, headers, "cut-short");
	await (await agents.registry(id)).createProject({ name: "Kept", description: null });
	// The deletion's last step refused, as one cut short would leave it.
	await agents.db
		.prepare(
			"CREATE TRIGGER keep_deletion_note BEFORE DELETE ON workspace_deletion BEGIN SELECT RAISE(ABORT, 'kept'); END",
		)
		.run();
	try {
		const response = await agents.fetch(`${origin}/api/auth/organization/delete`, {
			method: "POST",
			headers,
			body: JSON.stringify({ organizationId: id }),
		});
		expect(response.status).toBe(200);
		expect(await notes(id)).toBe(1);
	} finally {
		await agents.db.prepare("DROP TRIGGER keep_deletion_note").run();
	}

	await agents.runScheduled();
	expect(await notes(id)).toBe(0);
	expect(await (await agents.registry(id)).overview()).toEqual(empty);
});
