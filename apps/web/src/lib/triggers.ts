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

/**
 * A trigger, with the URL its sender posts to. A review trigger has no sender, so it has no URL
 * (null): it is started by the pull requests the workspace's agents open.
 */
export type TriggerView = TriggerEntry & { url: string | null };

/** A trigger just made or given a new secret, with that secret, which is not shown again. */
export interface TriggerSecretShown {
	trigger: Trigger & { url: string };
	secret: string;
}

/** A trigger just made that takes no webhooks: it has no URL and no secret to show once. */
export interface CredentiallessTriggerMade {
	trigger: Trigger & { url: null };
	secret: null;
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
		registry: registryFor(member.membership),
		urlOf: (triggerId: string) => `${origin}/api/triggers/${workspaceId}/${triggerId}`,
	};
}

async function requireAdmin(slug: string) {
	const found = await adminOf(slug);
	if (!found) throw new Error("Workspace not found");
	if (!found.admin) throw new Error("Only admins can do this");
	const { auditFor } = await import("#/server/audit");
	return { ...found, audit: auditFor(found.member) };
}

/** A trigger as the audit log names it, with what it starts. */
function triggerTarget(trigger: Pick<Trigger, "id" | "name">) {
	return { type: "trigger" as const, id: trigger.id, label: trigger.name };
}

/** An agent's or a team's triggers; null for a member, who does not manage them. */
export const getTriggers = createServerFn({ method: "GET" })
	.validator(z.object({ slug: z.string().min(1), target: triggerInput.shape.target }))
	.handler(async ({ data }): Promise<TriggerView[] | null> => {
		const found = await adminOf(data.slug);
		if (!found?.admin) return null;
		const triggers = await found.registry.listTriggers(data.target);
		return triggers.map((trigger) => ({
			...trigger,
			url: trigger.pullRequest || trigger.schedule ? null : found.urlOf(trigger.id),
		}));
	});

export const createTrigger = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), trigger: triggerInput }))
	.handler(async ({ data }): Promise<TriggerSecretShown | CredentiallessTriggerMade> => {
		const found = await requireAdmin(data.slug);
		// A review trigger has no URL and no secret: it is made apart from the webhooks, which hand
		// both out once.
		if (data.trigger.pullRequest) {
			const { pullRequest: _, ...input } = data.trigger;
			const review = await found.registry.createReviewTrigger(input, found.member.user.id);
			if ("status" in review) throw new Error(review.message);
			await found.audit({
				action: "trigger.created",
				target: triggerTarget(review.trigger),
				detail: { for: review.trigger.targetName, kind: "pull_request" },
			});
			return { trigger: { ...review.trigger, url: null }, secret: null };
		}
		if (data.trigger.schedule !== null) {
			const { pullRequest: _, ...input } = data.trigger;
			const scheduled = await found.registry.createScheduledTrigger(input, found.member.user.id);
			if ("status" in scheduled) throw new Error(scheduled.message);
			await found.audit({
				action: "trigger.created",
				target: triggerTarget(scheduled.trigger),
				detail: { for: scheduled.trigger.targetName, kind: "schedule" },
			});
			return { trigger: { ...scheduled.trigger, url: null }, secret: null };
		}
		const made = await found.registry.createTrigger(data.trigger, found.member.user.id);
		if ("status" in made) throw new Error(made.message);
		await found.audit({
			action: "trigger.created",
			target: triggerTarget(made.trigger),
			detail: { for: made.trigger.targetName },
		});
		return { trigger: { ...made.trigger, url: found.urlOf(made.trigger.id) }, secret: made.secret };
	});

export const updateTrigger = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triggerId: id, patch: triggerPatch }))
	.handler(async ({ data }): Promise<Trigger> => {
		const found = await requireAdmin(data.slug);
		const updated = await found.registry.updateTrigger(data.triggerId, data.patch);
		if (!updated) throw new Error("This trigger was deleted");
		await found.audit({
			action: "trigger.updated",
			target: triggerTarget(updated),
			detail: {
				fields: Object.keys(data.patch)
					.filter((field) => field !== "assigneeName")
					.sort(),
				...(data.patch.active !== undefined && { active: data.patch.active }),
			},
		});
		return updated;
	});

export const deleteTrigger = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triggerId: id }))
	.handler(async ({ data }): Promise<boolean> => {
		const found = await requireAdmin(data.slug);
		const trigger = (await found.registry.listTriggers()).find(
			(candidate) => candidate.id === data.triggerId,
		);
		const deleted = await found.registry.deleteTrigger(data.triggerId);
		if (deleted && trigger) {
			await found.audit({
				action: "trigger.deleted",
				target: triggerTarget(trigger),
				detail: { for: trigger.targetName },
			});
		}
		return deleted;
	});

/** A new secret for the trigger: one made here, or with `secret`, the sender's own. */
export const replaceTriggerSecret = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), triggerId: id, secret: triggerSecret.optional() }))
	.handler(async ({ data }): Promise<TriggerSecretShown> => {
		const found = await requireAdmin(data.slug);
		const replaced = await found.registry.replaceTriggerSecret(data.triggerId, data.secret);
		if (!replaced) throw new Error("This trigger was deleted");
		if ("status" in replaced) throw new Error(replaced.message);
		await found.audit({
			action: "trigger.secretReplaced",
			target: triggerTarget(replaced.trigger),
			detail: { own: data.secret !== undefined },
		});
		return {
			trigger: { ...replaced.trigger, url: found.urlOf(replaced.trigger.id) },
			secret: replaced.secret,
		};
	});
