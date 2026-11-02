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
	type McpCheck,
	type McpCheckResult,
	type McpServerConnection,
	type McpServerEntry,
	type Metadata,
	type mcpServerEditInput,
	type mcpServerInput,
	mcpServerUrl,
	type ResolvedEnvironment,
	type TurnMcpServer,
} from "@gateweave/agents-model";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import {
	agentDefinitions,
	agentMcpServers,
	agents,
	assets,
	assetVersions,
	envSecrets,
	type FileEntry,
	mcpChecks,
} from "./db/schema";
import { bindSecret, contestSecret, type SecretSend, secretSends } from "./environment";
import { assetHash } from "./hash";
import { libraryKey } from "./library";
import { connectedFor, oauthRow } from "./mcp-oauth";
import { getAssetVersion } from "./queries";
import { MAX_KEPT_FILE_BYTES, storeFile } from "./scans";
import { type Db, toAsset } from "./state";

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

/** A server an agent run by Gateweave reaches over the network, at an address it accepts. */
export type RemoteServer = Extract<McpConnection, { transport: "http" | "sse" }>;

/** A server that runs as a local command, which an agent's sandbox starts for its turns. */
export type LocalServer = Extract<McpConnection, { transport: "stdio" }>;

export type StoredServer = RemoteServer | LocalServer;

/** Why a local command cannot run where there is no sandbox to start it in. */
export const LOCAL_SERVER_NEEDS_SANDBOX =
	"It runs as a local command, which starts in the sandbox of an agent that has one";

/** How an agent reaches a stored server, or why it cannot. */
export function storedServer(
	files: { path: string; content: string | null }[],
): { server: StoredServer } | { problem: string } {
	const reading = readMcpConnection(files);
	if (!reading.ok) return { problem: reading.message };
	const { connection } = reading;
	if (connection.transport === "stdio") return { server: connection };
	const url = mcpServerUrl.safeParse(connection.url);
	if (!url.success) return { problem: url.error.issues[0]?.message ?? "Its URL is not supported" };
	return { server: connection };
}

/** Where a server is, as pages show it: never a value of its headers or environment. */
export function serverConnection(server: StoredServer): McpServerConnection {
	return server.transport === "stdio"
		? { transport: "stdio", command: server.command, args: server.args }
		: { transport: server.transport, url: server.url };
}

/** The variables a server's headers, or its command's environment, name, sorted. */
export function serverVariables(server: StoredServer): string[] {
	const values = server.transport === "stdio" ? server.env : server.headers;
	const names = values.flatMap((entry) =>
		typeof entry.value === "string" ? [] : [entry.value.variable],
	);
	return [...new Set(names)].sort(compare);
}

/** A pinned server as an agent's page shows it, given the variables its environment set has. */
export function agentMcpServer(
	pinned: Omit<AgentMcpServer, "connection" | "variables">,
	files: { path: string; content: string | null }[],
	available: ReadonlySet<string>,
): AgentMcpServer {
	const reading = storedServer(files);
	if ("problem" in reading) return { ...pinned, connection: reading, variables: [] };
	return {
		...pinned,
		connection: serverConnection(reading.server),
		variables: serverVariables(reading.server).map((name) => ({
			name,
			state: available.has(name) ? "set" : "missing",
		})),
	};
}

/** The servers an agent pins, by name, each as its pinned version says to reach it. */
export function agentServers(
	db: Db,
	agentId: string,
): {
	assetId: string;
	name: string;
	reading: { server: StoredServer } | { problem: string };
	tools: string[] | null;
}[] {
	return db
		.select({
			id: assets.id,
			name: assets.name,
			version: agentMcpServers.version,
			tools: agentMcpServers.tools,
		})
		.from(agentMcpServers)
		.innerJoin(assets, eq(assets.id, agentMcpServers.assetId))
		.where(eq(agentMcpServers.agentId, agentId))
		.orderBy(asc(assets.name), asc(assets.id))
		.all()
		.map(({ id, name, version, tools }) => ({
			assetId: id,
			name,
			tools,
			reading: storedServer(getAssetVersion(db, id, version)?.files ?? []),
		}));
}

/**
 * A server as one turn reaches it: each variable its headers, or its command's environment, name
 * replaced with its value from the agent's environment set. A server whose variables are not all
 * there is left out, with why.
 */
