/**
 * The workspace's environment sets. Members see their variables, the names of their secrets and
 * which have a value; owners and admins create and edit sets and store secret values. A value
 * goes to the registry and never comes back: there is no server function that returns one.
 */
import {
	type EnvSetEntry,
	envName,
	envSecretInput,
	envSetEditInput,
	envSetInput,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const id = z.string().min(1).max(64);

async function memberOf(slug: string, admin: boolean) {
	const { currentMember } = await import("#/server/access");
	const { isAdmin } = await import("#/lib/roles");
	const member = await currentMember(slug);
	if (!member) return null;
	if (admin && !isAdmin(member.membership.role)) throw new Error("Only admins can do this");
	const { registryFor } = await import("#/server/registry");
	return { member, registry: registryFor(member.membership.workspaceId) };
}

/**
 * The sets, whether this server can keep secret values at all (it needs `SECRETS_KEY`), and, for
 * owners and admins, when tying values stored before ties failed, so that they enter those again.
 */
export const getEnvironment = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<{
			configured: boolean;
			sets: EnvSetEntry[];
			tiesFailedAt: number | null;
		} | null> => {
			const found = await memberOf(slug, false);
			if (!found) return null;
			const { env } = await import("cloudflare:workers");
			const { isAdmin } = await import("#/lib/roles");
			const admin = isAdmin(found.member.membership.role);
			const [sets, tiesFailedAt] = await Promise.all([
				found.registry.listEnvSets(),
				admin ? found.registry.secretTiesFailedAt() : null,
			]);
			return { configured: Boolean(env.SECRETS_KEY), sets, tiesFailedAt };
		},
	);

/** Creates a set. Returns its id. */
export const createEnvSet = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), set: envSetInput }))
	.handler(async ({ data }): Promise<string> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		return found.registry.createEnvSet(data.set);
	});

export const editEnvSet = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), set: envSetEditInput }))
	.handler(async ({ data }): Promise<number> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		return found.registry.editEnvSet(data.set);
	});

/** Stores a secret's value, sealed. The value is not part of the answer. */
export const setEnvSecret = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), secret: envSecretInput }))
	.handler(async ({ data }): Promise<void> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const { name, email } = found.member.user;
		const saved = await found.registry.setEnvSecret(data.secret, name || email);
		if ("status" in saved) throw new Error(saved.message);
	});

export const removeEnvSecret = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), assetId: id, name: envName }))
	.handler(async ({ data }): Promise<boolean> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		return found.registry.removeEnvSecret(data.assetId, data.name);
	});
