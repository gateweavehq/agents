/**
 * The workspace's audit log: who changed how the workspace is set up, and when. Its members and
 * invitations, its keys and secrets, its connections, its agents, teams and setups, and what was
 * deleted. Chats, scans and runs are work, not setup, and are not in it. No server code, so the
 * Settings page can read these too.
 */

export const AUDIT_ACTIONS = [
	// Membership, from Better Auth (`server/auth/audit.ts`).
	"workspace.updated",
	"invitation.created",
	"invitation.canceled",
	"member.joined",
	"member.removed",
	"member.left",
	"member.roleChanged",
	// Keys and secrets. Never their values.
	"providerKey.saved",
	"providerKey.removed",
	"envSet.created",
	"envSet.edited",
	"envSecret.set",
	"envSecret.removed",
	"telemetry.set",
	"telemetry.removed",
	// Connections.
	"github.connected",
	"github.disconnected",
	"gitlab.connected",
	"gitlab.secretReplaced",
	"gitlab.disconnected",
	"mcpServer.created",
	"mcpServer.edited",
	"mcpServer.connected",
	"mcpServer.disconnected",
	"trigger.created",
	"trigger.updated",
	"trigger.deleted",
	"trigger.secretReplaced",
	"trackTriage.setUp",
	"trackWork.setUp",
	// Agents, teams and setups, which act in repositories and on other services.
	"agent.created",
	"agent.updated",
	"agent.removed",
	"team.created",
	"team.updated",
	"team.deleted",
	"setup.created",
	"setup.updated",
	"setup.deleted",
	"setup.applied",
	// Deletions.
	"project.deleted",
	"library.removed",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
	"workspace",
	"invitation",
	"member",
	"providerKey",
	"envSet",
	"telemetry",
	"github",
	"gitlab",
	"mcpServer",
	"trigger",
	"agent",
	"team",
	"setup",
	"project",
	"asset",
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/**
 * What a change was done to. The label is taken when it happens, since the thing may be gone or
 * renamed when the log is read: a name, an address an invitation went to, or a host.
 */
export interface AuditTarget {
	type: AuditTargetType;
	id: string | null;
	label: string | null;
}

export type AuditValue = string | number | boolean | null | string[];

/** A little more about a change: a role's before and after, the fields an edit changed. */
export type AuditDetail = Record<string, AuditValue>;

export interface AuditEvent {
	id: number;
	at: number;
	/** The member who made the change; null for the app itself. */
	actorId: string | null;
	action: AuditAction;
	target: AuditTarget;
	detail: AuditDetail;
}

/** Someone an event names, as the deployment knows them now. */
export interface AuditPerson {
	name: string;
	image: string | null;
}

export interface AuditPage {
	events: AuditEvent[];
	people: Record<string, AuditPerson>;
	/** Pass as `before` for the next page; null on the last. */
	next: number | null;
}

export const AUDIT_PAGE_SIZE = 50;

/** A URL by its host only: the rest of one can be its secret. */
export function hostOf(url: string): string | null {
	try {
		return new URL(url).host;
	} catch {
		return null;
	}
}

/** Which of these fields differ between two versions of something. */
export function changedFields<T extends object>(
	before: T,
	after: T,
	fields: readonly (keyof T & string)[],
): string[] {
	return fields.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
