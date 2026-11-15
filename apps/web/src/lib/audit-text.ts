import { MODEL_PROVIDER_NAMES, type ModelProvider } from "@gateweave/agents-model";
import { type AuditEvent, type AuditPerson, type AuditValue, hostOf } from "#/lib/audit-events";

/** The audit log's events in words, for the Settings page. */

type People = Record<string, AuditPerson>;

/** Who made the change: a member, an agent, the app itself, or someone whose account is gone. */
export function auditActor(event: AuditEvent, people: People): string {
	if (event.actorId === null) {
		const agent = text(event.detail.agent);
		const agents = event.action === "memory.remembered" || event.action === "memory.forgotten";
		return agents && agent ? `The agent ${agent}` : "Gateweave Agents";
	}
	return people[event.actorId]?.name ?? "Deleted member";
}

const FIELD_NAMES: Record<string, string> = {
	name: "name",
	description: "description",
	provider: "provider",
	model: "model",
	instructions: "instructions",
	environment: "environment set",
	mcpServers: "MCP servers",
	sandbox: "sandbox",
	repository: "repository",
	engine: "engine",
	memory: "memory",
	runtimes: "coding agents",
	assets: "assets",
	prompt: "prompt",
	perDay: "daily limit",
	events: "events",
	label: "label",
	assignee: "assignee",
	perIssue: "one run per issue",
	schedule: "schedule",
	active: "whether it runs",
};

