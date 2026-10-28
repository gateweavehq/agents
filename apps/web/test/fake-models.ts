/**
 * Stands in for the model providers' APIs in Worker tests: it lists models for the keys it was
 * given and refuses any other key, the way each provider answers `GET .../models`.
 */
import type { ModelProvider } from "@gateweave/agents-model";

export const MODEL_HOSTS: Record<string, ModelProvider> = {
	"api.anthropic.com": "anthropic",
	"api.openai.com": "openai",
	"generativelanguage.googleapis.com": "google",
};

export class FakeModels {
	/** Every request it answered, for checking where keys went. */
	readonly requests: { url: string; headers: Headers }[] = [];
	readonly #keys: Map<string, { provider: ModelProvider; models: string[] }>;

	constructor(keys: Record<string, { provider: ModelProvider; models: string[] }>) {
		this.#keys = new Map(Object.entries(keys));
	}

	handle(request: Request): Response {
		this.requests.push({ url: request.url, headers: new Headers(request.headers) });
		const provider = MODEL_HOSTS[new URL(request.url).host];
		const key =
			provider === "anthropic"
				? request.headers.get("x-api-key")
				: provider === "google"
					? request.headers.get("x-goog-api-key")
					: request.headers.get("authorization")?.replace(/^Bearer /, "");
		const known = key ? this.#keys.get(key) : undefined;
		if (!provider || !known || known.provider !== provider) {
			return Response.json(
				{ error: { message: `Incorrect API key provided: ${key}` } },
				{ status: 401 },
			);
		}
		if (provider === "google") {
			return Response.json({
				models: known.models.map((id) => ({
					name: `models/${id}`,
					displayName: id,
					supportedGenerationMethods: ["generateContent"],
				})),
			});
		}
		return Response.json({
			data: known.models.map((id, index) => ({ id, display_name: id, created: index })),
			has_more: false,
		});
	}
}
