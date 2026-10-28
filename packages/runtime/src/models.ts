/**
 * The model behind a turn: the agent's provider and model, called with the workspace's key for
 * that provider. When the deployment names an AI Gateway (`AI_GATEWAY_URL`), every call goes
 * through it, for its logs, caching and rate limits; the workspace's key still rides along on each
 * request, so the gateway needs no keys of its own. Without one, calls go straight to the
 * provider.
 *
 * The gateway is reached by URL rather than through an `AI` binding: a binding is always remote,
 * so local development and tests would need a Cloudflare account to run at all.
 *
 * Gateway paths, checked 2026-10-28:
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
	type AgentSnapshot,
	MODEL_PROVIDER_NAMES,
	type ModelProvider,
} from "@gateweave/agents-model";
import { APICallError, type LanguageModel, RetryError } from "ai";

/** How a deployment reaches AI Gateway, from its settings. */
export interface GatewaySettings {
	/** `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>`. */
	AI_GATEWAY_URL?: string;
	/** The gateway's token, when it is an authenticated gateway. */
	AI_GATEWAY_TOKEN?: string;
}

/** What the gateway's log records about each request, to find a workspace's or agent's calls. */
export interface GatewayMetadata {
	workspace: string;
	agent: string;
	conversation: string;
}

const GATEWAY_URL = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[\w-]+\/[\w-]+$/;

/** Where each provider's API sits behind the gateway, as the provider's SDK wants its base URL. */
const GATEWAY_PATHS: Record<ModelProvider, string> = {
	anthropic: "anthropic/v1",
	openai: "openai",
	google: "google-ai-studio/v1beta",
};

/** A setting that is wrong, with a message fit to show whoever is chatting. */
export class SettingsError extends Error {}

export function languageModel(
	agent: AgentSnapshot,
	key: string,
	settings: GatewaySettings,
	metadata: GatewayMetadata,
): LanguageModel {
	const gateway = settings.AI_GATEWAY_URL?.replace(/\/+$/, "");
	if (gateway !== undefined && gateway !== "" && !GATEWAY_URL.test(gateway)) {
		throw new SettingsError(
			"This server's AI_GATEWAY_URL is not an AI Gateway address, so no agent can answer",
		);
	}
	const through = gateway
		? {
				baseURL: `${gateway}/${GATEWAY_PATHS[agent.provider]}`,
				headers: {
					"cf-aig-metadata": JSON.stringify(metadata),
					...(settings.AI_GATEWAY_TOKEN
						? { "cf-aig-authorization": `Bearer ${settings.AI_GATEWAY_TOKEN}` }
						: {}),
				},
			}
		: {};
	switch (agent.provider) {
		case "anthropic":
			return createAnthropic({ apiKey: key, ...through })(agent.model);
		case "openai":
			return createOpenAI({ apiKey: key, ...through })(agent.model);
		case "google":
			return createGoogleGenerativeAI({ apiKey: key, ...through })(agent.model);
	}
}

/**
 * Why a turn failed, in words fit for whoever is chatting. Never the provider's own message: some
 * repeat part of the key.
 */
export function describeFailure(agent: AgentSnapshot, error: unknown): string {
	const name = MODEL_PROVIDER_NAMES[agent.provider];
	if (error instanceof SettingsError) return error.message;
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	const status = APICallError.isInstance(cause) ? cause.statusCode : undefined;
	if (status === 401 || status === 403) {
		return `${name} refused the workspace's key. An owner or admin can check it in Settings.`;
	}
	if (status === 404) return `${name} has no model ${agent.model} for the workspace's key.`;
	if (status === 429) return `${name} is limiting the workspace's requests. Try again shortly.`;
	if (status !== undefined && status >= 500) {
		return `${name} could not answer just now. Try again shortly.`;
	}
	return `${name} could not answer.`;
}

/** What a failure may put in the logs: never a message, which could repeat part of the key. */
export function failureForLogs(error: unknown): { error: string; status?: number } {
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	return {
		error: cause instanceof Error ? cause.name : typeof cause,
		...(APICallError.isInstance(cause) && cause.statusCode !== undefined
			? { status: cause.statusCode }
			: {}),
	};
}
