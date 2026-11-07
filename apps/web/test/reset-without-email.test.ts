import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgents } from "./agents-worker";

// A server with no email cannot send anyone a reset link, so docs/self-hosting.md tells whoever runs
// it how to make one. This runs what the guide says, against the public routes of the built Worker.

const origin = "https://agents.test";
const PASSWORD = "a-long-test-password";
const NEW_PASSWORD = "another-long-test-password";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin, { settings: { EMAIL_FROM: "" } });
});

afterAll(async () => {
	await agents?.dispose();
});

let clients = 0;

function post(path: string, body: object) {
	clients += 1;
	return agents.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {
			origin,
			"cf-connecting-ip": `198.51.100.${clients}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

/** The statement the guide gives, for this person and this token. */
function statementFor(email: string, token: string) {
	const guide = readFileSync(
		join(import.meta.dirname, "..", "..", "..", "docs", "self-hosting.md"),
		"utf8",
	);
	const statement = /"(INSERT INTO verification [^"]+)"/.exec(guide)?.[1];
	if (!statement) throw new Error("The guide has no such statement");
	return statement.replaceAll("$TOKEN", token).replace("someone@example.com", email);
}

async function sessionOf(cookie: string) {
	clients += 1;
	const response = await agents.fetch(`${origin}/api/auth/get-session`, {
		headers: { "cf-connecting-ip": `198.51.100.${clients}`, cookie },
	});
	return response.json();
}

describe("a server that sends no email", () => {
	it("lets whoever runs it help someone back in, as the guide says, once", async () => {
		const email = "locked-out@reset.test";
		const entered = await post("/sign-up/email", { name: "Ada", email, password: PASSWORD });
		expect(entered.status).toBe(200);
		const cookie = entered.headers
			.getSetCookie()
			.map((line) => line.split(";")[0] ?? "")
			.filter((line) => !line.endsWith("="))
			.join("; ");
		expect(await sessionOf(cookie)).toMatchObject({ user: { email } });

		// It says it cannot do this for them, so the guide is the only way.
		const page = await agents.fetch(`${origin}/forgot-password`);
		expect(await page.text()).toContain("does not send email");

		const token = "a-token-as-openssl-would-make-it";
		await agents.db.prepare(statementFor(email, token)).run();
		const opened = await agents.fetch(`${origin}/reset-password?token=${token}`);
		expect(opened.status).toBe(200);

		const chosen = await post("/reset-password", { token, newPassword: NEW_PASSWORD });
		expect(chosen.status).toBe(200);

		expect(await sessionOf(cookie)).toBeNull();
		expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(401);
		expect((await post("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);

		const again = await post("/reset-password", {
			token,
			newPassword: "yet-another-long-password",
		});
		expect(again.status).toBe(400);
		expect((await post("/sign-in/email", { email, password: NEW_PASSWORD })).status).toBe(200);
	});

	it("does not make a link for an address with no account", async () => {
		const token = "a-token-for-nobody";
		await agents.db.prepare(statementFor("nobody@reset.test", token)).run();
		expect((await post("/reset-password", { token, newPassword: NEW_PASSWORD })).status).toBe(400);
	});

	it("stops taking a link that has run out", async () => {
		const email = "too-late@reset.test";
		const entered = await post("/sign-up/email", { name: "Ada", email, password: PASSWORD });
		expect(entered.status).toBe(200);

		const token = "a-token-left-too-long";
		await agents.db.prepare(statementFor(email, token)).run();
		const row = await agents.db
			.prepare("SELECT expires_at AS expiresAt FROM verification WHERE identifier = ?")
			.bind(`reset-password:${token}`)
			.first<{ expiresAt: number }>();
		// An hour, as the guide says.
		expect(row?.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
		expect(row?.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);

		await agents.db
			.prepare("UPDATE verification SET expires_at = ? WHERE identifier = ?")
			.bind(Date.now() - 1000, `reset-password:${token}`)
			.run();
		expect((await post("/reset-password", { token, newPassword: NEW_PASSWORD })).status).toBe(400);
		expect((await post("/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
	});
});
