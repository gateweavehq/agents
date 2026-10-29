// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" references are what is under test
import { describe, expect, it } from "vitest";
import {
	agentDefinitionInput,
	type DetectedAgent,
	type DetectedAsset,
	isKeyedProvider,
	KEYED_PROVIDERS,
	MODEL_PROVIDERS,
	mcpServerInput,
	parseGatewayUrl,
	providerKeyInput,
	providerMissing,
	providerMissingShort,
	providerPickerNote,
	repositoryPath,
	runPullRequest,
	scanResult,
	WORKERS_AI_NOT_OFFERED,
	workersAiAccount,
	workersAiBaseUrl,
	workersAiOffered,
} from "../src";

const COMMIT = "a".repeat(40);

function asset(overrides: Partial<DetectedAsset> = {}): DetectedAsset {
	return {
		kind: "instructions",
		key: "CLAUDE.md",
		name: "CLAUDE.md",
		description: null,
		path: "CLAUDE.md",
		files: [{ path: "CLAUDE.md", content: "# Rules\n" }],
		metadata: {},
		...overrides,
	};
}

function agent(overrides: Partial<DetectedAgent> = {}): DetectedAgent {
	return {
		runtime: "claude-code",
		key: "main",
		name: "Claude Code",
		description: null,
		model: null,
		path: null,
		metadata: {},
		assets: ["CLAUDE.md"],
		...overrides,
	};
}

function scan(agents: DetectedAgent[], assets: DetectedAsset[]) {
	return scanResult.safeParse({
		commit: COMMIT,
		scannedAt: 1,
		agents,
		assets,
		problems: [],
		files: [],
	});
}

describe("repositoryPath", () => {
	it("accepts relative paths and refuses anything that leaves the repository", () => {
		for (const path of ["CLAUDE.md", ".claude/skills/review/SKILL.md", ".mcp.json"]) {
			expect(repositoryPath.safeParse(path).success, path).toBe(true);
		}
		for (const path of [
			"",
			"/etc/passwd",
			"../secrets",
			"a/../../b",
			"a//b",
			"a/",
			"./a",
			"a\\b",
		]) {
			expect(repositoryPath.safeParse(path).success, path).toBe(false);
		}
	});
});

describe("scanResult", () => {
	it("accepts agents that read assets from the same scan", () => {
		expect(scan([agent()], [asset()]).success).toBe(true);
	});

	it("refuses an agent that reads an asset the scan does not have", () => {
		const result = scan([agent({ assets: ["AGENTS.md"] })], [asset()]);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["agents", 0, "assets", 0]);
	});

	it("refuses two assets, two agents or two files with the same key", () => {
		expect(scan([], [asset(), asset()]).success).toBe(false);
		expect(scan([agent(), agent()], [asset()]).success).toBe(false);
		const file = { path: "SKILL.md", content: "x" };
		expect(scan([], [asset({ kind: "skill", files: [file, file] })]).success).toBe(false);
		// The same key under another runtime is another agent.
		expect(scan([agent(), agent({ runtime: "codex" })], [asset()]).success).toBe(true);
	});

	it("takes a file by its blob and size when its content is left out", () => {
		const blob = "b".repeat(40);
		const binary = { path: "logo.png", blob, size: 1200 };
		expect(scan([], [asset({ files: [binary] })]).success).toBe(true);
		expect(scan([], [asset({ files: [{ path: "logo.png", blob }] })]).success).toBe(false);
	});

	it("lists each file it read once, symlinks included", () => {
		const read = (files: unknown[]) =>
			scanResult.safeParse({
				commit: COMMIT,
				scannedAt: 1,
				agents: [],
				assets: [],
				problems: [],
				files,
			});
		const file = {
			path: "AGENTS.md",
			blob: "b".repeat(40),
			size: 6,
			symlink: false,
			content: "hello\n",
		};
		const link = { path: "CLAUDE.md", blob: "c".repeat(40), size: 9, symlink: true };
		expect(read([file, link]).success).toBe(true);
		expect(read([file, { ...file, content: undefined }]).success).toBe(false);
		expect(read([{ ...file, blob: undefined }]).success).toBe(false);
		expect(read([{ ...file, path: "../AGENTS.md" }]).success).toBe(false);
	});
});

