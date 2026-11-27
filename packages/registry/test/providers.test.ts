import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryDO } from "../src";
import { listProviderModels } from "../src/providers";
import { SEALED_COLUMNS } from "../src/sealed";
import { type Sealer, type SecretsEnv, sealerFor, secretsProblem } from "../src/secrets";

const SECRETS_KEY = "dGVzdC1vbmx5LXNlY3JldHMta2V5LXRlc3Qtb25seS0=";
/** The test Worker's BETTER_AUTH_SECRET (wrangler.jsonc beside this file); it signs nothing. */
const AUTH_SECRET = "test-only-auth-secret-that-signs-nothing-0123";
const KEY = "sk-ant-api03-correct-horse-battery-staple";
/**
 * `KEY`, sealed for "workspace-a" at "provider-keys/anthropic" under `SECRETS_KEY` by the code of
 * v0.27.2 (ab95cdc), before a server could seal without a SECRETS_KEY. Never regenerate it: it
 * stands for every value a deployment already holds.
 */
const SEALED_BY_V0_27_2 =
	"v1.HqdvlaBm1Kxk_Y5W.udbWwsy0pMuAH2ovbEtl-Kr8NdiNMiLXmKxDbfNZ4CyEUowJVnPYMu-jAj63-EQy__FhPtXbzY9F";
/** The same, sealed under the key derived from `AUTH_SECRET` by the first code that had one. */
const SEALED_BY_DERIVED_KEY =
	"d1.gQSsmQ4-nEJjogZX.HB-fS4eGqlqBafJZSeEZM0DbMTOj1XGgy_IF5fE2ETLiZMSjGSJkgl8uCP9HhJuann7jaOD9VkDE";

async function usable(env: SecretsEnv, scope: string): Promise<Sealer> {
	const sealer = await sealerFor(env, scope);
	if ("unavailable" in sealer) throw new Error(sealer.unavailable);
	return sealer;
}

/**
 * Opens a value the way v0.27.2 did, written out here rather than imported, so that it cannot
 * change with the code under test.
 */
