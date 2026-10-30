/**
 * The model behind a turn: the agent's provider and model, called with the workspace's key for
 * that provider (Workers AI needs none: see below). When the deployment names an AI Gateway
 * (`AI_GATEWAY_URL`), every call goes through it, for its logs, caching and rate limits; the
 * workspace's key still rides along on each request, so the gateway needs no keys of its own.
 * Without one, calls go straight to the provider.
 *
 * The gateway is reached by URL rather than through an `AI` binding: a binding is always remote,
 * so local development and tests would need a Cloudflare account to run at all.
 *
 * Workers AI is the exception: it is paid by the deployment, not the workspace, so it is called
 * with the server's own `WORKERS_AI_TOKEN` and never a workspace key, and only when the server
 * offers it. It goes by Cloudflare's OpenAI-compatible REST API (chat completions at
 * `/accounts/<account>/ai/v1`) whether or not a gateway is set; with one, the request names it in
 * `cf-aig-gateway-id`, and the gateway logs it like the others.
 *
 * Gateway paths, checked 2026-10-28:
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/openai/
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/
 * - https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/ (checked 2026-10-29)
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	type AgentSnapshot,
	isKeyedProvider,
	type KeyedProvider,
	MODEL_PROVIDER_NAMES,
	parseGatewayUrl,
	providerMissing,
	WORKERS_AI_NOT_OFFERED,
	type WorkersAiSettings,
	workersAiAccount,
	workersAiBaseUrl,
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

/** Where each provider's API sits behind the gateway, as the provider's SDK wants its base URL. */
const GATEWAY_PATHS: Record<KeyedProvider, string> = {
	anthropic: "anthropic/v1",
	openai: "openai",
	google: "google-ai-studio/v1beta",
};

/** A setting that is wrong, with a message fit to show whoever is chatting. */
export class SettingsError extends Error {}

/** The deployment's AI Gateway and its parts; null when it names none. */
export function gatewayOf(settings: GatewaySettings) {
	const gateway = settings.AI_GATEWAY_URL?.replace(/\/+$/, "");
	if (gateway === undefined || gateway === "") return null;
	const parts = parseGatewayUrl(gateway);
	if (!parts) {
		throw new SettingsError(
			"This server's AI_GATEWAY_URL is not an AI Gateway address, so no agent can answer",
		);
	}
	return { url: gateway, ...parts };
}

/** What the gateway logs about a request, and how it knows it may take it. */
function gatewayHeadersOf(
	settings: GatewaySettings,
	metadata: GatewayMetadata,
): Record<string, string> {
	return {
		"cf-aig-metadata": JSON.stringify(metadata),
		...(settings.AI_GATEWAY_TOKEN
			? { "cf-aig-authorization": `Bearer ${settings.AI_GATEWAY_TOKEN}` }
			: {}),
	};
}

export function languageModel(
	agent: AgentSnapshot,
	key: string | null,
	settings: GatewaySettings & WorkersAiSettings,
	metadata: GatewayMetadata,
): LanguageModel {
	const parts = gatewayOf(settings);
	const gateway = parts?.url;
	const gatewayHeaders = gatewayHeadersOf(settings, metadata);
	if (!isKeyedProvider(agent.provider)) {
		// The registry refuses the turn up front on a server without these; this is the backstop.
		const account = workersAiAccount(settings);
		if (!settings.WORKERS_AI_TOKEN || account === null) {
			throw new SettingsError(WORKERS_AI_NOT_OFFERED);
		}
		return createOpenAICompatible({
			name: agent.provider,
			baseURL: workersAiBaseUrl(account),
			apiKey: settings.WORKERS_AI_TOKEN,
			// Each streamed chunk then carries usage; the last one carries the totals.
			includeUsage: true,
			...(parts ? { headers: { "cf-aig-gateway-id": parts.gateway, ...gatewayHeaders } } : {}),
		})(agent.model);
	}
	if (key === null)
		throw new SettingsError(`${providerMissing(agent.provider)}, so no agent can answer`);
	const through = parts
		? { baseURL: `${gateway}/${GATEWAY_PATHS[agent.provider]}`, headers: gatewayHeaders }
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
 * A request Claude Code sent to Anthropic from a sandbox (`./claude-code.ts`), as it leaves the
 * Worker: with the workspace's key in place of the placeholder the sandbox holds, and through AI
 * Gateway when the deployment names one, as Gateweave's own requests go.
 */
export function anthropicRequest(
	request: Request,
	key: string,
	settings: GatewaySettings,
	metadata: GatewayMetadata,
): Request {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	headers.delete("authorization");
	headers.set("x-api-key", key);
	const parts = gatewayOf(settings);
	if (parts) {
		for (const [name, value] of Object.entries(gatewayHeadersOf(settings, metadata))) {
			headers.set(name, value);
		}
	}
	// The gateway's path for Anthropic ends where the API's own begins, at /v1.
	const target = parts ? `${parts.url}/anthropic${url.pathname}${url.search}` : url.href;
	return new Request(target, {
		method: request.method,
		headers,
		body: request.body,
		redirect: "manual",
	});
}

/** A request Codex sent to OpenAI from a sandbox (`./codex.ts`), as `anthropicRequest` does. */
export function openaiRequest(
	request: Request,
	key: string,
	settings: GatewaySettings,
	metadata: GatewayMetadata,
): Request {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	headers.set("authorization", `Bearer ${key}`);
	const parts = gatewayOf(settings);
	if (parts) {
		for (const [name, value] of Object.entries(gatewayHeadersOf(settings, metadata))) {
			headers.set(name, value);
		}
	}
	// The gateway's path for OpenAI stands for the API's /v1.
	const target = parts
		? `${parts.url}/openai${url.pathname.replace(/^\/v1(?=\/)/, "")}${url.search}`
		: url.href;
	return new Request(target, {
		method: request.method,
		headers,
		body: request.body,
		redirect: "manual",
	});
}

/**
 * A request OpenCode sent to Google from a sandbox (`./opencode.ts`), as `anthropicRequest` does:
 * the key goes in `x-goog-api-key`, where `@ai-sdk/google` puts it too.
 */
export function googleRequest(
	request: Request,
	key: string,
	settings: GatewaySettings,
	metadata: GatewayMetadata,
): Request {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	headers.delete("authorization");
	headers.set("x-goog-api-key", key);
	const parts = gatewayOf(settings);
	if (parts) {
		for (const [name, value] of Object.entries(gatewayHeadersOf(settings, metadata))) {
			headers.set(name, value);
		}
	}
	// The gateway's path for Google ends where the API's own begins, at /v1beta (`GATEWAY_PATHS`).
	const target = parts ? `${parts.url}/google-ai-studio${url.pathname}${url.search}` : url.href;
	return new Request(target, {
		method: request.method,
		headers,
		body: request.body,
		redirect: "manual",
	});
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
	if (!isKeyedProvider(agent.provider)) {
		// The deployment's token and account are the server's to fix, not the workspace's.
		if (status === 401 || status === 403) {
			return `${name} refused this server's token. Whoever runs the server can check WORKERS_AI_TOKEN.`;
		}
		if (status === 404) return `${name} has no model ${agent.model}.`;
		if (status === 429) return `${name} is limiting this server's requests. Try again shortly.`;
		if (status !== undefined && status >= 500) {
			return `${name} could not answer just now. Try again shortly.`;
		}
		return `${name} could not answer.`;
	}
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
