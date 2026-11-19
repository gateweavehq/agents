import type { AgentDefinition } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import { type AuditEvent, changedFields } from "./audit-events";
import { auditSentence } from "./audit-text";

const definition = (fields: Partial<AgentDefinition> = {}): AgentDefinition => ({
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	instructions: null,
	environment: null,
	mcpServers: [],
	sandbox: false,
	repository: null,
	engine: "gateweave",
	memory: false,
	files: false,
	outsideTasks: false,
	...fields,
});

describe("an agent's files setting in the audit log", () => {
	it("is a change only when it changed", () => {
		const fields = ["sandbox", "repository", "memory", "files"] as const;
		expect(changedFields(definition(), definition(), fields)).toEqual([]);
		const site = { id: "r-1", owner: "acme", name: "site", removed: false };
		expect(
			changedFields(definition(), definition({ files: true, repository: site }), fields),
		).toEqual(["repository", "files"]);
	});

	it("is told in words", () => {
		const event: AuditEvent = {
			id: 1,
			at: 0,
			actorId: "user-ola",
			target: { type: "agent", id: "a-2", label: "Coder" },
			action: "agent.updated",
			detail: { fields: ["repository", "files"] },
		};
		expect(auditSentence(event, { "user-ola": { name: "Ola", image: null } })).toBe(
			"changed the agent Coder's repository and work on files without a sandbox",
		);
	});
});
