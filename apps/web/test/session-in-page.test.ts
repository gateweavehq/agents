import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUp } from "./accounts";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

describe("the page", () => {
	it("shows who is signed in, but not their session's token", async () => {
		const { headers } = await signUp(agents, origin, "page-token");
		const signed = /session_token=([^;]+)/.exec(headers.cookie)?.[1] ?? "";
		const token = decodeURIComponent(signed).split(".")[0] ?? "";
		expect(token.length).toBeGreaterThan(16);

		const response = await agents.fetch(`${origin}/`, { headers: { cookie: headers.cookie } });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("page-token@example.com");
		expect(html).not.toContain(token);
	});
});
