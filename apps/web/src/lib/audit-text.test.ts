import { describe, expect, it } from "vitest";
import { type AuditEvent, changedFields, hostOf } from "./audit-events";
import { auditActor, auditSentence } from "./audit-text";

const people = {
	"user-ola": { name: "Ola", image: null },
	"user-mo": { name: "Mo", image: null },
};

function event(fields: Partial<AuditEvent> & Pick<AuditEvent, "action">): AuditEvent {
	return {
		id: 1,
		at: 0,
		actorId: "user-ola",
		target: { type: "workspace", id: null, label: null },
		detail: {},
		...fields,
	};
}

describe("audit events in words", () => {
	it("names who did it, or says the account is gone", () => {
		expect(auditActor(event({ action: "member.left" }), people)).toBe("Ola");
		expect(auditActor(event({ action: "member.left", actorId: null }), people)).toBe(
			"Gateweave Agents",
		);
		expect(auditActor(event({ action: "member.left", actorId: "user-gone" }), people)).toBe(
			"Deleted member",
		);
	});

	it("says what was done to what", () => {
		const say = (fields: Parameters<typeof event>[0]) => auditSentence(event(fields), people);
		expect(
			say({
				action: "invitation.created",
				target: { type: "invitation", id: "inv-1", label: null },
				detail: { role: "member" },
			}),
		).toBe("invited an address since forgotten as a member");
		expect(
			say({
				action: "member.roleChanged",
				target: { type: "member", id: "user-mo", label: null },
				detail: { from: "member", to: "admin" },
			}),
		).toBe("changed Mo's role from member to admin");
		expect(
			say({
				action: "providerKey.saved",
				target: { type: "providerKey", id: "anthropic", label: "anthropic" },
			}),
		).toBe("saved the Anthropic key");
		expect(
			say({
				action: "envSecret.set",
				target: { type: "envSet", id: "a-1", label: "production" },
				detail: { name: "DATABASE_PASSWORD" },
			}),
		).toBe("set the secret DATABASE_PASSWORD in production");
		expect(
			say({
				action: "agent.updated",
				target: { type: "agent", id: "a-2", label: "Coder" },
				detail: { fields: ["model", "mcpServers", "sandbox"] },
			}),
		).toBe("changed the agent Coder's model, MCP servers and sandbox");
		expect(
			say({
				action: "trigger.updated",
				target: { type: "trigger", id: "t-1", label: "Nightly" },
				detail: { fields: ["active"], active: false },
			}),
		).toBe("paused the trigger Nightly");
		expect(
			say({
				action: "setup.applied",
				target: { type: "setup", id: "s-1", label: "Claude basics" },
				detail: { repository: "acme/api", pullRequest: "opened" },
			}),
		).toBe("opened a pull request applying the setup Claude basics to acme/api");
		expect(
			say({ action: "project.deleted", target: { type: "project", id: "p-1", label: null } }),
		).toBe("deleted the project (no name)");
	});

	it("keeps a URL's host only, and finds which fields changed", () => {
		expect(hostOf("https://hooks.example.com/abc?token=secret")).toBe("hooks.example.com");
		expect(hostOf("not a url")).toBeNull();
		expect(
			changedFields(
				{ name: "A", runtimes: ["claude"], description: null },
				{ name: "A", runtimes: ["claude", "codex"], description: null },
				["name", "runtimes", "description"],
			),
		).toEqual(["runtimes"]);
	});
});
