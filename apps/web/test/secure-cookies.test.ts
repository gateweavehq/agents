import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgents } from "./agents-worker";

// BETTER_AUTH_URL is optional, and without it Better Auth decides on `Secure` from NODE_ENV, which a
// Worker never has. A browser would then send the session cookie over plain HTTP, such as on the
// first request to a custom domain.

function signUp(agents: Awaited<ReturnType<typeof startAgents>>, origin: string) {
	return agents.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify({
			name: "Sam Secure",
			email: "sam@example.com",
			password: "a-long-test-password",
		}),
	});
}

describe("a deployment with no BETTER_AUTH_URL", () => {
	const origin = "https://agents.test";
	let agents: Awaited<ReturnType<typeof startAgents>>;

	beforeAll(async () => {
		agents = await startAgents(origin, { settings: { BETTER_AUTH_URL: "" } });
	});
	afterAll(() => agents.dispose());

	it("marks its cookies Secure and keeps their names, so nobody is signed out", async () => {
		const response = await signUp(agents, origin);
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(cookies.map((each) => each.split("=")[0])).toContain("better-auth.session_token");
		for (const cookie of cookies) expect(cookie).toMatch(/;\s*Secure/i);
	});
});

describe("a build pinned to localhost over plain HTTP", () => {
	const origin = "http://localhost:4721";
	let agents: Awaited<ReturnType<typeof startAgents>>;

	beforeAll(async () => {
		agents = await startAgents(origin);
	});
	afterAll(() => agents.dispose());

	it("leaves Secure off, as Better Auth does for a plain HTTP address", async () => {
		const response = await signUp(agents, origin);
		expect(response.status).toBe(200);
		const cookies = response.headers.getSetCookie();
		expect(cookies.map((each) => each.split("=")[0])).toContain("better-auth.session_token");
		for (const cookie of cookies) expect(cookie).not.toMatch(/;\s*Secure/i);
	});
});
