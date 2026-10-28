/**
 * The workspace's model provider keys. Members see which providers have a key; owners and admins
 * add, check and remove them. A key goes to the registry and never comes back: the pages get its
 * last four characters.
 */
import { MODEL_PROVIDERS, type ProviderKey, providerKeyInput } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const provider = z.enum(MODEL_PROVIDERS);

async function memberOf(slug: string, admin: boolean) {
	const { currentMember } = await import("#/server/access");
	const { isAdmin } = await import("#/lib/roles");
	const member = await currentMember(slug);
	if (!member) return null;
	if (admin && !isAdmin(member.membership.role)) throw new Error("Only admins can do this");
	const { registryFor } = await import("#/server/registry");
	return { member, registry: registryFor(member.membership.workspaceId) };
}

/** The keys, and whether this server can keep keys at all (it needs `SECRETS_KEY`). */
export const getProviderKeys = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(async ({ data: slug }): Promise<{ configured: boolean; keys: ProviderKey[] } | null> => {
		const found = await memberOf(slug, false);
		if (!found) return null;
		const { env } = await import("cloudflare:workers");
		return { configured: Boolean(env.SECRETS_KEY), keys: await found.registry.listProviderKeys() };
	});

export const saveProviderKey = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), key: providerKeyInput }))
	.handler(async ({ data }): Promise<ProviderKey> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const { name, email } = found.member.user;
		const saved = await found.registry.saveProviderKey(data.key, name || email);
		if ("status" in saved) throw new Error(saved.message);
		return saved;
	});

/** Tries the key by listing the provider's models, which costs nothing. */
export const checkProviderKey = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), provider }))
	.handler(async ({ data }): Promise<ProviderKey> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const checked = await found.registry.checkProviderKey(data.provider);
		if ("status" in checked) throw new Error(checked.message);
		return checked;
	});

export const removeProviderKey = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), provider }))
	.handler(async ({ data }): Promise<boolean> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		return found.registry.removeProviderKey(data.provider);
	});
