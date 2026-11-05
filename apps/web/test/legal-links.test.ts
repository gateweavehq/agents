import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

// The legal notice has to be easy to reach, and they are one deployment's own: a copy someone else
// runs must show none unless it sets its own. These read the HTML the server sends.

const origin = "https://agents.test";
const SIGN_IN_PAGES = ["/login", "/forgot-password", "/reset-password", "/invite/none"];

type Agents = Awaited<ReturnType<typeof startAgents>>;

async function page(agents: Agents, path: string, headers: Record<string, string> = {}) {
	const response = await agents.fetch(`${origin}${path}`, { headers });
	expect(response.status).toBe(200);
	return response.text();
}

function expectLinks(html: string) {
	for (const [words, address] of [
		["Legal notice", "https://legal.test/notice?from=agents&amp;lang=en"],
		["Privacy", "https://legal.test/privacy"],
		["Terms", "https://legal.test/terms"],
	]) {
		const link = [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].find(
			([, attributes, text]) => text === words && attributes?.includes(`href="${address}"`),
		);
		expect(link?.[1], words).toContain('rel="noreferrer"');
	}
}

describe("a deployment that sets its legal pages", () => {
	let agents: Agents;

	beforeAll(async () => {
		agents = await startAgents(origin, {
			settings: {
				LEGAL_NOTICE_URL: "https://legal.test/notice?from=agents&lang=en",
				PRIVACY_POLICY_URL: "https://legal.test/privacy",
				TERMS_URL: "https://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	it.each(SIGN_IN_PAGES)("links them from %s, passing on no address", async (path) => {
		expectLinks(await page(agents, path));
	});

	it("says at sign-in that continuing means agreeing to the terms", async () => {
		expect(await page(agents, "/login")).toContain("By continuing, you agree to the");
		expect(await page(agents, "/forgot-password")).not.toContain("By continuing");
	});

	it("links them from the workspace list, and gives them to the workspace menu", async () => {
		const { headers } = await signUp(agents, origin, "legal-links");
		await createWorkspace(agents, origin, headers, "legal-links");
		const { cookie } = headers;
		expectLinks(await page(agents, "/", { cookie }));
		// The menu opens only in the browser, but what it shows comes with the page.
		const inside = await page(agents, "/legal-links", { cookie });
		expect(inside).toContain("https://legal.test/terms");
		expect(inside).toContain("https://legal.test/privacy");
	});
});

describe("a deployment that sets none", () => {
	let agents: Agents;

	beforeAll(async () => {
		agents = await startAgents(origin);
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	it.each(SIGN_IN_PAGES)("shows nothing of the kind on %s", async (path) => {
		const html = await page(agents, path);
		expect(html).not.toContain("Legal notice");
		expect(html).not.toContain("By continuing");
		expect(html).not.toContain('aria-label="Legal"');
		expect(html).not.toContain("gateweave.com");
	});
});

describe("settings that are not addresses people can open", () => {
	let agents: Agents;

	beforeAll(async () => {
		agents = await startAgents(origin, {
			settings: {
				LEGAL_NOTICE_URL: "javascript:alert(1)",
				PRIVACY_POLICY_URL: "not an address",
				TERMS_URL: "http://legal.test/terms",
			},
		});
	});

	afterAll(async () => {
		await agents?.dispose();
	});

	it("leaves them out, and keeps the one that is", async () => {
		const html = await page(agents, "/login");
		expect(html).not.toContain("javascript:alert");
		expect(html).not.toContain("not an address");
		expect(html).not.toMatch(/>Legal notice</);
		expect(html).not.toMatch(/>Privacy</);
		expect(html).toMatch(/<a [^>]*href="http:\/\/legal\.test\/terms"[^>]*>Terms<\/a>/);
	});
});
