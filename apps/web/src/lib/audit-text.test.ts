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
				action: "agent.updated",
				target: { type: "agent", id: "a-2", label: "Coder" },
				detail: { fields: ["instructions"], asset: "Rules", from: 1, version: 2 },
			}),
		).toBe("moved the agent Coder from v1 to v2 of Rules");
		// A pin moved back says so the same way.
		expect(
			say({
				action: "agent.updated",
				target: { type: "agent", id: "a-2", label: "Coder" },
				detail: { fields: ["instructions"], asset: "Rules", from: 2, version: 1 },
			}),
		).toBe("moved the agent Coder from v2 to v1 of Rules");
		// An entry that does not say where the pin was names only where it went.
		expect(
			say({
				action: "agent.updated",
				target: { type: "agent", id: "a-2", label: "Coder" },
				detail: { fields: ["instructions"], asset: "Rules", version: 2 },
			}),
		).toBe("moved the agent Coder to v2 of Rules");
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
		// R1: the log says that a repository's checks were set, changed or removed, and how many
		// there are, never a command: a command is free text, and may hold what it should not.
		const checks = (detail: AuditEvent["detail"]) =>
			say({
				action: "repository.checksSet",
				target: { type: "repository", id: "r-1", label: "acme/api" },
				detail,
			});
		expect(checks({ checks: 2, before: 0 })).toBe("set 2 checks on acme/api");
		expect(checks({ checks: 1, before: 0 })).toBe("set 1 check on acme/api");
		expect(checks({ checks: 3, before: 2 })).toBe(
			"changed the checks of acme/api, which has 3 checks now",
		);
		expect(checks({ checks: 0, before: 2 })).toBe("removed the checks of acme/api");
		// An entry that held the commands themselves would not be read out.
		expect(checks({ checks: ["curl -H 'Authorization: Bearer abc' example.com"] })).toBe(
			"changed the checks of acme/api",
		);
		expect(
			say({
				action: "track.connected",
				target: { type: "agent", id: "a-1", label: "Coder" },
				detail: { origin: "https://track.example.com", workspace: "acme", trackAgent: "u-1" },
			}),
		).toBe("connected the agent Coder to the Track workspace acme on track.example.com");
	});

	it("names the agent that wrote to memory, and a memory by the start of its text", () => {
		const remembered = event({
			action: "memory.remembered",
			actorId: null,
			target: { type: "memory", id: "m-1", label: "Deploys go out on Tuesdays." },
			detail: { agent: "Scout", agentId: "a-1", run: "r-1", waiting: true, origin: "trigger" },
		});
		expect(auditActor(remembered, people)).toBe("The agent Scout");
		expect(auditSentence(remembered, people)).toBe(
			"remembered the memory “Deploys go out on Tuesdays.” in a run a trigger started, so it waits for approval",
		);
		expect(
			auditSentence({ ...remembered, detail: { agent: "Scout", waiting: false } }, people),
		).toBe("remembered the memory “Deploys go out on Tuesdays.”");
		// It says why one waits: what started the run, or in a person's run what it is about.
		const waits = (detail: AuditEvent["detail"]) =>
			auditSentence(
				{ ...remembered, detail: { agent: "Scout", waiting: true, ...detail } },
				people,
			);
		expect(waits({ origin: "replay", scope: "agent" })).toBe(
			"remembered the memory “Deploys go out on Tuesdays.” in a replay of a run a trigger started, so it waits for approval",
		);
		expect(waits({ origin: "person", scope: "workspace" })).toBe(
			"remembered the memory “Deploys go out on Tuesdays.” about the workspace, so it waits for approval",
		);
		expect(waits({ origin: "person", scope: "repository" })).toBe(
			"remembered the memory “Deploys go out on Tuesdays.” about a repository, so it waits for approval",
		);
		expect(auditSentence({ ...remembered, action: "memory.forgotten" }, people)).toBe(
			"forgot the memory “Deploys go out on Tuesdays.”, which it wrote itself",
		);
		const say = (action: AuditEvent["action"], label: string | null = "Reviews need two people.") =>
			auditSentence(event({ action, target: { type: "memory", id: "m-2", label } }), people);
		expect(say("memory.added")).toBe("added the memory “Reviews need two people.”");
		expect(say("memory.edited")).toBe("edited the memory “Reviews need two people.”");
		expect(say("memory.approved")).toBe(
			"approved the memory “Reviews need two people.”, so agents recall it",
		);
		// What was removed is named by its kind and what it was about, with none of its text.
		const removed = (action: AuditEvent["action"], detail: AuditEvent["detail"]) =>
			auditSentence(
				event({ action, target: { type: "memory", id: "m-2", label: null }, detail }),
				people,
			);
		expect(removed("memory.dismissed", { kind: "decision", scope: "workspace" })).toBe(
			"dismissed a decision about the workspace, which waited for approval",
		);
		expect(removed("memory.deleted", { kind: "preference", scope: "person" })).toBe(
			"deleted a preference about a person",
		);
		expect(removed("memory.deleted", { kind: "fact", scope: "agent" })).toBe(
			"deleted a fact about an agent",
		);
		expect(removed("memory.deleted", {})).toBe("deleted a memory");
		// One about a person is logged without its text.
		expect(say("memory.added", null)).toBe("added a memory about a person");
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
