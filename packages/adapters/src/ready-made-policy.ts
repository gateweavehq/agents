/**
 * The supply-chain policy for ready-made setups. These folders ship to every workspace, so an
 * MCP server in one may point only at a reviewed host, or start only a reviewed command. This
 * applies to the folders under `setups/`; a workspace's own setup folder is not held to it.
 */
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
		if (connection.transport === "stdio") {
			const listed = allowlist.commands.some(
				(command) =>
					command.command === connection.command &&
					command.args.length === connection.args.length &&
					command.args.every((arg, index) => arg === connection.args[index]),
			);
			if (!listed) {
				const shown = [connection.command, ...connection.args].join(" ");
				problems.push(`${asset.name}: the command server "${shown}" is not allowlisted`);
			}
			continue;
		}

		let host: string;
		try {
			host = new URL(connection.url).hostname.toLowerCase();
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
