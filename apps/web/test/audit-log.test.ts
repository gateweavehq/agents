import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkspace, signUp } from "./accounts";
import { startAgents } from "./agents-worker";

// The audit log (AGT-114): who changed a workspace's people and invitations, as Better Auth makes
// those changes, and the Settings page that shows it to owners and admins only.

const origin = "https://agents.test";
const DAY = 24 * 60 * 60 * 1000;

let agents: Awaited<ReturnType<typeof startAgents>>;

beforeAll(async () => {
	agents = await startAgents(origin);
});

afterAll(async () => {
	await agents?.dispose();
});

type Person = Awaited<ReturnType<typeof signUp>>;

function authApi(path: string, person: Person, body: object) {
	return agents.fetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: person.headers,
		body: JSON.stringify(body),
	});
}

async function ok<T>(response: Promise<Response>): Promise<T> {
	const answer = await response;
	expect(answer.status, await answer.clone().text()).toBe(200);
	return (await answer.json()) as T;
}

/** Makes someone a member without the invitation flow, which needs a verified address. */
async function addMember(workspaceId: string, userId: string, role = "member") {
	const id = crypto.randomUUID();
	await agents.db
		.prepare(
			"INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(id, workspaceId, userId, role, Date.now())
		.run();
	return id;
}

interface Row {
	action: string;
	actor_id: string | null;
	target_type: string;
	target_id: string | null;
	target_label: string | null;
	detail: string;
}

async function rows(workspaceId: string) {
	const { results } = await agents.db
		.prepare(
			"SELECT action, actor_id, target_type, target_id, target_label, detail FROM audit_event WHERE organization_id = ? ORDER BY id",
		)
		.bind(workspaceId)
		.all();
	return results as Row[];
}

async function page(path: string, cookie: string) {
	const response = await agents.fetch(`${origin}${path}`, { headers: { cookie } });
	expect(response.status).toBe(200);
	// React separates adjacent text nodes with comments, and escapes apostrophes.
	return (await response.text()).replaceAll("<!-- -->", "").replaceAll("&#x27;", "'");
}

describe("the audit log", () => {
	it("records who changed the workspace's people and invitations, for admins to read", async () => {
		const ola = await signUp(agents, origin, "ola-audit");
		const workspaceId = await createWorkspace(agents, origin, ola.headers, "audited");

		const invitation = await ok<{ id: string }>(
			authApi("/organization/invite-member", ola, {
				email: "Ivy@Example.com",
				role: "admin",
				organizationId: workspaceId,
			}),
		);
		await ok(authApi("/organization/cancel-invitation", ola, { invitationId: invitation.id }));

		const mo = await signUp(agents, origin, "mo-audit");
		const moMember = await addMember(workspaceId, mo.userId);
		await ok(
			authApi("/organization/update-member-role", ola, {
				memberId: moMember,
				role: "admin",
				organizationId: workspaceId,
			}),
		);
		// Refused, as only owners make owners: nothing is recorded.
		const refused = await authApi("/organization/update-member-role", mo, {
			memberId: moMember,
			role: "owner",
			organizationId: workspaceId,
		});
		expect(refused.status).not.toBe(200);

		const lee = await signUp(agents, origin, "lee-audit");
		await addMember(workspaceId, lee.userId);
		await ok(authApi("/organization/leave", lee, { organizationId: workspaceId }));
		await ok(
			authApi("/organization/remove-member", ola, {
				memberIdOrEmail: moMember,
				organizationId: workspaceId,
			}),
		);
		await ok(
			authApi("/organization/update", ola, {
				organizationId: workspaceId,
				data: { name: "Audited Inc" },
			}),
		);

		const expected = [
			["invitation.created", ola.userId, "invitation", invitation.id, "ivy@example.com"],
			["invitation.canceled", ola.userId, "invitation", invitation.id, "ivy@example.com"],
			["member.roleChanged", ola.userId, "member", mo.userId, null],
			["member.left", lee.userId, "member", lee.userId, null],
			["member.removed", ola.userId, "member", mo.userId, null],
			["workspace.updated", ola.userId, "workspace", workspaceId, "Audited Inc"],
		];
		// Recorded after the response, so wait for all of them.
		await vi.waitFor(async () => expect(await rows(workspaceId)).toHaveLength(expected.length), {
			timeout: 10_000,
		});
		const recorded = await rows(workspaceId);
		expect(
			recorded.map((row) => [
				row.action,
				row.actor_id,
				row.target_type,
				row.target_id,
				row.target_label,
			]),
		).toEqual(expected);
		const detail = (action: string) =>
			JSON.parse(recorded.find((row) => row.action === action)?.detail ?? "null");
		expect(detail("member.roleChanged")).toEqual({ from: "member", to: "admin" });
		expect(detail("workspace.updated")).toEqual({ name: "Audited Inc", previousName: "audited" });

		const html = await page("/audited/settings/audit", ola.headers.cookie);
		for (const text of [
			"Audit log",
			"invited ivy@example.com as an admin",
			"revoked the invitation to ivy@example.com",
			"changed mo-audit's role from member to admin",
			"left the workspace",
			"removed mo-audit",
			"renamed the workspace from audited to Audited Inc",
		]) {
			expect(html).toContain(text);
		}

		// A member who is not an admin is told so, and sees none of it.
		const kim = await signUp(agents, origin, "kim-audit");
		await addMember(workspaceId, kim.userId);
		const refusedPage = await page("/audited/settings/audit", kim.headers.cookie);
		expect(refusedPage).toContain("Only admins can read the audit log.");
		expect(refusedPage).not.toContain("ivy@example.com");
	});

	it("keeps events a year, and forgets the address of someone who deleted their account", async () => {
		const ada = await signUp(agents, origin, "ada-audit");
		const workspaceId = await createWorkspace(agents, origin, ada.headers, "kept");
		const insert = (at: number, action: string, label: string | null) =>
			agents.db
				.prepare(
					"INSERT INTO audit_event (organization_id, at, actor_id, action, target_type, target_id, target_label, detail) VALUES (?, ?, ?, ?, 'workspace', ?, ?, '{}')",
				)
				.bind(workspaceId, at, ada.userId, action, workspaceId, label)
				.run();
		await insert(Date.now() - 366 * DAY, "workspace.updated", "Old");
		await insert(Date.now() - 300 * DAY, "workspace.updated", "Recent");

		const gone = await signUp(agents, origin, "gone-audit");
		await ok(
			authApi("/organization/invite-member", ada, {
				email: "gone-audit@example.com",
				role: "member",
				organizationId: workspaceId,
			}),
		);
		await vi.waitFor(
			async () =>
				expect((await rows(workspaceId)).map((row) => row.action)).toContain("invitation.created"),
			{ timeout: 10_000 },
		);

		await agents.runScheduled();
		expect((await rows(workspaceId)).map((row) => row.target_label)).toEqual([
			"Recent",
			"gone-audit@example.com",
		]);

		await ok(authApi("/account/delete", gone, { password: "a-long-password" }));
		const invited = (await rows(workspaceId)).find((row) => row.action === "invitation.created");
		expect(invited?.target_label).toBeNull();
		expect(await page("/kept/settings/audit", ada.headers.cookie)).toContain(
			"invited an address since forgotten as a member",
		);
	});
});