export function turnServer(
	{ name, reading, tools }: ReturnType<typeof agentServers>[number],
	environment: ResolvedEnvironment | null,
): TurnMcpServer {
	if ("problem" in reading) return { name, problem: reading.problem };
	const { server } = reading;
	const entries = server.transport === "stdio" ? server.env : server.headers;
	const filled: Record<string, string> = {};
	const missing: string[] = [];
	for (const entry of entries) {
		if (typeof entry.value === "string") {
			filled[entry.name] = entry.value;
			continue;
		}
		const value = environment?.values[entry.value.variable];
		if (value === undefined) missing.push(entry.value.variable);
		else filled[entry.name] = `${entry.value.prefix}${value}`;
	}
	if (missing.length === 0) {
		return server.transport === "stdio"
			? { name, transport: "stdio", command: server.command, args: server.args, env: filled, tools }
			: { name, transport: server.transport, url: server.url, headers: filled, tools };
	}
	const names = [...new Set(missing)].sort(compare);
	return {
		name,
		problem: `${names.join(", ")} ${names.length === 1 ? "has" : "have"} no value in the agent's environment set`,
	};
}

/**
 * An agent's environment as `RegistryDO` opened it for a turn or a check: the values, and the
 * set's secrets that were opened, by name, with the sealed value each was opened from.
 */
export interface OpenedEnvironment {
	environment: ResolvedEnvironment;
	assetId: string | null;
	opened: ReadonlyMap<string, string>;
}

/**
 * The servers of one turn or check, as `turnServer` fills them in, with each secret their headers
 * name sent only to the origin it was first sent to (AGT-64). Whoever may edit a server could
 * otherwise point it at their own host and receive a key someone else entered. A secret sent
 * nowhere yet is tied to the origin of the first server that sends it; to send it to another,
 * someone enters it again. Runs in a write, after the environment was opened, so the ties it reads
 * and makes are current, and a value entered again meanwhile is not sent as the one it replaced.
 */
export function turnServers(
	db: Db,
	servers: ReturnType<typeof agentServers>,
	opened: OpenedEnvironment | null,
	sandbox: boolean,
): TurnMcpServer[] {
	const assetId = opened?.assetId ?? null;
	const sends = assetId ? secretSends(db, assetId) : new Map<string, SecretSend>();
	return servers.map((server) => withOAuth(db, server.assetId, turnOf(server)));

	function turnOf(server: ReturnType<typeof agentServers>[number]): TurnMcpServer {
		if (!("problem" in server.reading) && server.reading.server.transport === "stdio") {
			return localTurnServer(server, opened, sandbox);
		}
		const turn = turnServer(server, opened?.environment ?? null);
		if ("problem" in turn || turn.transport === "stdio" || !opened || !assetId) return turn;
		if ("problem" in server.reading) return turn;
		const origin = new URL(turn.url).origin;
		const secrets = serverVariables(server.reading.server).filter((name) =>
			opened.opened.has(name),
		);
		const changed: string[] = [];
		const elsewhere: string[] = [];
		const closed: string[] = [];
		for (const name of secrets) {
			const send = sends.get(name);
			if (!send || send.sealed !== opened.opened.get(name)) changed.push(name);
			else if (send.sentTo !== null && send.sentTo !== origin) elsewhere.push(name);
			// Stored before ties, and the pass that ties those failed (AGT-66): nowhere.
			else if (send.sentTo === null && send.contested?.length === 0) closed.push(name);
			// Stored before ties, and named at several origins then (AGT-65): one of those alone.
			else if (send.sentTo === null && send.contested && !send.contested.includes(origin)) {
				elsewhere.push(name);
			}
		}
		if (changed.length > 0) {
			return { name: turn.name, problem: `${changed.join(", ")} changed as this began; try again` };
		}
		if (closed.length > 0) {
			const one = closed.length === 1;
			return {
				name: turn.name,
				problem: `${closed.join(", ")} ${one ? "was" : "were"} stored before values were tied to one server address and could not be tied, so ${one ? "it is" : "they are"} not sent to any. An owner or admin can enter ${one ? "it" : "them"} again in the agent's environment set to send ${one ? "it" : "them"} to ${origin}.`,
			};
		}
		if (elsewhere.length > 0) {
			const one = elsewhere.length === 1;
			return {
				name: turn.name,
				problem: `${elsewhere.join(", ")} ${one ? "was" : "were"} entered for another server address, so ${one ? "it is" : "they are"} not sent to ${origin}. An owner or admin can enter ${one ? "it" : "them"} again in the agent's environment set to send ${one ? "it" : "them"} there.`,
			};
		}
		for (const name of secrets) {
			const send = sends.get(name);
			if (!send || send.sentTo !== null) continue;
			bindSecret(db, assetId, name, origin);
			sends.set(name, { ...send, sentTo: origin, contested: null });
		}
		return turn;
	}
}

