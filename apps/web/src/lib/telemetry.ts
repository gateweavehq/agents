/**
 * Where the workspace's run traces go over OpenTelemetry. Members see the endpoint, the names of
 * its headers and how the last export went; owners and admins set and remove it. The headers'
 * values go to the registry, sealed, and never come back.
 */
import { type TelemetrySettings, telemetryInput } from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

async function memberOf(slug: string, admin: boolean) {
	const { currentMember } = await import("#/server/access");
	const { isAdmin } = await import("#/lib/roles");
	const member = await currentMember(slug);
	if (!member) return null;
	if (admin && !isAdmin(member.membership.role)) throw new Error("Only admins can do this");
	const [{ registryFor }, { auditFor }] = await Promise.all([
		import("#/server/registry"),
		import("#/server/audit"),
	]);
	return { member, registry: registryFor(member.membership), audit: auditFor(member) };
}

/** The settings, or null when the workspace exports nothing; `member: false` for a non-member. */
export const getTelemetry = createServerFn({ method: "GET" })
	.validator(z.string().min(1))
	.handler(
		async ({
			data: slug,
		}): Promise<{ member: false } | { member: true; settings: TelemetrySettings | null }> => {
			const found = await memberOf(slug, false);
			if (!found) return { member: false };
			return { member: true, settings: await found.registry.getTelemetry() };
		},
	);

export const setTelemetry = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), settings: telemetryInput }))
	.handler(async ({ data }): Promise<TelemetrySettings> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const { name, email } = found.member.user;
		const saved = await found.registry.setTelemetry(data.settings, name || email);
		if ("status" in saved) throw new Error(saved.message);
		const { hostOf } = await import("#/lib/audit-events");
		await found.audit({
			action: "telemetry.set",
			target: { type: "telemetry", id: null, label: hostOf(saved.endpoint) },
		});
		return saved;
	});

export const removeTelemetry = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1) }))
	.handler(async ({ data }): Promise<boolean> => {
		const found = await memberOf(data.slug, true);
		if (!found) throw new Error("Workspace not found");
		const removed = await found.registry.removeTelemetry();
		if (removed) {
			await found.audit({
				action: "telemetry.removed",
				target: { type: "telemetry", id: null, label: null },
			});
		}
		return removed;
	});
