/**
 * The supply-chain policy for ready-made setups. These folders ship to every workspace, so an
 * MCP server in one may point only at a reviewed host, or start only a reviewed command. This
 * applies to the folders under `setups/`; a workspace's own setup folder is not held to it.
 */
import { parseJsonConfig, parseTomlConfig } from "./assets";
import type { SetupFolder } from "./setup-folder";
import { readMcpConnection } from "./write-mcp";

/** The remote hosts and exact local commands a ready-made setup may configure. */
export interface ReadyMadeMcpAllowlist {
	/** Exact remote host names, lowercase and without a port. */
	hosts: readonly string[];
	/** Hosts accepted only as the example address of a server whose real address is asked for. */
	askUrlExampleHosts: readonly string[];
	/** Local commands, pinned with their arguments. */
	commands: readonly { command: string; args: readonly string[] }[];
}

export const READY_MADE_MCP_ALLOWLIST: ReadyMadeMcpAllowlist = {
	hosts: ["api.githubcopilot.com"],
	askUrlExampleHosts: ["example.com"],
	commands: [],
};

/**
 * The only keys a stored server may have. Anything else is carried into the written files by the
 * writer, and a client may run it (`headersHelper`) or widen its trust (`trust`), so the set is closed.
 */
const REMOTE_KEYS = [
	"type",
	"url",
	"httpUrl",
	"headers",
	"http_headers",
	"env_http_headers",
	"bearer_token_env_var",
];
const COMMAND_KEYS = ["type", "command", "args", "env", "env_vars"];

/** Why a setup's MCP servers break the ready-made policy; empty when they follow it. */
export function readyMadeMcpProblems(
	setup: SetupFolder,
	allowlist: ReadyMadeMcpAllowlist = READY_MADE_MCP_ALLOWLIST,
): string[] {
	const asked = new Set(setup.addresses.map((address) => address.server));
	const problems: string[] = [];
	for (const asset of setup.assets) {
		if (asset.kind !== "mcp-server") continue;
		const read = readMcpConnection(asset.files);
		if (!read.ok) continue;
		const { connection } = read;
		const stray = strayKey(
			asset.files,
			connection.transport === "stdio" ? COMMAND_KEYS : REMOTE_KEYS,
		);
		if (stray !== null) {
			problems.push(`${asset.name}: the field "${stray}" is not allowlisted`);
			continue;
		}
		if (connection.transport === "stdio") {
			const listed = allowlist.commands.some(
				(command) =>
					command.command === connection.command &&
					command.args.length === connection.args.length &&
					command.args.every((arg, index) => arg === connection.args[index]),
			);
			const unsafe = connection.env.find(
				(entry) => typeof entry.value === "string" || entry.value.prefix !== "",
			);
			if (listed && unsafe) {
				problems.push(`${asset.name}: env "${unsafe.name}" must be a variable reference`);
				continue;
			}
			if (!listed) {
				const shown = [connection.command, ...connection.args].join(" ");
				problems.push(`${asset.name}: the command server "${shown}" is not allowlisted`);
			}
			continue;
		}

		let host: string;
		try {
			const url = new URL(connection.url);
			if (url.protocol !== "https:") {
				problems.push(`${asset.name}: the server address must use https`);
				continue;
			}
			host = url.hostname.toLowerCase();
		} catch {
			problems.push(`${asset.name}: the server address is not a valid URL`);
			continue;
		}
		const example =
			asked.has(asset.name) &&
			allowlist.askUrlExampleHosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
		const allowed = allowlist.hosts.includes(host) || example;
		if (!allowed) problems.push(`${asset.name}: the host "${host}" is not allowlisted`);
	}
	return problems;
}

/** The first key of the stored server outside `allowed` (including `cwd`), or null. */
function strayKey(files: SetupFolder["assets"][number]["files"], allowed: string[]): string | null {
	const [file] = files;
	if (!file?.content) return null;
	const parsed = file.path.endsWith(".toml")
		? parseTomlConfig(file.content)
		: parseJsonConfig(file.content);
	if (!parsed.ok) return null;
	return Object.keys(parsed.value).find((key) => !allowed.includes(key)) ?? null;
}
