import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";
import { callServerFn, serverFnRequest } from "./server-fn";

const origin = "https://agents.test";
const trackOrigin = "https://reports.test:8443";
const endpoint = `${trackOrigin}/api/events`;
type Person = Awaited<ReturnType<typeof signUp>>;

function answerFor(teamId: string) {
	return {
		sourceKey: `gws_${randomBytes(32).toString("base64url")}`,
		endpoint,
		source: { id: crypto.randomUUID(), name: "Gateweave Agents", product: "agents" },
		workspace: { id: "w_ops", slug: "ops", name: "Operations Workspace" },
		team: { id: teamId, key: teamId.toUpperCase(), name: `Team ${teamId}` },
		undo: `undo.${randomBytes(24).toString("base64url")}`,
		undoUntil: new Date(Date.now() + 600_000).toISOString(),
	};
}

type Answer = ReturnType<typeof answerFor>;
const approvals = new Map<
	string,
	{ challenge: string; answer: Answer; beforeExchange?: () => Promise<void> }
>();
const exchanges: { code: string; verifier: string }[] = [];
const undos: string[] = [];
const seen: string[] = [];
let undoAllowed = true;

async function handle(request: Request): Promise<Response> {
	const url = new URL(request.url);
	expect(url.origin).toBe(trackOrigin);
	expect(request.method).toBe("POST");
	if (url.pathname === "/api/connect/exchange") {
		const { code, verifier } = (await request.json()) as { code: string; verifier: string };
		exchanges.push({ code, verifier });
		const approval = approvals.get(code);
		approvals.delete(code);
		if (
			!approval ||
			createHash("sha256").update(verifier).digest("base64url") !== approval.challenge
		) {
			return Response.json({ error: "invalid_code" }, { status: 400 });
		}
		await approval.beforeExchange?.();
		return Response.json(approval.answer);
	}
	if (url.pathname === "/api/connect/undo") {
		const { undo } = (await request.json()) as { undo: string };
		undos.push(undo);
		return undoAllowed
			? Response.json({ ok: true })
			: Response.json({ error: "invalid_undo" }, { status: 400 });
	}
	return new Response(null, { status: 404 });
}

let agents: Awaited<ReturnType<typeof startAgents>>;
beforeAll(async () => {
	agents = await startAgents(origin, { hosts: { [new URL(trackOrigin).host]: handle } });
});
afterEach(() => {
	for (const call of agents.outbound) {
		expect([`${trackOrigin}/api/connect/exchange`, `${trackOrigin}/api/connect/undo`]).toContain(
			call,
		);
	}
	undoAllowed = true;
});
afterAll(async () => {
	await agents?.dispose();
});

let counter = 0;
async function workspace() {
	const slug = `reporting-${++counter}`;
	const owner = await signUp(agents, origin, `owner-${slug}`);
	const workspaceId = await createWorkspace(agents, origin, owner.headers, slug);
	return { owner, slug, workspaceId, registry: await agents.registry(workspaceId) };
}

async function join(workspaceId: string, role: "admin" | "member") {
	const person = await signUp(agents, origin, `${role}-${++counter}`);
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(crypto.randomUUID(), workspaceId, person.userId, role, Date.now())
		.run();
	return person;
}

async function call(
	who: Person,
	name: string,
	data: Record<string, unknown>,
	method?: "GET" | "POST",
) {
	const result = await callServerFn(agents, origin, name, {
		data,
		method,
		cookie: who.headers.cookie,
		client: who.headers["cf-connecting-ip"],
	});
	seen.push(result.text);
	return result;
}

async function start(who: Person, slug: string, trackUrl = "https://Reports.test:8443/ops") {
	return call(who, "beginTrackSource", { slug, trackUrl });
}