describe("mcpServerInput", () => {
	const server = (fields: Record<string, unknown>) =>
		mcpServerInput.safeParse({
			name: "acme",
			transport: "http",
			url: "https://mcp.acme.dev/mcp",
			...fields,
		});
	const refusal = (fields: Record<string, unknown>) => {
		const parsed = server(fields);
		return parsed.success ? null : parsed.error.issues[0]?.message;
	};

	it("takes an https address, or a plain one on the machine itself", () => {
		expect(server({ url: " https://MCP.acme.dev/mcp " }).data?.url).toBe(
			"https://mcp.acme.dev/mcp",
		);
		expect(server({ url: "http://localhost:8787/mcp" }).success).toBe(true);
		expect(server({ url: "http://127.0.0.1/mcp" }).success).toBe(true);
		expect(refusal({ url: "http://mcp.acme.dev/mcp" })).toBe("The URL must start with https://");
		expect(refusal({ url: "http://localhost.acme.dev/mcp" })).toBe(
			"The URL must start with https://",
		);
		expect(refusal({ url: "ftp://mcp.acme.dev" })).toBe(
			"Enter the server's full URL, starting with https://",
		);
		expect(refusal({ url: "mcp.acme.dev" })).toBe(
			"Enter the server's full URL, starting with https://",
		);
	});

	it("keeps credentials and settings out of the address", () => {
		const message = "Send credentials and settings as headers, not in the URL";
		expect(refusal({ url: "https://mcp.acme.dev/mcp?token=abc" })).toBe(message);
		expect(refusal({ url: "https://ada:secret@mcp.acme.dev/mcp" })).toBe(message);
		expect(refusal({ url: "https://mcp.acme.dev/mcp#key" })).toBe(message);
	});

	it("takes headers that name a variable, never a value", () => {
		expect(
			server({ headers: [{ name: "Authorization", value: "Bearer ${ACME_TOKEN}" }] }).success,
		).toBe(true);
		const named = "A header's value names a variable, as in Bearer ${API_TOKEN}";
		expect(refusal({ headers: [{ name: "Authorization", value: "Bearer sk-live-123" }] })).toBe(
			named,
		);
		expect(refusal({ headers: [{ name: "X-Team", value: "${team}" }] })).toBe(named);
		expect(refusal({ headers: [{ name: "X-Team", value: "${A}${B}" }] })).toBe(named);
		expect(
			refusal({
				headers: [
					{ name: "x-team", value: "${A}" },
					{ name: "X-Team", value: "${B}" },
				],
			}),
		).toBe("A header is set twice");
		expect(refusal({ headers: [{ name: "X Team", value: "${A}" }] })).toBe(
			"A header's name has no spaces or symbols",
		);
	});
});

describe("agentDefinitionInput", () => {
	const withTools = (tools: unknown) =>
		agentDefinitionInput.safeParse({
			name: "Triage",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			mcpServers: [{ assetId: "a", version: 1, tools }],
		});

	it("allows every tool of a server unless a list says otherwise", () => {
		const parsed = agentDefinitionInput.parse({
			name: "Triage",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			mcpServers: [{ assetId: "a", version: 1 }],
		});
		expect(parsed.mcpServers[0]?.tools).toBeNull();
		expect(withTools([" get_issue ", "search_issues"]).data?.mcpServers[0]?.tools).toEqual([
			"get_issue",
			"search_issues",
		]);
	});

	it("refuses a tool list that is empty, repeats a tool or has a name no server could give", () => {
		const message = (tools: unknown) => withTools(tools).error?.issues[0]?.message;
		expect(message([])).toBe("Choose at least one tool, or allow all of them");
		expect(message(["a", "a"])).toBe("A tool is chosen twice");
		expect(message(["a b"])).toBe("A tool name has no spaces or control characters");
		expect(message(["a\u0000"])).toBe("A tool name has no spaces or control characters");
		expect(message([" "])).toBe("A tool name cannot be empty");
		expect(message(["x".repeat(201)])).toBe("A tool name is too long");
		expect(message(Array.from({ length: 201 }, (_, index) => `tool_${index}`))).toBe(
			"An agent can use up to 200 tools of a server",
		);
	});

	it("pins each MCP server once", () => {
		const parsed = agentDefinitionInput.safeParse({
			name: "Reviewer",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			mcpServers: [
				{ assetId: "a", version: 1 },
				{ assetId: "a", version: 2 },
			],
		});
		expect(parsed.success ? null : parsed.error.issues[0]?.message).toBe(
			"An MCP server is chosen twice",
		);
	});
});

