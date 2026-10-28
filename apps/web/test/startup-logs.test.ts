import { afterAll, beforeAll, expect, it } from "vitest";
import { startAgents } from "./agents-worker";

// workerd forbids I/O in global scope. Better Auth starts resolving its context as soon as it is
// created, so building it at module load can log an error on every cold start that hides real
// ones. The app builds it on first use instead.

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

it("starts and serves requests without logging an error", async () => {
	await agents.fetch(`${origin}/login`);
	const session = await agents.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
	expect(session.status).toBe(200);

	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});
