import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

// A query of D1 that failed for good, in the Worker as it deploys (AGT-133). A page whose read
// failed showed Drizzle's `Failed query: select … params: …` and had it in its HTML, and Better
// Auth logged the one for a session read, with the session's token among the values. A table that
// is gone makes every read of it fail, as the database being down would.

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

/** Runs `work` with a table out of reach, and puts it back. */
async function without<Result>(table: string, work: () => Promise<Result>): Promise<Result> {
	await agents.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
	try {
		return await work();
	} finally {
		await agents.db.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`);
	}
}

/** What the Worker logged about failed queries since `from`: a kind and a reference each. */
function failuresSince(from: number) {
	return agents.logs.slice(from).flatMap((log) => {
		const found = /d1: a query failed \((.+)\), reference ([0-9a-f]{8})/.exec(log.message);
		return found ? [{ kind: found[1], reference: found[2] }] : [];
	});
}

describe("a page whose read of the database failed", () => {
	it("shows no statement and no values, and a reference that is in the log", async () => {
		const { headers, userId } = await signUp(agents, origin, "failed-read");
		await createWorkspace(agents, origin, headers, "failed-read-space");
		const page = `${origin}/failed-read-space`;
		const loaded = await agents.fetch(page, { headers: { cookie: headers.cookie } });
		expect(loaded.status).toBe(200);

		const from = agents.logs.length;
		const html = await without("member", async () => {
			const response = await agents.fetch(page, { headers: { cookie: headers.cookie } });
			expect(response.status).toBe(500);
			return response.text();
		});

		expect(html).not.toContain("Failed query");
		expect(html).not.toContain("params");
		expect(html).not.toMatch(/select\b[^<]*\bfrom\b/i);
		expect(html).not.toContain("organization_id");
		// The membership is looked up by who is asking, so their id was among the values.
		expect(html).not.toContain(userId);

		expect(html).toContain("This page could not be loaded.");
		const failures = failuresSince(from);
		expect(failures.length).toBeGreaterThan(0);
		for (const { kind } of failures) {
			expect(kind).toBe("D1_ERROR, SQLITE_ERROR, no such table: member");
		}
		// The notice is where the page shows it. React marks where one piece of text meets the next.
		const shown = /<code>([0-9a-f]{8})<\/code>/.exec(html)?.[1];
		expect(shown).toBeDefined();
		expect(failures.map(({ reference }) => reference)).toContain(shown);
		const logged = agents.logs
			.slice(from)
			.map((log) => log.message)
			.join("\n");
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain(userId);
	});
});

describe("a session read that failed", () => {
	it("puts no token in the log or the page", async () => {
		const { headers } = await signUp(agents, origin, "failed-session");
		const signed = /session_token=([^;]+)/.exec(headers.cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const from = agents.logs.length;
		const html = await without("session", async () => {
			const response = await agents.fetch(`${origin}/`, { headers: { cookie: headers.cookie } });
			expect(response.status).toBe(500);
			return response.text();
		});

		const logged = agents.logs
			.slice(from)
			.map((log) => log.message)
			.join("\n");
		// Better Auth logs the failure it caught.
		expect(logged).toContain("[Better Auth]");
		expect(logged).not.toContain(token);
		expect(logged).not.toContain("Failed query");
		expect(logged).not.toContain("params");
		expect(html).not.toContain(token);
		expect(html).not.toContain("Failed query");
		expect(html).toContain("This page could not be loaded.");
		expect(failuresSince(from).map(({ kind }) => kind)).toContain(
			"D1_ERROR, SQLITE_ERROR, no such table: session",
		);
	});
});