/**
 * A remote server as a turn reaches it, marked to use the workspace's OAuth connection to it when
 * there is one for the URL it has now (AGT-78). The runtime gets the token itself, through the
 * registry, so that it can refresh it.
 */
function withOAuth(db: Db, assetId: string, turn: TurnMcpServer): TurnMcpServer {
	if ("problem" in turn || turn.transport === "stdio") return turn;
	return connectedFor(db, assetId, turn.url) ? { ...turn, oauth: assetId } : turn;
}

/**
 * A local command as one turn starts it in its sandbox. The sandbox holds no secret of the
 * workspace's, so that nothing a command runs there can leak one: its environment takes the set's
 * variables, and a server that names a secret is left out, with why.
 */
function localTurnServer(
	server: ReturnType<typeof agentServers>[number],
	opened: OpenedEnvironment | null,
	sandbox: boolean,
): TurnMcpServer {
	if (!sandbox) return { name: server.name, problem: LOCAL_SERVER_NEEDS_SANDBOX };
	if ("problem" in server.reading) return { name: server.name, problem: server.reading.problem };
	const secrets = serverVariables(server.reading.server).filter((name) => opened?.opened.has(name));
	if (secrets.length > 0) {
		const one = secrets.length === 1;
		return {
			name: server.name,
			problem: `${secrets.join(", ")} ${one ? "is a secret" : "are secrets"} of the agent's environment set, and secrets never go into the sandbox, where it runs. Make ${one ? "it a variable" : "them variables"} if ${one ? "it is" : "they are"} not secret.`,
		};
	}
	return turnServer(server, opened?.environment ?? null);
}

/** The name `registry_passes` keeps `bindUnsentSecrets` under (see `passes.ts`). */
export const BIND_UNSENT_SECRETS = "bind-unsent-secrets";

/**
 * Ties each value stored before values were tied to one origin (AGT-64), and sent nowhere since,
 * to the origin of the servers that name it, once per workspace (AGT-65). Until it was, whoever
 * may edit a server could point it at their own host and check it to have the value tied there.
 * The servers that count are those an agent run by Gateweave could send it to: the version each
 * live agent pins, and the current version, which a check sends to, of servers its environment
 * set fills. A value they name at different origins is left unbound, with those origins, for an
 * admin to look at on the Environment page, and `turnServers` sends it to one of those alone.
 * Runs in a write, once, through `runPassOnce`.
 */
export function bindUnsentSecrets(db: Db): void {
	const unsent = new Set(
		db
			.select({ assetId: envSecrets.assetId, name: envSecrets.name })
			.from(envSecrets)
			.where(isNull(envSecrets.sentTo))
			.all()
			.map(({ assetId, name }) => secretKey(assetId, name)),
	);
	if (unsent.size === 0) return;
	const uses = db
		.select({
			set: agentDefinitions.envSetAssetId,
			server: agentMcpServers.assetId,
			pinned: agentMcpServers.version,
			current: assets.version,
		})
		.from(agentMcpServers)
		.innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.innerJoin(assets, eq(assets.id, agentMcpServers.assetId))
		.where(isNull(agents.removedAt))
		.all();
	const readings = new Map<string, ReturnType<typeof storedServer>>();
	const reading = (server: string, version: number) => {
		const key = `${server}@${version}`;
		let found = readings.get(key);
		if (!found) {
			found = storedServer(getAssetVersion(db, server, version)?.files ?? []);
			readings.set(key, found);
		}
		return found;
	};
	const origins = new Map<string, { assetId: string; name: string; origins: Set<string> }>();
	for (const use of uses) {
		const { set } = use;
		if (set === null) continue;
		for (const version of new Set([use.pinned, use.current])) {
			const read = reading(use.server, version);
			// A local command is never sent a secret (`localTurnServer`).
			if ("problem" in read || read.server.transport === "stdio") continue;
			const origin = new URL(read.server.url).origin;
			for (const name of serverVariables(read.server)) {
				const key = secretKey(set, name);
				if (!unsent.has(key)) continue;
				const entry = origins.get(key) ?? { assetId: set, name, origins: new Set<string>() };
				entry.origins.add(origin);
				origins.set(key, entry);
			}
		}
	}
	for (const { assetId, name, origins: named } of origins.values()) {
		const [only, ...others] = [...named].sort(compare);
		if (only === undefined) continue;
		if (others.length === 0) bindSecret(db, assetId, name, only);
		else contestSecret(db, assetId, name, [only, ...others]);
	}
}

const secretKey = (assetId: string, name: string) => `${assetId}\n${name}`;

