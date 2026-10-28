/**
 * MCP servers in the library, as agents run by Gateweave use them. A server written in the app is
 * a library asset of kind `mcp-server` with one `.mcp.json` file, in the shape a scan stores a
 * server in, so setups write it and drift compares it like any server. Its headers name variables
 * of the agent's environment set and never hold a value, so it is written only through here: the
 * library refuses it as plain text.
 */
import { type McpConnection, readMcpConnection } from "@gateweave/agents-adapters";
import {
	type AgentMcpServer,
	MCP_SERVER_FILE,
	type Metadata,
	type mcpServerEditInput,
	type mcpServerInput,
	mcpServerUrl,
} from "@gateweave/agents-model";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import { assets, assetVersions, type FileEntry } from "./db/schema";
import { assetHash } from "./hash";
import { libraryKey } from "./library";
import { MAX_KEPT_FILE_BYTES, storeFile } from "./scans";
import type { Db } from "./state";

/** A change to an MCP server that is refused, with a message fit to show the person who asked. */
export class McpServerError extends Error {}

type Settings = Omit<z.output<typeof mcpServerInput>, "name">;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The file's text: keys sorted, two spaces, one trailing newline, as scans store servers. */
export function mcpServerText({ transport, url, headers }: Settings): string {
	const sorted = [...headers].sort((a, b) => compare(a.name, b.name));
	const server = {
		...(sorted.length > 0
			? { headers: Object.fromEntries(sorted.map((header) => [header.name, header.value])) }
			: {}),
		type: transport,
		url,
	};
	return `${JSON.stringify(server, null, 2)}\n`;
}

/** What the asset's page lists about the server, as a scan records it. */
function metadataOf({ transport, url, headers }: Settings): Metadata {
	return {
		type: transport,
		url,
		...(headers.length > 0 ? { headers: headers.map((header) => header.name).sort(compare) } : {}),
	};
}

/** Adds a server to the library: version 1 of an `mcp-server` asset. Returns its id. */
export function createMcpServer(
	db: Db,
	input: z.output<typeof mcpServerInput>,
	now: number,
): string {
	const key = libraryKey("mcp-server", input.name);
	const taken = db
		.select({ id: assets.id })
		.from(assets)
		.where(and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.key, key)))
		.get();
	if (taken) throw new McpServerError(`The library already has an MCP server named ${input.name}`);
	const files = [fileOf(db, input)];
	const hash = assetHash(files);
	const id = crypto.randomUUID();
	db.insert(assets)
		.values({
			id,
			repositoryId: null,
			kind: "mcp-server",
			key,
			name: input.name,
			description: null,
			path: null,
			metadata: metadataOf(input),
			version: 1,
			hash,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(assetVersions)
		.values({ assetId: id, version: 1, hash, commit: null, files, createdAt: now })
		.run();
	return id;
}

/**
 * Saves new settings for a library MCP server as its next version, whatever format it came in.
 * Settings that write what the server already has add no version. Returns its current version.
 */
export function editMcpServer(
	db: Db,
	input: z.output<typeof mcpServerEditInput>,
	now: number,
): number {
	const asset = db
		.select()
		.from(assets)
		.where(
			and(eq(assets.id, input.assetId), isNull(assets.repositoryId), eq(assets.kind, "mcp-server")),
		)
		.get();
	if (!asset) throw new McpServerError("That MCP server is not in the library");
	if (asset.removedAt !== null) {
		throw new McpServerError(`${asset.name} is no longer in the library`);
	}
	const files = [fileOf(db, input)];
	const hash = assetHash(files);
	if (hash === asset.hash) return asset.version;
	const version = asset.version + 1;
	db.insert(assetVersions)
		.values({ assetId: asset.id, version, hash, commit: null, files, createdAt: now })
		.run();
	db.update(assets)
		.set({ version, hash, metadata: metadataOf(input), updatedAt: now })
		.where(eq(assets.id, asset.id))
		.run();
	return version;
}

function fileOf(db: Db, settings: Settings): FileEntry {
	const text = mcpServerText(settings);
	if (new TextEncoder().encode(text).byteLength > MAX_KEPT_FILE_BYTES) {
		throw new McpServerError("That MCP server is too large");
	}
	return storeFile(db, { path: MCP_SERVER_FILE, content: text });
}

/** A server an agent run by Gateweave can reach: over the network, at an address it accepts. */
export type RemoteServer = Extract<McpConnection, { transport: "http" | "sse" }>;

/** How an agent reaches a stored server, or why it cannot. */
export function remoteServer(
	files: { path: string; content: string | null }[],
): { server: RemoteServer } | { problem: string } {
	const reading = readMcpConnection(files);
	if (!reading.ok) return { problem: reading.message };
	const { connection } = reading;
	if (connection.transport === "stdio") {
		return {
			problem: "It runs as a local command, which agents run by Gateweave cannot start yet",
		};
	}
	const url = mcpServerUrl.safeParse(connection.url);
	if (!url.success) return { problem: url.error.issues[0]?.message ?? "Its URL is not supported" };
	return { server: connection };
}

/** The variables a server's headers name, sorted. */
export function serverVariables(server: RemoteServer): string[] {
	const names = server.headers.flatMap((header) =>
		typeof header.value === "string" ? [] : [header.value.variable],
	);
	return [...new Set(names)].sort(compare);
}

/** A pinned server as an agent's page shows it, given the variables its environment set has. */
export function agentMcpServer(
	pinned: Omit<AgentMcpServer, "connection" | "variables">,
	files: { path: string; content: string | null }[],
	available: ReadonlySet<string>,
): AgentMcpServer {
	const reading = remoteServer(files);
	if ("problem" in reading) return { ...pinned, connection: reading, variables: [] };
	const { transport, url } = reading.server;
	return {
		...pinned,
		connection: { transport, url },
		variables: serverVariables(reading.server).map((name) => ({
			name,
			state: available.has(name) ? "set" : "missing",
		})),
	};
}
