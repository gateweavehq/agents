import type { SandboxBudgetPassed, TriggerTurnOutcome } from "@gateweave/agents-model";
import { RegistryDO as Registry } from "@gateweave/agents-registry";
import { conversationName } from "@gateweave/agents-runtime";
import { getAgentByName } from "agents";
import { mailer } from "./email";
import { sandboxBudgetEmail } from "./email/templates";

/**
 * The workspace's registry as this Worker runs it: the registry package's, which begins a
 * scheduled trigger's run in the runtime's conversation as the trigger gateway does for a webhook
 * (`./triggers.ts`), and emails whoever runs the server about its sandbox budget. The registry
 * package can reach neither on its own.
 */
export class RegistryDO extends Registry {
	protected override async sandboxBudgetPassed(passed: SandboxBudgetPassed): Promise<void> {
		await super.sandboxBudgetPassed(passed);
		const to = this.env.SANDBOX_ALERT_EMAIL?.trim();
		if (!to || !mailer) return;
		await mailer.send({
			to,
			...sandboxBudgetEmail({ ...passed, server: hostOf(this.env.BETTER_AUTH_URL) }),
		});
	}

	protected override async startTriggerTurn(
		conversationId: string,
		text: string,
	): Promise<TriggerTurnOutcome> {
		// Each registry is named for its workspace (`registryFor`).
		const workspaceId = this.ctx.id.name;
		if (!workspaceId) return { runId: null, error: "This registry does not know its workspace" };
		const conversation = await getAgentByName(
			this.env.CONVERSATIONS,
			conversationName(workspaceId, conversationId),
		);
		return conversation.triggerTurn(text);
	}
}

function hostOf(url: string | undefined): string {
	try {
		return url ? new URL(url).host : "this server";
	} catch {
		return "this server";
	}
}