async function openAsReleased(
	secretsKey: string,
	scope: string,
	place: string,
	sealed: string,
): Promise<string> {
	const bytes = (text: string) =>
		Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
	const [version = "", iv = "", data = ""] = sealed.split(".");
	expect(version).toBe("v1");
	const base = await crypto.subtle.importKey("raw", bytes(secretsKey), "HKDF", false, [
		"deriveKey",
	]);
	const key = await crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new TextEncoder().encode("gateweave-agents/secrets/v1"),
			info: new TextEncoder().encode(scope),
		},
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes(iv), additionalData: new TextEncoder().encode(place) },
		key,
		bytes(data),
	);
	return new TextDecoder().decode(plaintext);
}

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
		// The data's first character: every one of its bits counts, unlike the last one's, whose
		// spare bits decode to nothing.
		const [version, iv, data = ""] = sealed.split(".");
		const changed = `${version}.${iv}.${data.startsWith("A") ? "B" : "A"}${data.slice(1)}`;
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

	it("open a value the released code sealed with SECRETS_KEY, with or without the other secret", async () => {
		for (const env of [{ SECRETS_KEY }, { SECRETS_KEY, BETTER_AUTH_SECRET: AUTH_SECRET }]) {
			const sealer = await usable(env, "workspace-a");
			expect(await sealer.open("provider-keys/anthropic", SEALED_BY_V0_27_2)).toBe(KEY);
		}
	});

	it("seal with SECRETS_KEY exactly as before, whatever the other secret is", async () => {
		for (const env of [{ SECRETS_KEY }, { SECRETS_KEY, BETTER_AUTH_SECRET: AUTH_SECRET }]) {
			const sealed = await (await usable(env, "workspace-a")).seal("provider-keys/anthropic", KEY);
			expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
			expect(
				await openAsReleased(SECRETS_KEY, "workspace-a", "provider-keys/anthropic", sealed),
			).toBe(KEY);
		}
	});

	it("seal under a key from BETTER_AUTH_SECRET on a server without a SECRETS_KEY", async () => {
		const sealer = await usable({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		const sealed = await sealer.seal("provider-keys/anthropic", KEY);
		expect(sealed).toMatch(/^d1\.[\w-]{16}\.[\w-]+$/);
		expect(sealed).not.toContain("correct-horse");
		expect(await sealer.open("provider-keys/anthropic", sealed)).toBe(KEY);
		// The derivation is pinned: changing its label would orphan every value sealed this way.
		expect(await sealer.open("provider-keys/anthropic", SEALED_BY_DERIVED_KEY)).toBe(KEY);

		await expect(sealer.open("provider-keys/openai", sealed)).rejects.toThrow(
			"A secret could not be opened",
		);
		const other = await usable({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-b");
		await expect(other.open("provider-keys/anthropic", sealed)).rejects.toThrow();
	});

	it("derive a key of their own, not the one the same bytes give as a SECRETS_KEY", async () => {
		const derived = await usable({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		const [, iv, data] = (await derived.seal("provider-keys/anthropic", KEY)).split(".");
		const explicit = await usable({ SECRETS_KEY: btoa(AUTH_SECRET) }, "workspace-a");
		await expect(explicit.open("provider-keys/anthropic", `v1.${iv}.${data}`)).rejects.toThrow(
			"A secret could not be opened",
		);
	});

	it("still open what the derived key sealed once a SECRETS_KEY is set, and seal with that", async () => {
		const before = await usable({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		const old = await before.seal("provider-keys/anthropic", KEY);
		const after = await usable({ SECRETS_KEY, BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		expect(await after.open("provider-keys/anthropic", old)).toBe(KEY);
		const fresh = await after.seal("provider-keys/anthropic", KEY);
		expect(fresh.startsWith("v1.")).toBe(true);
		// A server with only the SECRETS_KEY opens it: nothing of the derived key is in it.
		expect(
			await (await usable({ SECRETS_KEY }, "workspace-a")).open("provider-keys/anthropic", fresh),
		).toBe(KEY);
	});

	it("say that a value cannot be opened after BETTER_AUTH_SECRET changed, and leak nothing", async () => {
		const before = await usable({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		const old = await before.seal("provider-keys/anthropic", KEY);
		const rotated = "another-secret-that-signs-sessions-0123456789";
		for (const env of [
			{ BETTER_AUTH_SECRET: rotated },
			{ SECRETS_KEY, BETTER_AUTH_SECRET: rotated },
			{ SECRETS_KEY },
		]) {
			const sealer = await usable(env, "workspace-a");
			const failure = await sealer.open("provider-keys/anthropic", old).then(
				() => null,
				(error: Error) => error.message,
			);
			expect(failure).toMatch(/^A secret could not be opened/);
			expect(failure).not.toContain(rotated);
			expect(failure).not.toContain(AUTH_SECRET);
		}
		// And the other way round: a value sealed with a SECRETS_KEY that was taken away.
		await expect(before.open("provider-keys/anthropic", SEALED_BY_V0_27_2)).rejects.toThrow(
			"it was sealed with a SECRETS_KEY, and this server has none",
		);
	});

	it("never pass over a SECRETS_KEY that is set but unusable for the derived key", async () => {
		expect(
			await sealerFor({ SECRETS_KEY: btoa("too short"), BETTER_AUTH_SECRET: AUTH_SECRET }, "w"),
		).toEqual({ unavailable: "SECRETS_KEY must hold at least 32 bytes" });
		expect(
			await sealerFor({ SECRETS_KEY: "not base64!", BETTER_AUTH_SECRET: AUTH_SECRET }, "w"),
		).toEqual({ unavailable: "Secrets are not set up on this server (SECRETS_KEY)" });
	});

	it("derive no key from a BETTER_AUTH_SECRET that is short or plainly not random", async () => {
		const weak = {
			kind: "server",
			message:
				"Secrets are not set up on this server: its BETTER_AUTH_SECRET is too short or too simple to encrypt them with. Set one that was generated (openssl rand -base64 32), or set a SECRETS_KEY",
		};
		for (const typed of [
			"a".repeat(32),
			"password".repeat(4),
			" ".repeat(32),
			// Random, and one character short.
			"Zk3vQ8mN1xT6bR0yL5cW9dJ2hF7gS4p",
		]) {
			expect(secretsProblem({ BETTER_AUTH_SECRET: typed })).toEqual(weak);
			expect(await sealerFor({ BETTER_AUTH_SECRET: typed }, "workspace")).toEqual({
				unavailable: weak.message,
			});
			// Nor does a server with a SECRETS_KEY open with such a key what it may once have sealed.
			const sealer = await usable({ SECRETS_KEY, BETTER_AUTH_SECRET: typed }, "workspace-a");
			await expect(sealer.open("provider-keys/anthropic", SEALED_BY_DERIVED_KEY)).rejects.toThrow(
				"A secret could not be opened",
			);
		}
		// What `openssl rand -base64 32` and `openssl rand -hex 32` give.
		expect(
			secretsProblem({ BETTER_AUTH_SECRET: "q0V7mJr4yXc1L9uT2bWnEoZ5aGd8sKfH3iPqRt6vUwY=" }),
		).toBeNull();
		expect(
			secretsProblem({
				BETTER_AUTH_SECRET: "9f2c4e7a1b8d0563f4a9c2e1d7b8a0356c9e4f1a2b7d8c0e5f3a6b9d1c4e7f20",
			}),
		).toBeNull();
		expect(secretsProblem({ SECRETS_KEY })).toBeNull();
		expect(secretsProblem({})).toEqual({
			kind: "server",
			message: "Secrets are not set up on this server (SECRETS_KEY)",
		});
	});

	it("keep nothing new for a workspace whose values a SECRETS_KEY sealed that is gone", async () => {
		const lost = {
			kind: "lost-key",
			message:
				"Values here were sealed with a SECRETS_KEY that this server no longer has; put it back",
		};
		expect(secretsProblem({ BETTER_AUTH_SECRET: AUTH_SECRET }, true)).toEqual(lost);
		expect(await sealerFor({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a", true)).toEqual({
			unavailable: lost.message,
		});
		// With the key back, or for a workspace that holds no such value, nothing is wrong.
		expect(secretsProblem({ SECRETS_KEY, BETTER_AUTH_SECRET: AUTH_SECRET }, true)).toBeNull();
		expect(secretsProblem({ BETTER_AUTH_SECRET: AUTH_SECRET }, false)).toBeNull();
	});

	it("derive no key on a server that turned that off", async () => {
		for (const off of ["off", " OFF "]) {
			const env = { BETTER_AUTH_SECRET: AUTH_SECRET, SECRETS_FROM_AUTH_SECRET: off };
			expect(await sealerFor(env, "workspace-a")).toEqual({
				unavailable: "Secrets are not set up on this server (SECRETS_KEY)",
			});
			// With a SECRETS_KEY it seals with that, and opens nothing the derived key sealed.
			const sealer = await usable({ ...env, SECRETS_KEY }, "workspace-a");
			expect((await sealer.seal("provider-keys/anthropic", KEY)).startsWith("v1.")).toBe(true);
			await expect(sealer.open("provider-keys/anthropic", SEALED_BY_DERIVED_KEY)).rejects.toThrow(
				"which this server does not use",
			);
			expect(sealer.renews(SEALED_BY_DERIVED_KEY)).toBe(true);
		}
		// Any other value leaves it on.
		expect(
			secretsProblem({ BETTER_AUTH_SECRET: AUTH_SECRET, SECRETS_FROM_AUTH_SECRET: "on" }),
		).toBeNull();
	});

	it("ask for a value to be sealed again only when a SECRETS_KEY can take over from the derived key", async () => {
		const both = await usable({ SECRETS_KEY, BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		expect(both.renews(SEALED_BY_DERIVED_KEY)).toBe(true);
		expect(both.renews(SEALED_BY_V0_27_2)).toBe(false);
		const derived = await usable({ BETTER_AUTH_SECRET: AUTH_SECRET }, "workspace-a");
		expect(derived.renews(SEALED_BY_DERIVED_KEY)).toBe(false);
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

	it("keep model-key caps independently of any provider key", async () => {
		const stub = registry();
		expect(await stub.getModelKeyCaps()).toEqual({ dailyCap: null, monthlyCap: null });
		await stub.setModelKeyCaps({ daily: "1", monthly: "20" });
		expect(await stub.getModelKeyCaps()).toEqual({ dailyCap: "1", monthlyCap: "20" });
		await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
		expect(await stub.getModelKeyCaps()).toEqual({ dailyCap: "1", monthlyCap: "20" });
	});

	/** Puts a key sealed under the key derived from `authSecret` where the workspace keeps OpenAI's. */
	async function storeSealedByDerivedKey(stub: ReturnType<typeof registry>, authSecret: string) {
		await stub.saveProviderKey({ provider: "openai", key: "sk-proj-placeholder" }, "Ada");
		await runInDurableObject(stub, async (_instance: RegistryDO, state) => {
			const sealer = await usable({ BETTER_AUTH_SECRET: authSecret }, state.id.toString());
			const sealed = await sealer.seal("provider-keys/openai", "sk-proj-sealed-before-the-key");
			state.storage.sql.exec("UPDATE provider_keys SET sealed = ?", sealed);
		});
	}

	it("sealed before the server had a SECRETS_KEY still open once it has one", async () => {
		const stub = registry();
		await storeSealedByDerivedKey(stub, AUTH_SECRET);
		const { fetcher, requests } = provider({
			"https://api.openai.com/v1/models": { data: [{ id: "gpt-a" }] },
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetcher);
		expect(await stub.checkProviderKey("openai")).toMatchObject({
			check: { ok: true, models: 1 },
		});
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-proj-sealed-before-the-key");

		// A key saved now is sealed with the SECRETS_KEY.
		await stub.saveProviderKey({ provider: "openai", key: "sk-proj-abcdefgh" }, "Ada");
		const stored = await runInDurableObject(stub, (_instance: RegistryDO, state) =>
			state.storage.sql.exec("SELECT sealed FROM provider_keys").toArray(),
		);
		expect(String(stored[0]?.sealed)).toMatch(/^v1\./);
	});

	it("sealed by the derived key are sealed again with the SECRETS_KEY when they are used", async () => {
		const stub = registry();
		await storeSealedByDerivedKey(stub, AUTH_SECRET);
		expect(await stub.sealedCounts()).toEqual({ explicit: 0, derived: 1 });
		vi.spyOn(globalThis, "fetch").mockImplementation(
			provider({ "https://api.openai.com/v1/models": { data: [{ id: "gpt-a" }] } }).fetcher,
		);
		// The check is kept, so it was recorded against the value that is stored now.
		expect(await stub.checkProviderKey("openai")).toMatchObject({ check: { ok: true } });
		expect(await stub.sealedCounts()).toEqual({ explicit: 1, derived: 0 });

		// What is stored opens with the SECRETS_KEY alone, to the same key.
		const sealed = await runInDurableObject(stub, async (_instance: RegistryDO, state) => {
			const row = state.storage.sql.exec("SELECT sealed FROM provider_keys").one();
			const alone = await usable({ SECRETS_KEY }, state.id.toString());
			return {
				sealed: String(row.sealed),
				opened: await alone.open("provider-keys/openai", String(row.sealed)),
			};
		});
		expect(sealed.sealed).toMatch(/^v1\./);
		expect(sealed.opened).toBe("sk-proj-sealed-before-the-key");

		// Used again, it is left as it is.
		await stub.checkProviderKey("openai");
		const again = await runInDurableObject(stub, (_instance: RegistryDO, state) =>
			state.storage.sql.exec("SELECT sealed FROM provider_keys").one(),
		);
		expect(again.sealed).toBe(sealed.sealed);
	});

	it("list every column the schema seals into, for counting and sealing again", async () => {
		const columns = await runInDurableObject(registry(), (_instance: RegistryDO, state) =>
			state.storage.sql
				.exec<{ name: string; sql: string }>(
					"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE '%sealed%'",
				)
				.toArray()
				.flatMap(({ name, sql }) =>
					[...sql.matchAll(/`(sealed\w*)`/g)].map((match) => `${name}.${match[1]}`),
				),
		);
		expect(columns.sort()).toEqual(
			SEALED_COLUMNS.map(([table, column]) => `${table}.${column}`).sort(),
		);
	});

	describe("on a server whose SECRETS_KEY is gone", () => {
		const lost =
			"Values here were sealed with a SECRETS_KEY that this server no longer has; put it back";
		const withoutKey = () => env.REGISTRY_WITHOUT_KEY.getByName(crypto.randomUUID());

		/** A key the SECRETS_KEY sealed, as the workspace stored it while the server had one. */
		async function storeSealedWithKey(stub: ReturnType<typeof withoutKey>) {
			await runInDurableObject(stub, async (instance: RegistryDO, state) => {
				// Wakes the registry, so its tables exist.
				await instance.listProviderKeys();
				const sealer = await usable({ SECRETS_KEY }, state.id.toString());
				state.storage.sql.exec(
					"INSERT INTO provider_keys (provider, sealed, hint, added_by, added_at) VALUES ('openai', ?, 'efgh', 'Ada', 1)",
					await sealer.seal("provider-keys/openai", "sk-proj-abcdefgh"),
				);
			});
		}

		it("keeps secrets under the derived key while it holds nothing the key sealed", async () => {
			const stub = withoutKey();
			expect(await stub.secretsState()).toBeNull();
			await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada");
			expect(await stub.sealedCounts()).toEqual({ explicit: 0, derived: 1 });
		});

		it("refuses to save, seals nothing under the derived key, and names the cause", async () => {
			const stub = withoutKey();
			await storeSealedWithKey(stub);
			expect(await stub.secretsState()).toEqual({ kind: "lost-key", message: lost });

			const refused = { status: "refused", message: lost };
			expect(await stub.saveProviderKey({ provider: "anthropic", key: KEY }, "Ada")).toEqual(
				refused,
			);
			const assetId = await stub.createEnvSet({ name: "prod", variables: {}, secrets: ["TOKEN"] });
			expect(await stub.setEnvSecret({ assetId, name: "TOKEN", value: "t" }, "Ada")).toEqual(
				refused,
			);
			// Using what it holds says the same, not "add it again", and asks the provider nothing.
			const fetched = vi.spyOn(globalThis, "fetch");
			expect(await stub.checkProviderKey("openai")).toEqual(refused);
			expect(fetched).not.toHaveBeenCalled();
			expect(await stub.sealedCounts()).toEqual({ explicit: 1, derived: 0 });
		});

		it("keeps secrets again once what the lost key sealed is removed", async () => {
			const stub = withoutKey();
			await storeSealedWithKey(stub);
			expect(await stub.removeProviderKey("openai")).toBe(true);
			expect(await stub.secretsState()).toBeNull();
			expect(
				await stub.saveProviderKey({ provider: "openai", key: "sk-proj-abcdefgh" }, "Ada"),
			).toMatchObject({ hint: "efgh" });
			expect(await stub.sealedCounts()).toEqual({ explicit: 0, derived: 1 });
		});
	});

	it("sealed under a BETTER_AUTH_SECRET that changed since are refused in a sentence", async () => {
		const stub = registry();
		await storeSealedByDerivedKey(stub, "the-secret-this-server-had-before-it-was-rotated");
		const fetched = vi.spyOn(globalThis, "fetch");
		expect(await stub.checkProviderKey("openai")).toEqual({
			status: "refused",
			message: "The key for OpenAI cannot be opened on this server; add it again",
		});
		expect(fetched).not.toHaveBeenCalled();
		// Adding it again is all it takes.
		expect(
			await stub.saveProviderKey({ provider: "openai", key: "sk-proj-abcdefgh" }, "Ada"),
		).toMatchObject({
			hint: "efgh",
		});
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

describe("Workers AI has no key", () => {
	it("is refused by every API that takes a key", async () => {
		const stub = registry();
		await expect(
			runInDurableObject(stub, (instance: RegistryDO) =>
				instance.saveProviderKey({ provider: "workers-ai", key: KEY } as never, "Ada"),
			),
		).rejects.toThrow();
		await expect(
			runInDurableObject(stub, (instance: RegistryDO) => instance.checkProviderKey("workers-ai")),
		).rejects.toThrow();
		await expect(
			runInDurableObject(stub, (instance: RegistryDO) => instance.listModels("workers-ai")),
		).rejects.toThrow();
		await expect(
			runInDurableObject(stub, (instance: RegistryDO) =>
				Promise.resolve(instance.removeProviderKey("workers-ai")),
			),
		).rejects.toThrow();
		expect(await stub.listProviderKeys()).toEqual([]);
	});
});