function list(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function text(value: AuditValue | undefined): string | null {
	return typeof value === "string" ? value : null;
}

function fieldsOf(value: AuditValue | undefined): string {
	const fields = Array.isArray(value) ? value : [];
	return list(fields.map((field) => FIELD_NAMES[field] ?? field));
}

function article(role: string): string {
	return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

function provider(id: string | null): string {
	if (id && Object.hasOwn(MODEL_PROVIDER_NAMES, id)) {
		return MODEL_PROVIDER_NAMES[id as ModelProvider];
	}
	return id ?? "a provider";
}

/** What was done, to finish a sentence that starts with who did it. */
export function auditSentence(event: AuditEvent, people: People): string {
	const { target, detail } = event;
	const label = target.label ?? "(no name)";
	const person = (id: string | null) =>
		(id && people[id]?.name) ?? (id === null ? "someone" : "a deleted member");

	switch (event.action) {
		case "workspace.updated": {
			const parts: string[] = [];
			const name = text(detail.name);
			if (name) {
				const before = text(detail.previousName);
				parts.push(
					before
						? `renamed the workspace from ${before} to ${name}`
						: `renamed the workspace to ${name}`,
				);
			}
			const slug = text(detail.slug);
			if (slug) parts.push(`moved the workspace to /${slug}`);
			return parts.join(" and ") || "changed the workspace";
		}
		case "invitation.created": {
			const to = target.label ?? "an address since forgotten";
			const role = text(detail.role) ?? "member";
			return `${detail.resent ? "invited again" : "invited"} ${to} as ${article(role)}`;
		}
		case "invitation.canceled":
			return `revoked the invitation to ${target.label ?? "an address since forgotten"}`;
		case "member.joined":
			return `joined as ${article(text(detail.role) ?? "member")}`;
		case "member.removed":
			return `removed ${person(target.id)}`;
		case "member.left":
			return "left the workspace";
		case "member.roleChanged": {
			const from = text(detail.from);
			const to = text(detail.to) ?? "a new role";
			return from
				? `changed ${person(target.id)}'s role from ${from} to ${to}`
				: `changed ${person(target.id)}'s role to ${to}`;
		}
		case "providerKey.saved":
			return `saved the ${provider(target.id)} key`;
		case "providerKey.removed":
			return `removed the ${provider(target.id)} key`;
		case "envSet.created":
			return `created the environment set ${label}`;
		case "envSet.edited":
			return `edited the environment set ${label}`;
		case "envSecret.set":
			return `set the secret ${text(detail.name) ?? ""} in ${label}`;
		case "envSecret.removed":
			return `removed the secret ${text(detail.name) ?? ""} from ${label}`;
		case "telemetry.set":
			return `sent run traces to ${target.label ?? "a new endpoint"}`;
		case "telemetry.removed":
			return "stopped sending run traces";
		case "github.connected":
			return `connected the GitHub account ${label}`;
		case "github.disconnected":
			return `disconnected the GitHub account ${label}`;
		case "gitlab.connected":
			return `connected GitLab: ${label}`;
		case "gitlab.secretReplaced":
			return `gave the GitLab webhook of ${label} a new secret`;
		case "gitlab.disconnected":
			return `disconnected GitLab: ${label}`;
		case "mcpServer.created": {
			const host = text(detail.host);
			return `added the MCP server ${label}${host ? ` at ${host}` : ""}`;
		}
		case "mcpServer.edited":
			return `edited the MCP server ${label}`;
		case "mcpServer.connected":
			return `signed the MCP server ${label} in`;
		case "mcpServer.disconnected":
			return `signed the MCP server ${label} out`;
		case "trigger.created": {
			const target = text(detail.for);
			return `created the trigger ${label}${target ? ` for ${target}` : ""}`;
		}
		case "trigger.updated": {
			const fields = Array.isArray(detail.fields) ? detail.fields : [];
			if (fields.length === 1 && fields[0] === "active" && typeof detail.active === "boolean") {
				return `${detail.active ? "resumed" : "paused"} the trigger ${label}`;
			}
			return `changed the trigger ${label}'s ${fieldsOf(detail.fields)}`;
		}
		case "trigger.deleted":
			return `deleted the trigger ${label}`;
		case "trigger.secretReplaced":
			return `gave the trigger ${label} a new secret`;
		case "trackTriage.setUp":
			return `set up Track triage with the agent ${label}${trackHost(detail.track)}`;
		case "trackWork.setUp":
			return `set up Track work with the agent ${label}${trackHost(detail.track)}`;
		case "track.connected": {
			const workspace = text(detail.workspace);
			const host = hostOf(text(detail.origin) ?? "");
			return `connected the agent ${label} to ${workspace ? `the Track workspace ${workspace}` : "Track"}${trackHost(host ?? undefined)}`;
		}
		case "agent.created":
			return `created the agent ${label}`;
		case "agent.updated":
			return `changed the agent ${label}'s ${fieldsOf(detail.fields)}`;
		case "agent.removed":
			return `removed the agent ${label}`;
		case "team.created":
			return `created the team ${label}`;
		case "team.updated":
			return `changed the team ${label}'s ${fieldsOf(detail.fields)}`;
		case "team.deleted":
			return `deleted the team ${label}`;
		case "setup.created":
			return detail.readyMade
				? `added the ready-made setup ${label}`
				: `created the setup ${label}`;
		case "setup.updated":
			return `changed the setup ${label}'s ${fieldsOf(detail.fields)}`;
		case "setup.deleted":
			return `deleted the setup ${label}`;
		case "setup.applied": {
			const repository = text(detail.repository) ?? "a repository";
			return detail.pullRequest === "updated"
				? `updated the pull request applying the setup ${label} to ${repository}`
				: `opened a pull request applying the setup ${label} to ${repository}`;
		}
		case "project.deleted":
			return `deleted the project ${label}`;
		case "library.removed":
			return `removed ${label} from the library`;
		case "memory.added":
			return `added ${memory(target.label)}`;
		case "memory.edited":
			return `edited ${memory(target.label)}`;
		case "memory.approved":
			return `approved ${memory(target.label)}, so agents recall it`;
		case "memory.dismissed":
			return `dismissed ${removedMemory(detail)}, which waited for approval`;
		case "memory.deleted":
			return `deleted ${removedMemory(detail)}`;
		case "memory.remembered":
			return detail.waiting
				? `remembered ${memory(target.label)}${whyWaiting(detail)}, so it waits for approval`
				: `remembered ${memory(target.label)}`;
		case "memory.forgotten":
			return `forgot ${memory(target.label)}, which it wrote itself`;
	}
}

/** A memory by the start of its text, which is all the log keeps; one about a person by nothing. */
function memory(excerpt: string | null): string {
	return excerpt === null ? "a memory about a person" : `the memory “${excerpt}”`;
}

/** A memory that was removed, of which the log keeps the kind and what it was about, no text. */
function removedMemory(detail: AuditEvent["detail"]): string {
	const kind = text(detail.kind) ?? "memory";
	const about = {
		workspace: " about the workspace",
		agent: " about an agent",
		repository: " about a repository",
		person: " about a person",
	}[text(detail.scope) ?? ""];
	return `a ${kind}${about ?? ""}`;
}

/** Why what an agent remembered waits: what started its run, or else what it is about. */
function whyWaiting(detail: AuditEvent["detail"]): string {
	if (detail.origin === "trigger") return " in a run a trigger started";
	if (detail.origin === "replay") return " in a replay of a run a trigger started";
	if (detail.origin === "unknown") return " in a run whose start could not be read";
	// In a person's run, what every agent, or a repository's, would recall waits.
	if (detail.scope === "workspace") return " about the workspace";
	if (detail.scope === "repository") return " about a repository";
	return "";
}

function trackHost(value: AuditValue | undefined): string {
	const host = text(value);
	return host ? ` on ${host}` : "";
}
