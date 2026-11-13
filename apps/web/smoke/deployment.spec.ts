import { expect, type Page, test } from "@playwright/test";

// What has to work on any deployment right after a deploy. These sign in to nothing and change
// nothing, so they can run against production. The demo's own flow is in demo.spec.ts.

/**
 * Collects what a visitor wouldn't see on the page but would suffer from: a script that throws,
 * a script the page's policy blocks, or a request to the deployment that fails.
 */
function watch(page: Page, origin: string): string[] {
	const problems: string[] = [];
	page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
	page.on("console", (message) => {
		if (message.text().includes("Content Security Policy")) {
			problems.push(`refused by the page's policy: ${message.text()}`);
		}
	});
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).origin === origin) {
			problems.push(`failed: ${request.url()} (${request.failure()?.errorText})`);
		}
	});
	page.on("response", (response) => {
		const url = new URL(response.url());
		if (url.origin !== origin) return;
		// Every file of the build must be there; anything else may refuse, but never fail.
		const broken = url.pathname.startsWith("/assets/")
			? response.status() >= 400
			: response.status() >= 500;
		if (broken) problems.push(`${response.status()}: ${url.pathname}`);
	});
	return problems;
}

test("the sign-in page loads and runs", async ({ page, baseURL }) => {
	const problems = watch(page, new URL(baseURL ?? "").origin);
	await page.goto("/login");
	await expect(
		page.getByRole("heading", { name: /^(Sign in to Gateweave Agents|Try Gateweave Agents)$/ }),
	).toBeVisible();
	// Its script has run once a button that needs it is enabled.
	await expect(page.getByRole("button").first()).toBeEnabled();
	expect(problems).toEqual([]);
});

test("accounts are looked up", async ({ request, baseURL }) => {
	// A sign-in for an account that can't exist reaches the database and the rate limiter, and
	// fails as it should. The demo refuses every sign-in over HTTP: its visitors' accounts are
	// the server's to make.
	const response = await request.post("/api/auth/sign-in/email", {
		headers: { origin: new URL(baseURL ?? "").origin },
		data: { email: `smoke-${Date.now()}@example.invalid`, password: "not-a-real-password" },
	});
	expect([401, 403]).toContain(response.status());
});

test("the chat gateway keeps conversations to their people", async ({ request }) => {
	// The page's own check before it opens a socket.
	const response = await request.head("/api/chat/smoke-check/smoke-check");
	expect(response.status()).toBe(401);
});

test("the MCP endpoint asks agents for a token", async ({ request }) => {
	const response = await request.post("/mcp", {
		data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		headers: { accept: "application/json, text/event-stream" },
	});
	// It is on only where the deployment's address is pinned (BETTER_AUTH_URL); elsewhere it isn't
	// there at all.
	if (response.status() === 404) return;
	expect(response.status()).toBe(401);
	expect(response.headers()["www-authenticate"]).toMatch(/^Bearer /);
});
