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
