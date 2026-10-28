import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";
import { listProviderModels } from "../src/providers";
import { sealerFor } from "../src/secrets";

const SECRETS_KEY = "dGVzdC1vbmx5LXNlY3JldHMta2V5LXRlc3Qtb25seS0=";
const KEY = "sk-ant-api03-correct-horse-battery-staple";

const registry = () => env.REGISTRY.getByName(crypto.randomUUID());

afterEach(() => {
	vi.restoreAllMocks();
});

/** A fake provider API: each URL it knows answers with its JSON; anything else is a 404. */
function provider(pages: Record<string, unknown>, status = 200) {
	const requests: { url: string; headers: Headers }[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push({ url, headers: new Headers(init?.headers) });
		const page = pages[url];
		if (page === undefined) return new Response("Not found", { status: 404 });
		return Response.json(page, { status });
	};
	return { fetcher: fetcher as typeof fetch, requests };
}

describe("secrets", () => {
	it("seal for one workspace and one place, and open only there", async () => {
		const sealer = await sealerFor({ SECRETS_KEY }, "workspace-a");
		if ("unavailable" in sealer) throw new Error(sealer.unavailable);
		const sealed = await sealer.seal("provider-keys/anthropic", KEY);
		expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
		expect(sealed).not.toContain("correct-horse");
		expect(await sealer.seal("provider-keys/anthropic", KEY)).not.toBe(sealed);
		expect(await sealer.open("provider-keys/anthropic", sealed)).toBe(KEY);

		await expect(sealer.open("provider-keys/openai", sealed)).rejects.toThrow(
			"A secret could not be opened",
		);
		const other = await sealerFor({ SECRETS_KEY }, "workspace-b");
		if ("unavailable" in other) throw new Error(other.unavailable);
		await expect(other.open("provider-keys/anthropic", sealed)).rejects.toThrow();
		const changed = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}A`;
		await expect(sealer.open("provider-keys/anthropic", changed)).rejects.toThrow();
		await expect(sealer.open("provider-keys/anthropic", "v2.abc.def")).rejects.toThrow();
	});

	it("are unavailable without a key of 32 bytes or more", async () => {
		expect(await sealerFor({}, "workspace")).toEqual({
			unavailable: "Secrets are not set up on this server (SECRETS_KEY)",
		});
		expect(await sealerFor({ SECRETS_KEY: btoa("too short") }, "workspace")).toEqual({
			unavailable: "SECRETS_KEY must hold at least 32 bytes",
		});
		expect(await sealerFor({ SECRETS_KEY: "not base64!" }, "workspace")).toHaveProperty(
			"unavailable",
		);
	});
});

describe("listing a provider's models", () => {
	it("reads every page of Anthropic's, with the key in a header", async () => {
		const { fetcher, requests } = provider({
			"https://api.anthropic.com/v1/models?limit=1000": {
				data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }],
				has_more: true,
				last_id: "claude-opus-5-5",
			},
			"https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5": {
				data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }],
				has_more: false,
				last_id: "claude-haiku-5-5",
			},
		});
		expect(await listProviderModels("anthropic", KEY, fetcher)).toEqual({
			ok: true,
			models: [
				{ id: "claude-opus-5-5", name: "Claude Opus 5.5" },
				{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
			],
		});
		expect(requests[0]?.headers.get("x-api-key")).toBe(KEY);
		expect(requests.every(({ url }) => !url.includes(KEY))).toBe(true);
	});

	it("lists OpenAI's newest first", async () => {
		const { fetcher, requests } = provider({
			"https://api.openai.com/v1/models": {
				object: "list",
				data: [
					{ id: "gpt-old", created: 1 },
					{ id: "gpt-new", created: 2 },
				],
			},
		});
		expect(await listProviderModels("openai", "sk-proj-abcdefgh", fetcher)).toEqual({
			ok: true,
			models: [
				{ id: "gpt-new", name: "gpt-new" },
				{ id: "gpt-old", name: "gpt-old" },
			],
		});
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-proj-abcdefgh");
	});

	it("keeps only Google's models that can chat, and keeps the key out of the URL", async () => {
		const { fetcher, requests } = provider({
			"https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000": {
				models: [
					{
						name: "models/gemini-pro",
						displayName: "Gemini Pro",
						supportedGenerationMethods: ["generateContent", "countTokens"],
					},
					{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
				],
				nextPageToken: "",
			},
		});
		expect(await listProviderModels("google", "AIzaabcdefgh", fetcher)).toEqual({
			ok: true,
			models: [{ id: "gemini-pro", name: "Gemini Pro" }],
		});
		expect(requests[0]?.headers.get("x-goog-api-key")).toBe("AIzaabcdefgh");
		expect(requests[0]?.url).not.toContain("AIza");
	});

	it("says why in the app's words, never the provider's", async () => {
		const refused = provider(
			{
				"https://api.openai.com/v1/models": { error: { message: "Incorrect key sk-proj-ab***gh" } },
			},
			401,
		);
		expect(await listProviderModels("openai", "sk-proj-abcdefgh", refused.fetcher)).toEqual({
			ok: false,
			message: "OpenAI refused the key",
		});
		const limited = provider({ "https://api.openai.com/v1/models": {} }, 429);
		expect(await listProviderModels("openai", "sk-proj-abcdefgh", limited.fetcher)).toEqual({
			ok: false,
			message: "OpenAI is limiting requests for this key; try again later",
		});
		const down = provider({ "https://api.openai.com/v1/models": {} }, 503);
		expect(await listProviderModels("openai", "sk-proj-abcdefgh", down.fetcher)).toEqual({
			ok: false,
			message: "OpenAI answered with an error (503)",
		});
		const offline = (async () => {
			throw new TypeError("network down");
		}) as typeof fetch;
		expect(await listProviderModels("google", "AIzaabcdefgh", offline)).toEqual({
			ok: false,
			message: "Could not reach Google",
		});
	});
});

describe("provider keys", () => {
	it("are kept sealed, and shown only by their last four characters", async () => {
		const stub = registry();
		expect(await stub.listProviderKeys()).toEqual([]);
		const saved = await stub.saveProviderKey({ provider: "anthropic", key: ` ${KEY}\n` }, "Ada");
		expect(saved).toEqual({
			provider: "anthropic",
			hint: "aple",
			addedBy: "Ada",
			addedAt: expect.any(Number),
			check: null,
		});
		expect(await stub.listProviderKeys()).toEqual([saved]);
		expect(JSON.stringify(await stub.listProviderKeys())).not.toContain("correct-horse");

		const stored = await runInDurableObject(stub, (_instance: RegistryDO, state) =>
			state.storage.sql.exec("SELECT * FROM provider_keys").toArray(),
		);
		expect(JSON.stringify(stored)).not.toContain("correct-horse");

		await stub.saveProviderKey({ provider: "openai", key: "sk-proj-abcdefgh" }, "Grace");
		expect((await stub.listProviderKeys()).map((key) => key.provider)).toEqual([
			"anthropic",
			"openai",
		]);
		expect(await stub.removeProviderKey("anthropic")).toBe(true);
		expect(await stub.removeProviderKey("anthropic")).toBe(false);
		expect((await stub.listProviderKeys()).map((key) => key.provider)).toEqual(["openai"]);
	});

	it("are checked against the provider, and a new key forgets the old check", async () => {
		const stub = registry();
		expect(await stub.checkProviderKey("openai")).toEqual({
			status: "refused",
			message: "There is no key for OpenAI",
		});

		await stub.saveProviderKey({ provider: "openai", key: "sk-proj-abcdefgh" }, "Ada");
		const { fetcher, requests } = provider({
			"https://api.openai.com/v1/models": { data: [{ id: "gpt-a" }, { id: "gpt-b" }] },
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
		const checked = await stub.checkProviderKey("openai");
		expect(checked).toMatchObject({
			provider: "openai",
			check: { ok: true, message: null, models: 2, checkedAt: expect.any(Number) },
		});
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-proj-abcdefgh");
		expect(await stub.listProviderKeys()).toEqual([checked]);

		vi.spyOn(globalThis, "fetch").mockImplementation(
			provider({ "https://api.openai.com/v1/models": {} }, 401).fetcher,
		);
		expect(await stub.checkProviderKey("openai")).toMatchObject({
			check: { ok: false, message: "OpenAI refused the key", models: null },
		});

		await stub.saveProviderKey({ provider: "openai", key: "sk-proj-ijklmnop" }, "Grace");
		expect(await stub.listProviderKeys()).toEqual([
			expect.objectContaining({ hint: "mnop", addedBy: "Grace", check: null }),
		]);
	});

	it("refuse what is not a key or a provider", async () => {
		const stub = registry();
		await runInDurableObject(stub, async (instance: RegistryDO) => {
			await expect(
				instance.saveProviderKey({ provider: "openai", key: "has spaces in it" }, "Ada"),
			).rejects.toThrow(/no spaces/);
			await expect(
				instance.saveProviderKey({ provider: "mistral" as "openai", key: KEY }, "Ada"),
			).rejects.toThrow();
			expect(() => instance.removeProviderKey("mistral")).toThrow();
		});
		expect(await stub.listProviderKeys()).toEqual([]);
	});
});
