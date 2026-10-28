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
 */
export const MODEL_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_PROVIDER_NAMES: Record<ModelProvider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
};

/** The kinds of library asset an agent run by Gateweave can take its instructions from. */
export const INSTRUCTION_KINDS = ["instructions", "prompt"] as const satisfies readonly AssetKind[];
