/**
 * Connecting Gateweave Track in one step, for owners and admins (AGT-119): the server function
 * that checks what can be checked before the browser leaves, and answers with Track's approval
 * page. The flow's other half is `/api/track/connected` (`server/track-connect.ts`).
 */
import {
	isKeyedProvider,
	providerMissing,
	sandboxOfferTo,
	trackConnectInput,
} from "@gateweave/agents-model";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const beginTrackConnect = createServerFn({ method: "POST" })
	.validator(z.object({ slug: z.string().min(1), connect: trackConnectInput }))
	.handler(async ({ data }): Promise<string> => {
		// On the demo, before the visitor's address is given a challenge and a webhook URL.
		const { demoEnabled, OFF_IN_DEMO } = await import("#/server/demo/mode");
		if (demoEnabled()) throw new Error(OFF_IN_DEMO);
		const [{ currentMember }, { isAdmin }, { registryFor }, { appOrigin }, { env }] =
			await Promise.all([
				import("#/server/access"),
				import("#/lib/roles"),
				import("#/server/registry"),
				import("#/server/origin"),
				import("cloudflare:workers"),
			]);
		const member = await currentMember(data.slug);
		if (!member) throw new Error("Workspace not found");
		if (!isAdmin(member.membership.role)) throw new Error("Only admins can do this");
		const { workspaceId } = member.membership;
		const registry = registryFor(member.membership);
		const { provider } = data.connect;

		// The provider must be one an agent can answer with now: the registry applies the engine's
		// rules and the repository's, but it does not know what the server offers.
		if (isKeyedProvider(provider)) {
			const keys = await registry.listProviderKeys();
			if (!keys.some((key) => key.provider === provider)) {
				throw new Error(`${providerMissing(provider)}. Add one in Settings first.`);
			}
		} else {
			const { workersAiOffer } = await import("#/server/workers-ai");
			if (workersAiOffer(workspaceId) !== "offered") {
				throw new Error(`${providerMissing(provider)}.`);
			}
		}
		if (data.connect.purpose === "work" && sandboxOfferTo(env, workspaceId) !== "offered") {
			throw new Error("This server does not run sandboxes for this workspace.");
		}

		const { beginConnect } = await import("#/server/track-connect");
		return beginConnect(member, registry, data.connect, appOrigin());
	});