describe("model providers", () => {
	const definition = (provider: string, model: string) =>
		agentDefinitionInput.safeParse({
			name: "Triage",
			description: null,
			provider,
			model,
			instructions: null,
		});

	it("lets an agent use Workers AI, with its own model ids", () => {
		const parsed = definition("workers-ai", "@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(parsed.data?.provider).toBe("workers-ai");
		expect(parsed.data?.model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
		expect(definition("workers-ai", "@cf/meta/llama 4").success).toBe(false);
		expect(definition("cloudflare", "x").success).toBe(false);
	});

	it("keeps keys to the providers that have them", () => {
		const key = (provider: string) => providerKeyInput.safeParse({ provider, key: "sk-abcdefgh" });
		for (const provider of KEYED_PROVIDERS) expect(key(provider).success).toBe(true);
		expect(key("workers-ai").success).toBe(false);
		expect(MODEL_PROVIDERS).toEqual([...KEYED_PROVIDERS, "workers-ai"]);
		expect(KEYED_PROVIDERS.every(isKeyedProvider)).toBe(true);
		expect(isKeyedProvider("workers-ai")).toBe(false);
	});

	it("says what a provider is missing", () => {
		expect(providerMissing("openai")).toBe("The workspace has no OpenAI key");
		expect(providerMissing("workers-ai")).toBe(WORKERS_AI_NOT_OFFERED);
		expect(providerMissingShort("google")).toBe("no Google key yet");
		expect(providerMissingShort("workers-ai")).toBe("not on this server");
		expect(providerPickerNote("anthropic")).toBe(" (no key)");
		expect(providerPickerNote("workers-ai")).toBe(" (not on this server)");
	});
});

describe("Workers AI settings", () => {
	const gateway = "https://gateway.ai.cloudflare.com/v1/abc123/main";

	it("is offered only with the token and an account to charge", () => {
		expect(workersAiOffered({})).toBe(false);
		expect(workersAiOffered({ WORKERS_AI_TOKEN: "t" })).toBe(false);
		expect(workersAiOffered({ CLOUDFLARE_ACCOUNT_ID: "abc123" })).toBe(false);
		expect(workersAiOffered({ WORKERS_AI_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "abc123" })).toBe(false);
		expect(workersAiOffered({ WORKERS_AI_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "abc123" })).toBe(true);
		expect(workersAiOffered({ WORKERS_AI_TOKEN: "t", AI_GATEWAY_URL: gateway })).toBe(true);
		expect(workersAiOffered({ WORKERS_AI_TOKEN: "t", AI_GATEWAY_URL: "https://example.com" })).toBe(
			false,
		);
	});

	it("charges the account named outright, else the gateway's", () => {
		expect(workersAiAccount({ AI_GATEWAY_URL: `${gateway}/` })).toBe("abc123");
		expect(workersAiAccount({ AI_GATEWAY_URL: gateway, CLOUDFLARE_ACCOUNT_ID: " other " })).toBe(
			"other",
		);
		// A named account that is not an id is not replaced by the gateway's.
		expect(workersAiAccount({ AI_GATEWAY_URL: gateway, CLOUDFLARE_ACCOUNT_ID: "a/b" })).toBeNull();
		expect(parseGatewayUrl(`${gateway}//`)).toEqual({ account: "abc123", gateway: "main" });
		expect(parseGatewayUrl("https://gateway.ai.cloudflare.com/v1/abc123")).toBeNull();
		expect(workersAiBaseUrl("abc123")).toBe(
			"https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
		);
	});
});

describe("a run's pull request", () => {
	const pullRequest = {
		repository: "acme/site",
		number: 12,
		url: "https://github.com/acme/site/pull/12",
	};

	it("is a pull request's page on GitHub, which the app links to, and nothing else", () => {
		expect(runPullRequest.safeParse(pullRequest).success).toBe(true);
		expect(
			runPullRequest.safeParse({
				...pullRequest,
				repository: "a-b/c.d_e",
				url: "https://github.com/a-b/c.d_e/pull/12",
			}).success,
		).toBe(true);
		for (const url of [
			"https://evil.example/acme/site/pull/12",
			"https://github.com/acme/site/pull/13",
			"http://github.com/acme/site/pull/12",
			"javascript:alert(1)//https://github.com/acme/site/pull/12",
		]) {
			expect(runPullRequest.safeParse({ ...pullRequest, url }).success).toBe(false);
		}
		for (const repository of [
			"acme",
			"acme/site/x",
			"acme/../site",
			"acme/..",
			"./site",
			"acme/si te",
			"/site",
		]) {
			const url = `https://github.com/${repository}/pull/12`;
			expect(runPullRequest.safeParse({ ...pullRequest, repository, url }).success).toBe(false);
		}
		expect(runPullRequest.safeParse({ ...pullRequest, number: 0 }).success).toBe(false);
	});
});

describe("agent engines", () => {
	const definition = (fields: Record<string, unknown>) =>
		agentDefinitionInput.safeParse({
			name: "Builder",
			description: null,
			provider: "anthropic",
			model: "claude-sonnet-5-5",
			instructions: null,
			...fields,
		});

	it("default to Gateweave's own loop, and refuse an unknown one", () => {
		expect(definition({}).data?.engine).toBe("gateweave");
		expect(definition({ engine: "claude-code" }).data?.engine).toBe("claude-code");
		expect(definition({ engine: "codex" }).data?.engine).toBe("codex");
		expect(definition({ engine: "aider" }).success).toBe(false);
	});
});