async function address(who: Person, slug: string) {
	const result = await start(who, slug);
	expect(result.failed).toBe(false);
	const link = /https:\/\/reports\.test:8443\/connect\/source[^"\\]*/.exec(result.text)?.[0];
	if (!link) throw new Error("No Track approval address returned");
	return new URL(link);
}

function approve(link: URL, answer = answerFor("ops"), beforeExchange?: () => Promise<void>) {
	const code = randomBytes(32).toString("base64url");
	const back = new URL(link.searchParams.get("return") ?? "");
	back.searchParams.set("state", link.searchParams.get("state") ?? "");
	back.searchParams.set("code", code);
	approvals.set(code, {
		answer,
		beforeExchange,
		challenge: link.searchParams.get("challenge") ?? "",
	});
	return { back, answer, code };
}

async function arrive(who: Person | null, back: URL) {
	const response = await agents.fetch(back, { headers: who ? { cookie: who.headers.cookie } : {} });
	const body = await response.text();
	const location = response.headers.get("location") ?? "";
	seen.push(body, location);
	expect(response.headers.get("cache-control")).toContain("no-store");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	return { status: response.status, body, location };
}

function expectPrivate(approval: ReturnType<typeof approve>) {
	const { code, answer } = approval;
	const verifier = exchanges.find((exchange) => exchange.code === code)?.verifier;
	const publicText = [...seen, ...agents.logs.map((log) => log.message)].join("\n");
	for (const secret of [answer.sourceKey, answer.undo, code, verifier]) {
		if (secret) expect(publicText).not.toContain(secret);
	}
}

it("connects without model or sandbox setup, seals the key, and shows only destination metadata", async () => {
	const { owner, slug, workspaceId, registry } = await workspace();
	const admin = await join(workspaceId, "admin");
	const link = await address(admin, slug);
	expect(link.searchParams.get("return")).toBe(
		`${origin}/api/track/source-connected?workspace=${workspaceId}`,
	);
	expect(link.searchParams.get("links")).toBe(origin);
	const approval = approve(link);
	const result = await arrive(admin, approval.back);
	expect(result).toMatchObject({ status: 302, location: `/${slug}/agents?trackSource=connected` });
	const browser = await call(owner, "getTrackSources", { slug }, "GET");
	expect(browser.failed).toBe(false);
	expect(browser.text).toContain("Operations Workspace");
	expect(browser.text).toContain("Team ops");
	expect(browser.text).toContain(trackOrigin);
	expect(browser.text).not.toMatch(/sourceKey|sealedKey|sealed_key/);
	const { result: rows } = await agents.backup<{ sealed_key: string }[][]>(
		"read",
		`registry.${workspaceId}`,
		["SELECT sealed_key FROM track_source_destinations"],
	);
	expect(rows?.[0]?.[0]?.sealed_key).toMatch(/^v1\./);
	expect(JSON.stringify(rows)).not.toContain(approval.answer.sourceKey);
	expect(await registry.sealedCounts()).toEqual({ explicit: 1, derived: 0 });
	expect(await registry.listEnvSets()).toEqual([]);
	expect(await registry.listMcpServers()).toEqual([]);
	expect(await registry.listTriggers()).toEqual([]);
	const html = await agents.fetch(`${origin}/${slug}/agents`, { headers: owner.headers });
	expect(html.status).toBe(200);
	const body = await html.text();
	expect(body).toContain("Track run reporting");
	seen.push(body);
	expectPrivate(approval);
});

it("requires same-origin and admin access, and rejects an unsuitable Track origin before saving state", async () => {
	const { owner, slug, workspaceId } = await workspace();
	const member = await join(workspaceId, "member");
	expect((await start(member, slug)).text).toContain("Only admins");
	expect((await call(member, "getTrackSources", { slug }, "GET")).text).toContain("Only admins");
	const crossSite = await agents.fetch(
		serverFnRequest(origin, "beginTrackSource", {
			data: { slug, trackUrl: trackOrigin },
			headers: {
				origin: trackOrigin,
				cookie: owner.headers.cookie,
				"sec-fetch-site": "cross-site",
			},
		}),
	);
	expect(crossSite.status).toBe(403);
	expect((await start(owner, slug, "https://AGENTS.test:443/another-page")).text).toContain(
		"different origins",
	);
	expect((await start(owner, slug, "https://user@reports.test:8443")).failed).toBe(true);
	const pending = await agents.backup("read", `registry.${workspaceId}`, [
		"SELECT state FROM track_connections",
	]);
	expect(pending.result).toEqual([[]]);
});

it("requires the starter and a current admin in the original workspace, and consumes the state once", async () => {
	const { owner, slug, workspaceId } = await workspace();
	const otherWorkspace = await createWorkspace(agents, origin, owner.headers, `other-${slug}`);
	const admin = await join(workspaceId, "admin");
	const approval = approve(await address(admin, slug));
	const before = exchanges.length;
	const wrongWorkspace = new URL(approval.back);
	wrongWorkspace.searchParams.set("workspace", otherWorkspace);
	expect((await arrive(owner, wrongWorkspace)).status).toBe(400);

	const wrongState = new URL(approval.back);
	wrongState.searchParams.set("state", randomBytes(32).toString("base64url"));
	expect((await arrive(admin, wrongState)).status).toBe(400);

	await agents.db
		.prepare("UPDATE member SET role = 'member' WHERE organization_id = ? AND user_id = ?")
		.bind(workspaceId, admin.userId)
		.run();
	expect((await arrive(admin, approval.back)).status).toBe(403);
	expect(await arrive(null, approval.back)).toMatchObject({
		status: 302,
		location: "/login?redirect=%2F",
	});
	expect((await arrive(owner, approval.back)).status).toBe(400);
	await agents.db
		.prepare("UPDATE member SET role = 'admin' WHERE organization_id = ? AND user_id = ?")
		.bind(workspaceId, admin.userId)
		.run();
	expect((await arrive(admin, approval.back)).status).toBe(400);
	expect(exchanges).toHaveLength(before);
	expectPrivate(approval);
});

it("takes back the source if the starter loses admin access during the exchange", async () => {
	const { slug, workspaceId } = await workspace();
	const admin = await join(workspaceId, "admin");
	const approval = approve(await address(admin, slug), answerFor("ops"), async () => {
		await agents.db
			.prepare("UPDATE member SET role = 'member' WHERE organization_id = ? AND user_id = ?")
			.bind(workspaceId, admin.userId)
			.run();
	});
	const before = undos.length;
	expect((await arrive(admin, approval.back)).status).toBe(403);
	expect(undos.slice(before)).toEqual([approval.answer.undo]);
	const destinations = await agents.backup("read", `registry.${workspaceId}`, [
		"SELECT id FROM track_source_destinations",
	]);
	expect(destinations.result).toEqual([[]]);
	expectPrivate(approval);
});

it("cancels without an exchange", async () => {
	const { owner, slug } = await workspace();
	const link = await address(owner, slug);
	const back = new URL(link.searchParams.get("return") ?? "");
	back.searchParams.set("error", "denied");
	back.searchParams.set("state", link.searchParams.get("state") ?? "");
	const before = exchanges.length;
	expect(await arrive(owner, back)).toMatchObject({
		status: 302,
		location: `/${slug}/agents?trackSource=denied`,
	});
	expect((await arrive(owner, back)).status).toBe(400);
	expect(exchanges).toHaveLength(before);
});

it.each(["endpoint", "agent key", "reflected key"])(
	"undoes a rejected reply with a bad %s",
	async (problem) => {
		const { owner, slug, registry } = await workspace();
		const answer = answerFor("ops");
		if (problem === "endpoint") answer.endpoint += "?other=1";
		if (problem === "agent key") answer.sourceKey = `gwt_${"k".repeat(43)}`;
		if (problem === "reflected key") answer.workspace.name = `Work ${answer.sourceKey}`;
		const approval = approve(await address(owner, slug), answer);
		const before = undos.length;
		expect(await arrive(owner, approval.back)).toMatchObject({
			status: 302,
			location: `/${slug}/agents?trackSource=failed`,
		});
		expect(undos.slice(before)).toEqual([answer.undo]);
		expect(await registry.sealedCounts()).toEqual({ explicit: 0, derived: 0 });
		expectPrivate(approval);
	},
);

it("directs the owner to Track source settings when undo fails", async () => {
	const { owner, slug } = await workspace();
	const answer = answerFor("ops");
	answer.endpoint = "https://other.test/api/events";
	undoAllowed = false;
	const approval = approve(await address(owner, slug), answer);
	const result = await arrive(owner, approval.back);
	expect(result.status).toBe(502);
	expect(result.body).toContain("Settings &gt; Sources in Track");
	expectPrivate(approval);
});

it("undoes a definitely refused save if the registry froze after claiming state", async () => {
	const { owner, slug, registry } = await workspace();
	const before = undos.length;
	const approval = approve(await address(owner, slug), answerFor("ops"), async () => {
		expect(await registry.moveOut("reporting-move-token", "target")).toMatchObject({
			frozen: true,
		});
	});
	expect(await arrive(owner, approval.back)).toMatchObject({
		status: 302,
		location: `/${slug}/agents?trackSource=failed`,
	});
	expect(undos.slice(before)).toEqual([approval.answer.undo]);
	expect(await registry.sealedCounts()).toEqual({ explicit: 0, derived: 0 });
	expectPrivate(approval);
});

it("reports an unknown save outcome when the registry can no longer confirm the source", async () => {
	const { owner, slug, registry } = await workspace();
	const before = undos.length;
	const approval = approve(await address(owner, slug), answerFor("ops"), async () => {
		const token = "reporting-move-token";
		expect(await registry.moveOut(token, "target")).toMatchObject({ frozen: true });
		await registry.moveSeal(token, "target");
		expect(await registry.moveForget()).toBe("forgotten");
	});
	const result = await arrive(owner, approval.back);
	expect(result.status).toBe(503);
	expect(result.body).toContain("Connection status unknown");
	expect(undos).toHaveLength(before);
	expectPrivate(approval);
});

it("keeps the original on a duplicate, permits another team, and disconnects only the scoped row", async () => {
	const { owner, slug, workspaceId } = await workspace();
	const first = approve(await address(owner, slug));
	expect((await arrive(owner, first.back)).location).toContain("trackSource=connected");
	expect((await arrive(owner, first.back)).status).toBe(400);
	const duplicate = approve(await address(owner, slug));
	const before = undos.length;
	expect((await arrive(owner, duplicate.back)).location).toContain("trackSource=duplicate");
	expect(undos.slice(before)).toEqual([duplicate.answer.undo]);

	const other = approve(await address(owner, slug), answerFor("dev"));
	expect((await arrive(owner, other.back)).location).toContain("trackSource=connected");
	const { result: rows } = await agents.backup<{ id: string; source_id: string }[][]>(
		"read",
		`registry.${workspaceId}`,
		["SELECT id, source_id FROM track_source_destinations WHERE team_id = 'ops'"],
	);
	expect(rows?.[0]).toEqual([{ id: expect.any(String), source_id: first.answer.source.id }]);
	const connectionId = rows?.[0]?.[0]?.id;
	if (!connectionId) throw new Error("No saved destination");

	const member = await join(workspaceId, "member");
	expect((await call(member, "disconnectTrackSource", { slug, connectionId })).text).toContain(
		"Only admins",
	);
	const second = await workspace();
	await call(second.owner, "disconnectTrackSource", { slug: second.slug, connectionId });
	expect((await call(owner, "getTrackSources", { slug }, "GET")).text).toContain("Team ops");
	const disconnected = await call(owner, "disconnectTrackSource", { slug, connectionId });
	expect(disconnected.failed).toBe(false);
	const listed = (await call(owner, "getTrackSources", { slug }, "GET")).text;
	expect(listed).not.toContain("Team ops");
	expect(listed).toContain("Team dev");
	expect(undos.slice(before)).toEqual([duplicate.answer.undo]);
	for (const approval of [first, duplicate, other]) expectPrivate(approval);
});

it("refuses to create pending state for HTTP Agents", async () => {
	const insecureOrigin = "http://localhost:4720";
	const insecure = await startAgents(insecureOrigin);
	try {
		const owner = await signUp(insecure, insecureOrigin, "http-owner");
		const slug = "http-reporting";
		const workspaceId = await createWorkspace(insecure, insecureOrigin, owner.headers, slug);
		const start = await callServerFn(insecure, insecureOrigin, "beginTrackSource", {
			data: { slug, trackUrl: trackOrigin },
			cookie: owner.headers.cookie,
			client: owner.headers["cf-connecting-ip"],
		});
		expect(start.text).toContain("requires a public HTTPS address");
		const pending = await insecure.backup("read", `registry.${workspaceId}`, [
			"SELECT state FROM track_connections",
		]);
		expect(pending.result).toEqual([[]]);
	} finally {
		await insecure.dispose();
	}
});
