import { afterAll, beforeAll, expect, it } from "vitest";
import { startAgents } from "./agents-worker";

const origin = "https://agents.test";

let agents: Awaited<ReturnType<typeof startAgents>>;
let clients = 0;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

/** Signs up a new person, from an address of their own so sign-up limits stay out of the way. */
async function signUp(name: string) {
	const headers = {
		"content-type": "application/json",
		origin,
		"cf-connecting-ip": `203.0.113.${++clients}`,
	};
	const response = await agents.fetch(`${origin}/api/auth/sign-up/email`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name, email: `${name}@example.com`, password: "a-long-password" }),
	});
	expect(response.status).toBe(200);
	const cookie = response.headers
		.getSetCookie()
		.map((header) => header.split(";")[0])
		.join("; ");
	return { ...headers, cookie };
}

async function createWorkspace(headers: Record<string, string>, slug: string) {
	const response = await agents.fetch(`${origin}/api/auth/organization/create`, {
		method: "POST",
		headers,
		body: JSON.stringify({ name: slug, slug }),
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}

/** A count on the Overview page, as rendered on the server. */
function count(html: string, label: string) {
	return html.match(new RegExp(`${label}</dt><dd[^>]*>(\\d+)<`))?.[1];
}

it("shows members what their workspace's registry holds", async () => {
	const ada = await signUp("ada");
	const id = await createWorkspace(ada, "acme");
	await (await agents.registry(id)).createProject({ name: "Checkout", description: null });

	const page = await agents.fetch(`${origin}/acme`, { headers: { cookie: ada.cookie } });
	expect(page.status).toBe(200);
	const html = await page.text();
	expect(count(html, "Projects")).toBe("1");
	expect(count(html, "Repositories")).toBe("0");
});

it("shows anyone else nothing of it", async () => {
	const grace = await signUp("grace");
	const id = await createWorkspace(grace, "lab");
	await (await agents.registry(id)).createProject({ name: "Hidden", description: null });

	const eve = await signUp("eve");
	const html = await (
		await agents.fetch(`${origin}/lab`, { headers: { cookie: eve.cookie } })
	).text();
	expect(html).toContain("Workspace not found");
	expect(html).not.toContain("Hidden");
	expect(count(html, "Projects")).toBeUndefined();
});

it("deletes the registry with its workspace", async () => {
	const linus = await signUp("linus");
	const id = await createWorkspace(linus, "doomed");
	await (await agents.registry(id)).createProject({ name: "Doomed", description: null });

	const response = await agents.fetch(`${origin}/api/auth/organization/delete`, {
		method: "POST",
		headers: linus,
		body: JSON.stringify({ organizationId: id }),
	});
	expect(response.status).toBe(200);
	expect(await (await agents.registry(id)).overview()).toEqual({
		projects: 0,
		repositories: 0,
		agents: 0,
		assets: 0,
	});
	expect(agents.logs.filter((log) => log.level === "error")).toEqual([]);
});
