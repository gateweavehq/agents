/** Coding agents that are configured by files in a repository, which a scan can find. */
export const REPOSITORY_RUNTIMES = ["claude-code", "codex", "gemini-cli", "cursor"] as const;
export type RepositoryRuntime = (typeof REPOSITORY_RUNTIMES)[number];

/**
 * Where an agent runs: a coding agent configured in a repository, or `gateweave`, an agent
 * defined in the app and run on Cloudflare (the runtime, phase 3 of the spec).
 */
export const AGENT_RUNTIMES = [...REPOSITORY_RUNTIMES, "gateweave"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export const RUNTIME_NAMES: Record<AgentRuntime, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	"gemini-cli": "Gemini CLI",
	cursor: "Cursor",
	gateweave: "Gateweave",
};

/**
 * What takes an agent run by Gateweave its turns: Gateweave's own loop with the agent's tools, or
 * a coding agent run in the agent's sandbox, which reads the repository's own instructions, skills
 * and settings: Anthropic's Claude Code (`CLAUDE.md`), OpenAI's Codex (`AGENTS.md`) or the
 * open-source OpenCode (`AGENTS.md` and `opencode.json`).
 */
export const AGENT_ENGINES = ["gateweave", "claude-code", "codex", "opencode"] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];

export const ENGINE_NAMES: Record<AgentEngine, string> = {
	gateweave: "Gateweave",
	"claude-code": "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
};

/** The providers whose models each engine run in the sandbox can call, with the workspace's key. */
export const ENGINE_PROVIDERS: Record<
	Exclude<AgentEngine, "gateweave">,
	readonly KeyedProvider[]
> = {
	"claude-code": ["anthropic"],
	codex: ["openai"],
	opencode: ["anthropic", "openai", "google"],
};

/**
 * What an asset is. `instructions` are what an agent always reads (`AGENTS.md`, `CLAUDE.md`,
 * `GEMINI.md`, Cursor rules, a subagent's definition); `prompt` covers reusable prompts and slash
 * commands; `settings` is an agent's own configuration file, such as `.claude/settings.json`;
 * `env-set` holds variables, with secrets by reference only.
 */
export const ASSET_KINDS = [
	"instructions",
	"prompt",
	"skill",
	"plugin",
	"script",
	"mcp-server",
	"settings",
	"env-set",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_KIND_NAMES: Record<AssetKind, string> = {
	instructions: "Instructions",
	prompt: "Prompt",
	skill: "Skill",
	plugin: "Plugin",
	script: "Script",
	"mcp-server": "MCP server",
	settings: "Settings",
	"env-set": "Environment set",
};

/** Where repositories are hosted. GitHub first; the spec leaves room for others. */
export const REPOSITORY_PROVIDERS = ["github"] as const;
export type RepositoryProvider = (typeof REPOSITORY_PROVIDERS)[number];

/** Where the pull request that applies a setup stands. */
export const APPLICATION_STATES = ["open", "merged", "closed"] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];

/**
 * How a repository compares with a setup applied to it, most urgent first: files the setup owns
 * were deleted there, or edited there; the setup now writes something else; the pull request was
 * merged after the last scan, so no scan has read it yet; or nothing differs.
 */
export const DRIFT_STATES = ["missing", "changed", "behind", "unscanned", "in_sync"] as const;
export type DriftState = (typeof DRIFT_STATES)[number];

/** Why one file differs from what its setup writes. */
export const DRIFT_FILE_STATES = ["missing", "changed", "behind"] as const;
export type DriftFileState = (typeof DRIFT_FILE_STATES)[number];

/**
 * Model providers a workspace brings its own key for. The runtime calls their models through AI
 * Gateway with that key, so usage is billed to the workspace's own account with the provider.
 * Everything about keys (saving, sealing, checking) takes only these.
 */
export const KEYED_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

/**
 * Every provider an agent run by Gateweave can use: the keyed ones, and Workers AI, which needs no
 * key of the workspace's own. The deployment pays for it, and only when its operator turned it on
 * (`WORKERS_AI_TOKEN`; see `./workers-ai.ts`).
 */
export const MODEL_PROVIDERS = [...KEYED_PROVIDERS, "workers-ai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_PROVIDER_NAMES: Record<ModelProvider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	"workers-ai": "Workers AI",
};

export function isKeyedProvider(provider: ModelProvider): provider is KeyedProvider {
	return (KEYED_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Why an agent of this provider cannot answer, as the start of a sentence: the workspace has no
 * key, or this server does not offer the provider.
 */
export function providerMissing(provider: ModelProvider): string {
	return isKeyedProvider(provider)
		? `The workspace has no ${MODEL_PROVIDER_NAMES[provider]} key`
		: `This server does not offer ${MODEL_PROVIDER_NAMES[provider]}`;
}

/** What follows a provider's name in a picker while no agent of it can answer. */
export function providerPickerNote(provider: ModelProvider): string {
	return isKeyedProvider(provider) ? " (no key)" : " (not on this server)";
}

/** The same in a few words, to follow an agent's name in a list. */
export function providerMissingShort(provider: ModelProvider): string {
	return isKeyedProvider(provider)
		? `no ${MODEL_PROVIDER_NAMES[provider]} key yet`
		: "not on this server";
}

/** The kinds of library asset an agent run by Gateweave can take its instructions from. */
export const INSTRUCTION_KINDS = ["instructions", "prompt"] as const satisfies readonly AssetKind[];

/**
 * How a run ended, or that it is still going. A run is `interrupted` when its conversation's
 * Durable Object restarted in the middle of it, so it never finished.
 */
export const RUN_STATUSES = ["running", "succeeded", "failed", "stopped", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * How one member of a team may reach another: `delegate` hands over a task and waits for the
 * result, `ask` asks one question that is answered without tools, and `report` sends a message
 * without waiting.
 */
export const TEAM_EDGE_KINDS = ["delegate", "ask", "report"] as const;
export type TeamEdgeKind = (typeof TEAM_EDGE_KINDS)[number];

/** A member of a team is an agent run by Gateweave, or another team, reached through its lead. */
export const TEAM_MEMBER_KINDS = ["agent", "team"] as const;
export type TeamMemberKind = (typeof TEAM_MEMBER_KINDS)[number];
