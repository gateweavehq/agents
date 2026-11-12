import { env, WorkerEntrypoint } from "cloudflare:workers";
import type { BackupRow } from "@gateweave/agents-registry";
import { conversationName } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { db } from "./auth";
import { schema } from "./db";
import { registryFor } from "./registry";

/** How many workspaces a page of `objects` covers: each asks its registry for its conversations. */
const PAGE = 20;

/** A workspace's or a conversation's id, as a backup's file name can hold it. */
const PART = /^[A-Za-z0-9_-]{1,64}$/;

const cursorOf = z.string().regex(PART);

/** Which object a backup's name is: `registry.<workspace>` or `conversation.<workspace>.<id>`. */
function objectOf(name: unknown): { workspace: string; conversation?: string } | null {
	if (typeof name !== "string") return null;
	const parts = name.split(".");
	if (!parts.slice(1).every((part) => PART.test(part))) return null;
	const [kind, workspace, conversation] = parts;
	if (workspace === undefined) return null;
	if (kind === "registry" && parts.length === 2) return { workspace };
	if (kind === "conversation" && parts.length === 3 && conversation !== undefined) {
		return { workspace, conversation };
	}
	return null;
}

/**
 * Gateweave Backup's way in (docs/architecture.md, "Backups"). It lists each workspace's registry
 * and conversations, then reads one's Durable Object with the SELECTs of a SQLite dump, which the
 * object runs together and rolls back. A named entrypoint has no route: only a Worker in the same
 * account with a service binding to it can call it, so that binding is the access, the way the
 * gateways' checks are for people and agents. Only what D1 and the registry still list is read,
 * so a backup never wakes an object that was deleted, nor makes an empty one; anything else
 * answers null.
 */
export class Backup extends WorkerEntrypoint<Cloudflare.Env> {
	/**
	 * The objects' names, a page of workspaces at a time: each one's `registry.<workspace>`, then
	 * `conversation.<workspace>.<id>` for each of its conversations. Pass back `cursor` for the next.
	 */
	async objects(cursor?: string): Promise<{ names: string[]; cursor?: string }> {
		const after = cursor === undefined ? undefined : cursorOf.parse(cursor);
		const rows = await db
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(after === undefined ? undefined : gt(schema.organization.id, after))
			.orderBy(asc(schema.organization.id))
			.limit(PAGE + 1);
		const page = rows.slice(0, PAGE).map((row) => row.id);
		const names: string[] = [];
		for (const workspace of page) {
			names.push(`registry.${workspace}`);
			for (const id of await registryFor(workspace).backupConversations()) {
				names.push(`conversation.${workspace}.${id}`);
			}
		}
		const last = page[page.length - 1];
		return rows.length > PAGE && last ? { names, cursor: last } : { names };
	}

	/** Runs a backup's reads in one of the objects, or answers null if there is no such object. */
	async read(name: string, statements: string[]): Promise<BackupRow[][] | null> {
		const object = objectOf(name);
		if (!object) return null;
		const found = await db
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(eq(schema.organization.id, object.workspace))
			.get();
		if (!found) return null;
		const registry = registryFor(object.workspace);
		if (object.conversation === undefined) return registry.backupRead(statements);
		if (!(await registry.backupHasConversation(object.conversation))) return null;
		const conversation = await getAgentByName(
			env.CONVERSATIONS,
			conversationName(object.workspace, object.conversation),
		);
		return conversation.backupRead(statements);
	}
}