/** The live agents run by Gateweave that pin a server, by name. */
function pinners(db: Db, assetId: string): { id: string; name: string; version: number }[] {
	return db
		.select({ id: agents.id, name: agents.name, version: agentMcpServers.version })
		.from(agentMcpServers)
		.innerJoin(agents, eq(agents.id, agentMcpServers.agentId))
		.innerJoin(agentDefinitions, eq(agentDefinitions.agentId, agents.id))
		.where(and(eq(agentMcpServers.assetId, assetId), isNull(agents.removedAt)))
		.orderBy(asc(agents.name), asc(agents.id))
		.all();
}

/** A live library server that agents reach at a URL, at its current version, or why it is not one. */
export function remoteLibraryServer(
	db: Db,
	assetId: string,
): { url: string; name: string } | { problem: string } {
	const asset = liveServer(db, assetId);
	if (!asset) return { problem: "That MCP server is not in the library" };
	const reading = storedServer(getAssetVersion(db, asset.id)?.files ?? []);
	if ("problem" in reading) return reading;
	if (reading.server.transport === "stdio") {
		return { problem: "It runs as a local command, which has nothing to sign in to" };
	}
	return { url: reading.server.url, name: asset.name };
}

/** A live library `mcp-server` asset, or null. */
function liveServer(db: Db, assetId: string) {
	return (
		db
			.select()
			.from(assets)
			.where(
				and(
					eq(assets.id, assetId),
					isNull(assets.repositoryId),
					isNull(assets.removedAt),
					eq(assets.kind, "mcp-server"),
				),
			)
			.get() ?? null
	);
}

/**
 * What a check of a library server needs: the server as of its current version, and the agent
 * whose environment set fills its headers. That is an agent pinned to the current version if
 * there is one, else any live agent that pins it; with none, the check has no environment.
 */
export function mcpCheckPlan(
	db: Db,
	assetId: string,
): {
	assetId: string;
	name: string;
	reading: ReturnType<typeof agentServers>[number]["reading"];
	agentId: string | null;
} | null {
	const asset = liveServer(db, assetId);
	if (!asset) return null;
	const users = pinners(db, assetId);
	const agent = users.find((user) => user.version === asset.version) ?? users[0];
	return {
		assetId: asset.id,
		name: asset.name,
		reading: storedServer(getAssetVersion(db, asset.id)?.files ?? []),
		agentId: agent?.id ?? null,
	};
}

/** Keeps the last check of a server, in place of the one before. Null when it is not in the library. */
export function recordMcpCheck(
	db: Db,
	assetId: string,
	result: McpCheckResult,
	now: number,
): McpCheck | null {
	const asset = liveServer(db, assetId);
	if (!asset) return null;
	const check = {
		version: asset.version,
		checkedAt: now,
		ok: result.ok,
		tools: result.ok ? result.tools : [],
		error: result.ok ? null : result.error,
	};
	db.insert(mcpChecks)
		.values({ assetId, ...check })
		.onConflictDoUpdate({ target: mcpChecks.assetId, set: check })
		.run();
	return check;
}

/** Every live library MCP server for the MCP page: how it is reached, who pins it, its last check. */
export function listMcpServers(db: Db): McpServerEntry[] {
	const rows = db
		.select()
		.from(assets)
		.where(
			and(isNull(assets.repositoryId), isNull(assets.removedAt), eq(assets.kind, "mcp-server")),
		)
		.orderBy(asc(assets.name), asc(assets.id))
		.all();
	const checks = new Map(
		db
			.select()
			.from(mcpChecks)
			.all()
			.map((row) => [row.assetId, row]),
	);
	return rows.map((row) => {
		const reading = storedServer(getAssetVersion(db, row.id)?.files ?? []);
		const check = checks.get(row.id);
		const oauth = oauthRow(db, row.id);
		const url =
			"problem" in reading || reading.server.transport === "stdio" ? null : reading.server.url;
		return {
			asset: toAsset(row),
			connection: "problem" in reading ? reading : serverConnection(reading.server),
			variables: "problem" in reading ? [] : serverVariables(reading.server),
			agents: pinners(db, row.id),
			check: check
				? {
						version: check.version,
						checkedAt: check.checkedAt,
						ok: check.ok,
						tools: check.tools,
						error: check.error,
					}
				: null,
			oauth:
				oauth?.sealedTokens && oauth.connectedBy !== null && oauth.connectedAt !== null
					? {
							connectedBy: oauth.connectedBy,
							connectedAt: oauth.connectedAt,
							current: oauth.serverUrl === url,
						}
					: null,
		};
	});
}
