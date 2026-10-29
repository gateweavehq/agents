/**
 * Triggers: inbound webhooks that start a run of an agent or a team. Owners and admins make and
 * manage them, since a trigger's runs spend the workspace's keys with no member asking, and they
 * alone see the runs a trigger started. A trigger's secret is shown once, when it is made or
 * replaced.
 */
import {
	type Trigger,
	type TriggerEntry,
	triggerInput,
	triggerPatch,
	triggerSecret,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** A trigger, with the URL its sender posts to. */
export type TriggerView = TriggerEntry & { url: string };

/** A trigger just made or given a new secret, with that secret, which is not shown again. */
export interface TriggerSecretShown {
	trigger: Trigger & { url: string };
	secret: string;
}

const id = z.string().min(1).max(64);

async function adminOf(slug: string) {
	const { currentMember } = await import("#/server/access");
	const member = await currentMember(slug);
	if (!member) return null;
	const [{ isAdmin }, { registryFor }, { appOrigin }] = await Promise.all([
		import("#/lib/roles"),
		import("#/server/registry"),
		import("#/server/origin"),
	]);
	const { workspaceId, role } = member.membership;
	const origin = appOrigin();
	return {
		member,
		admin: isAdmin(role),
		registry: registryFor(workspaceId),
		urlOf: (triggerId: string) => `${origin}/api/triggers/${workspaceId}/${triggerId}`,
	};
}

async function requireAdmin(slug: string) {
	const found = await adminOf(slug);
	if (!found) throw new Error("Workspace not found");
	if (!found.admin) throw new Error("Only admins can do this");
	return found;
}

/** An agent's or a team's triggers; null for a member, who does not manage them. */
export const getTriggers = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), target: triggerInput.shape.target }))
	.handler(async ({ data }): Promise<TriggerView[] | null> => {
		const found = await adminOf(data.slug);
		if (!found?.admin) return null;
		const triggers = await found.registry.listTriggers(data.target);
		return triggers.map((trigger) => ({ ...trigger, url: found.urlOf(trigger.id) }));
	});

export const createTrigger = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), trigger: triggerInput }))
	.handler(async ({ data }): Promise<TriggerSecretShown> => {
		const found = await requireAdmin(data.slug);
		const made = await found.registry.createTrigger(data.trigger, found.member.user.id);
		if ("status" in made) throw new Error(made.message);
		return { trigger: { ...made.trigger, url: found.urlOf(made.trigger.id) }, secret: made.secret };
	});

export const updateTrigger = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triggerId: id, patch: triggerPatch }))
	.handler(async ({ data }): Promise<Trigger> => {
		const found = await requireAdmin(data.slug);
		const updated = await found.registry.updateTrigger(data.triggerId, data.patch);
		if (!updated) throw new Error("This trigger was deleted");
		return updated;
	});

export const deleteTrigger = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triggerId: id }))
	.handler(async ({ data }): Promise<boolean> => {
		const found = await requireAdmin(data.slug);
		return found.registry.deleteTrigger(data.triggerId);
	});

/** A new secret for the trigger: one made here, or with `secret`, the sender's own. */
export const replaceTriggerSecret = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triggerId: id, secret: triggerSecret.optional() }))
	.handler(async ({ data }): Promise<TriggerSecretShown> => {
		const found = await requireAdmin(data.slug);
		const replaced = await found.registry.replaceTriggerSecret(data.triggerId, data.secret);
		if (!replaced) throw new Error("This trigger was deleted");
		if ("status" in replaced) throw new Error(replaced.message);
		return {
			trigger: { ...replaced.trigger, url: found.urlOf(replaced.trigger.id) },
			secret: replaced.secret,
		};
	});
