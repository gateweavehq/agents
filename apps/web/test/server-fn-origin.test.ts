import { afterAll, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { serverFnRequest } from "./server-fn";

// A server function answers only the app's own pages. The framework guards that by default, but
// an app that exports a start instance (`src/start.ts`) replaces the default, so the guard is
// listed there, and these fail when it is not: another site's page could then act as whoever is
// signed in, wherever the browser sends their cookie.

const origin = "https://agents.test";
const elsewhere = "https://elsewhere.example";

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

/** An owner and their workspace, which has no project yet. */
async function workspace(slug: string) {
	const owner = await signUp(agents, origin, `ada-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	return { owner, slug, registry: await agents.registry(workspaceId) };
}

/**
 * Asks to create a project as the owner, whose cookie the request carries, with only the headers
 * given to say where it comes from.
 */
async function createProject(
	{ owner, slug }: Awaited<ReturnType<typeof workspace>>,
	name: string,
	from: Record<string, string>,
) {
	const response = await agents.fetch(
		serverFnRequest(origin, "createProject", {
			data: { slug, project: { name, description: "" } },
			headers: {
				cookie: owner.headers.cookie,
				"cf-connecting-ip": owner.headers["cf-connecting-ip"],
				...from,
			},
		}),
	);
	return { status: response.status, text: await response.text() };
}

it("refuses a server function called from another site", async () => {
	const forge = await workspace("origin-forge");

	const call = await createProject(forge, "Forged", {
		"sec-fetch-site": "cross-site",
		origin: elsewhere,
	});
	expect(call.status).toBe(403);
	expect(call.text).toBe("Forbidden");
	// A subdomain of the same site is another origin too.
	expect((await createProject(forge, "Forged", { "sec-fetch-site": "same-site" })).status).toBe(
		403,
	);
	// What the browser says wins over an `Origin` that agrees with the app.
	expect(
		(await createProject(forge, "Forged", { "sec-fetch-site": "cross-site", origin })).status,
	).toBe(403);

	// The handler never ran: the owner's workspace has no project.
	expect(await forge.registry.listProjects()).toEqual([]);
});

it("refuses one with another origin, or with nothing that says where it is from", async () => {
	const forge = await workspace("origin-older");

	// A browser that sends no `Sec-Fetch-Site` still names the page's origin on a POST.
	expect((await createProject(forge, "Forged", { origin: elsewhere })).status).toBe(403);
	expect((await createProject(forge, "Forged", { origin: "null" })).status).toBe(403);
	// Without an origin, the page's address decides, and one that only begins like the app's is
	// not the app's.
	expect((await createProject(forge, "Forged", { referer: `${elsewhere}/attack` })).status).toBe(
		403,
	);
	expect(
		(await createProject(forge, "Forged", { referer: `${origin}.elsewhere.example/` })).status,
	).toBe(403);
	// None of the three headers: refused, not let through.
	expect((await createProject(forge, "Forged", {})).status).toBe(403);

	expect(await forge.registry.listProjects()).toEqual([]);
});

it("answers the app's own pages as before", async () => {
	const forge = await workspace("origin-own");

	const browser = await createProject(forge, "From the page", {
		"sec-fetch-site": "same-origin",
		origin,
	});
	expect(browser.status).toBe(200);
	expect(browser.text).toContain("From the page");
	expect((await createProject(forge, "By origin", { origin })).status).toBe(200);
	expect(
		(await createProject(forge, "By referer", { referer: `${origin}/origin-own/projects` })).status,
	).toBe(200);

	const projects = await forge.registry.listProjects();
	expect(projects.map((project) => project.name).sort()).toEqual([
		"By origin",
		"By referer",
		"From the page",
	]);
});

it("guards a server function that reads as well", async () => {
	const forge = await workspace("origin-read");
	const read = (from: Record<string, string>) =>
		agents.fetch(
			serverFnRequest(origin, "getProjects", {
				data: forge.slug,
				method: "GET",
				headers: { cookie: forge.owner.headers.cookie, ...from },
			}),
		);

	const forged = await read({ "sec-fetch-site": "cross-site" });
	expect(forged.status).toBe(403);
	expect(await forged.text()).toBe("Forbidden");

	const own = await read({ "sec-fetch-site": "same-origin" });
	expect(own.status).toBe(200);
	expect(await own.text()).toContain("repositories");
});
