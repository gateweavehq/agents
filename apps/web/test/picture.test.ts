import { afterAll, beforeAll, expect, it } from "vitest";
import { startAgents } from "./agents-worker";

// A member's picture is fetched by the browser of everyone in their workspaces, so whoever chooses
// its address learns who is looking and from where. github-sign-in.test.ts has the picture that stays.

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

it("takes no picture from an email sign-up", async () => {
	const response = await agents.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers: { origin, "cf-connecting-ip": "203.0.113.70", "content-type": "application/json" },
		body: JSON.stringify({
			name: "Pia",
			email: "pia@picture.test",
			password: "a-long-test-password",
			image: "https://elsewhere.test/pixel.png",
		}),
	});
	expect(response.status).toBe(200);
	const row = await agents.db
		.prepare("SELECT image FROM user WHERE email = ?")
		.bind("pia@picture.test")
		.first<{ image: string | null }>();
	expect(row).toEqual({ image: null });
});
