/**
 * MCP servers. Docs, checked 2026-10-28:
 * - https://code.claude.com/docs/en/mcp (`.mcp.json`, `mcpServers`; `${VAR}` expands in `command`,
 *   `args`, `env`, `url` and `headers`; stdio entries have no `type`, remote ones `http` or `sse`)
 * - https://learn.chatgpt.com/docs/extend/mcp (`.codex/config.toml`, `[mcp_servers.<name>]`;
 *   `env_vars` forwards variables by name, `bearer_token_env_var` and `env_http_headers` name the
 *   variable behind a header; the page shows no `${VAR}` expansion in `env`, so none is written)
 * - https://geminicli.com/docs/reference/configuration/ (`.gemini/settings.json`; "string
 *   values ... can reference environment variables" as `$VAR` or `${VAR}`; `httpUrl` is streamable
 *   HTTP, `url` is SSE) and https://geminicli.com/docs/tools/mcp-server/
 * - https://cursor.com/docs/context/mcp (`.cursor/mcp.json`; `${env:NAME}` resolves in `command`,
 *   `args`, `env`, `url` and `headers`; no `cwd`)
 *
 * The registry stores a server in the format it was read from, with every value under `env` and
 * `headers` replaced by `<redacted>` and anything else that looked like a credential too. The
 * secret itself is gone, so each of those values is written as a reference to an environment
 * variable: the same name for an `env` entry, the header's name in capitals for a header (`X-Team`
 * is `X_TEAM`). A `<redacted>` anywhere else, such as inside an argument or a URL, has no name to
 * point at, so that server is reported and left out rather than written with a placeholder.
 *
 * A stored server is read into one shape, then written in the target's. Fields the target does
 * not know are kept only when the server came from that same format, so one agent's settings
 * (such as Gemini's `trust`) never leak into another's file.
 */
import { type RepositoryRuntime, RUNTIME_NAMES } from "@gateweave/agents-model";
import { parseJsonConfig, parseTomlConfig } from "./assets";
import { canonicalJson, canonicalToml, REDACTED } from "./redaction";
import { compare, isPlainObject } from "./util";
import type { AssetToWrite } from "./write";
import type { Output } from "./write-output";

type Dialect = "json" | "codex" | "gemini";
/** A value in `env` or `headers`: text, or a reference to an environment variable. */
type Value = string | { ref: string; prefix: string };
type Transport =
	| { kind: "stdio"; command: string; args: string[] | undefined; typed: boolean }
	| { kind: "http" | "sse"; url: string };

interface Server {
	dialect: Dialect;
	transport: Transport;
	cwd: string | undefined;
	env: Map<string, Value>;
	headers: Map<string, Value>;
	/** Everything else the stored server says, for the format it came from. */
	extras: Record<string, unknown>;
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REFERENCE = /^([^$]*)\$(?:\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;

/** Fields each format has for the parts the shape holds, which `extras` leaves out. */
const OWN_FIELDS: Record<Dialect, readonly string[]> = {
	json: ["type", "command", "args", "env", "cwd", "url", "headers"],
	gemini: ["command", "args", "env", "cwd", "url", "httpUrl", "headers"],
	codex: [
		"command",
		"args",
		"env",
		"env_vars",
		"cwd",
		"url",
		"bearer_token_env_var",
		"http_headers",
		"env_http_headers",
	],
};

class Unwritable extends Error {}

function fail(message: string): never {
	throw new Unwritable(message);
}

export function writeMcpServers(
	assets: readonly AssetToWrite[],
	targets: ReadonlySet<RepositoryRuntime>,
	output: Output,
): void {
	const servers = new Map<string, { identity: string; server: Server }>();
	for (const asset of assets) {
		let server: Server;
		try {
			server = readServer(asset);
		} catch (error) {
			if (!(error instanceof Unwritable)) throw error;
			output.problem(asset.name, error.message);
			continue;
		}
		const identity = canonicalJson({
			...server,
			env: [...server.env],
			headers: [...server.headers],
		});
		const known = servers.get(asset.name);
		if (!known) servers.set(asset.name, { identity, server });
		else if (known.identity !== identity)
			output.problem(asset.name, "Another server has the same name");
	}
	if (servers.size === 0) return;

	for (const runtime of targets) {
		const emit = EMITTERS[runtime];
		if (!emit) continue;
		const written: Record<string, unknown> = {};
		for (const [name, { server }] of servers) {
			try {
				const entry = emit.server(server);
				const leftover = findRedacted(entry, "");
				if (leftover !== null) fail(`${leftover} was redacted and has no variable name`);
				written[name] = entry;
			} catch (error) {
				if (!(error instanceof Unwritable)) throw error;
				output.problem(name, `${RUNTIME_NAMES[runtime]}: ${error.message}`);
			}
		}
		if (Object.keys(written).length > 0) output.add(emit.path, emit.file(written), "mcp-server");
	}
}

function readServer(asset: AssetToWrite): Server {
	const [file, ...rest] = asset.files;
	if (!file || rest.length > 0) fail("Expected exactly one file");
	if (file.content === null) fail("The registry did not keep this asset's text");
	const parsed = file.path.endsWith(".toml")
		? parseTomlConfig(file.content)
		: parseJsonConfig(file.content);
	if (!parsed.ok) fail(parsed.message);
	const stored = parsed.value;
	const dialect: Dialect = file.path.endsWith(".toml")
		? "codex"
		: ["httpUrl", "trust", "includeTools", "excludeTools"].some((key) => key in stored)
			? "gemini"
			: "json";

	// Secrets are gone from everything but `env` and `headers`, so a placeholder elsewhere is final.
	const others = Object.fromEntries(
		Object.entries(stored).filter(
			([key]) => !["env", "headers", "http_headers", "env_http_headers"].includes(key),
		),
	);
	const hidden = findRedacted(others, "");
	if (hidden !== null) fail(`${hidden} was redacted and has no variable name`);

	const env = new Map<string, Value>();
	const headers = new Map<string, Value>();
	for (const [key, value] of Object.entries(table(stored.env, "env"))) {
		env.set(key, valueFor(value, key, key, "env"));
	}
	for (const [key, value] of Object.entries(table(stored.headers, "headers"))) {
		headers.set(key, valueFor(value, key, headerVariable(key), "headers"));
	}
	if (dialect === "codex") {
		for (const name of stored.env_vars === undefined ? [] : list(stored.env_vars, "env_vars"))
			env.set(name, { ref: name, prefix: "" });
		for (const [key, value] of Object.entries(table(stored.http_headers, "http_headers"))) {
			headers.set(key, valueFor(value, key, headerVariable(key), "http_headers"));
		}
		for (const [key, value] of Object.entries(table(stored.env_http_headers, "env_http_headers"))) {
			if (typeof value !== "string" || !VARIABLE.test(value))
				fail(`env_http_headers.${key} is not a variable name`);
			headers.set(key, { ref: value, prefix: "" });
		}
		const bearer = stored.bearer_token_env_var;
		if (bearer !== undefined) {
			if (typeof bearer !== "string" || !VARIABLE.test(bearer))
				fail("bearer_token_env_var is not a variable name");
			headers.set("Authorization", { ref: bearer, prefix: "Bearer " });
		}
	}

	const cwd = typeof stored.cwd === "string" ? stored.cwd : undefined;
	const own = new Set(OWN_FIELDS[dialect]);
	const extras = Object.fromEntries(Object.entries(stored).filter(([key]) => !own.has(key)));
	return { dialect, transport: transportOf(stored, dialect), cwd, env, headers, extras };
}

function transportOf(stored: Record<string, unknown>, dialect: Dialect): Transport {
	if (typeof stored.command === "string") {
		const args = stored.args === undefined ? undefined : list(stored.args, "args");
		return { kind: "stdio", command: stored.command, args, typed: stored.type === "stdio" };
	}
	if (dialect === "gemini" && typeof stored.httpUrl === "string") {
		return { kind: "http", url: stored.httpUrl };
	}
	if (typeof stored.url !== "string") fail("The server has neither a command nor a URL");
	// Gemini's `url` is SSE. Elsewhere the type says, and streamable HTTP is the default.
	if (dialect === "gemini") return { kind: "sse", url: stored.url };
	if (stored.type === "sse") return { kind: "sse", url: stored.url };
	if (stored.type === undefined || stored.type === "http" || stored.type === "streamable-http") {
		return { kind: "http", url: stored.url };
	}
	return fail(`The transport "${String(stored.type)}" is not supported`);
}

function table(value: unknown, field: string): Record<string, unknown> {
	if (value === undefined) return {};
	if (!isPlainObject(value)) fail(`${field} is not a table`);
	return value;
}

function list(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		fail(`${field} is not a list of text`);
	}
	return value as string[];
}

/** `X-Team` is `X_TEAM`: a header has no variable of its own name, so one is made from it. */
function headerVariable(header: string): string {
	return header.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function valueFor(value: unknown, key: string, fallback: string, field: string): Value {
	if (typeof value !== "string") fail(`${field}.${key} is not text`);
	if (value === REDACTED) {
		if (!VARIABLE.test(fallback))
			fail(`${field}.${key} has no name that an environment variable can have`);
		return { ref: fallback, prefix: "" };
	}
	const reference = REFERENCE.exec(value);
	const name = reference?.[2] ?? reference?.[3];
	if (reference && name) return { ref: name, prefix: reference[1] ?? "" };
	return value;
}

/** The path of the first `<redacted>` inside a value, or null. */
function findRedacted(value: unknown, path: string): string | null {
	if (typeof value === "string") return value.includes(REDACTED) ? path || "A value" : null;
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = findRedacted(item, `${path}[${index}]`);
			if (found !== null) return found;
		}
	} else if (isPlainObject(value)) {
		for (const [key, item] of Object.entries(value)) {
			const found = findRedacted(item, path === "" ? key : `${path}.${key}`);
			if (found !== null) return found;
		}
	}
	return null;
}

interface Emitter {
	path: string;
	server(server: Server): Record<string, unknown>;
	file(servers: Record<string, unknown>): string;
}

/** `Bearer ${TOKEN}` in the target's template syntax; plain text stays as it is. */
function template(value: Value, reference: (name: string) => string): string {
	return typeof value === "string" ? value : `${value.prefix}${reference(value.ref)}`;
}

function templates(
	values: Map<string, Value>,
	reference: (name: string) => string,
): Record<string, string> {
	return Object.fromEntries(
		[...values]
			.sort(([a], [b]) => compare(a, b))
			.map(([key, value]) => [key, template(value, reference)]),
	);
}

/** Claude Code and Cursor share the `mcpServers` file shape and differ in template and `type`. */
function jsonEmitter(
	path: string,
	reference: (name: string) => string,
	options: { typed: boolean },
): Emitter {
	return {
		path,
		file: (servers) => canonicalJson({ mcpServers: servers }),
		server(server) {
			const entry: Record<string, unknown> = server.dialect === "json" ? { ...server.extras } : {};
			const { transport } = server;
			if (transport.kind === "stdio") {
				entry.command = transport.command;
				if (transport.args) entry.args = transport.args;
				if (server.env.size > 0) entry.env = templates(server.env, reference);
				if (server.cwd !== undefined) {
					if (server.dialect !== "json") fail("The format has no working directory (cwd)");
					entry.cwd = server.cwd;
				}
				if (transport.typed && options.typed) entry.type = "stdio";
			} else {
				entry.url = transport.url;
				if (options.typed) entry.type = transport.kind;
				if (server.headers.size > 0) entry.headers = templates(server.headers, reference);
			}
			return entry;
		},
	};
}

const gemini: Emitter = {
	path: ".gemini/settings.json",
	file: (servers) => canonicalJson({ mcpServers: servers }),
	server(server) {
		const entry: Record<string, unknown> = server.dialect === "gemini" ? { ...server.extras } : {};
		const { transport } = server;
		const reference = (name: string) => `\${${name}}`;
		if (transport.kind === "stdio") {
			entry.command = transport.command;
			if (transport.args) entry.args = transport.args;
			if (server.env.size > 0) entry.env = templates(server.env, reference);
			if (server.cwd !== undefined) entry.cwd = server.cwd;
		} else {
			entry[transport.kind === "http" ? "httpUrl" : "url"] = transport.url;
			if (server.headers.size > 0) entry.headers = templates(server.headers, reference);
		}
		return entry;
	},
};

const codex: Emitter = {
	path: ".codex/config.toml",
	file: (servers) => canonicalToml({ mcp_servers: servers }),
	server(server) {
		const entry: Record<string, unknown> = server.dialect === "codex" ? { ...server.extras } : {};
		const { transport } = server;
		if (transport.kind === "sse") fail("Only streamable HTTP servers are supported, not SSE");
		if (transport.kind === "stdio") {
			entry.command = transport.command;
			if (transport.args) entry.args = transport.args;
			if (server.cwd !== undefined) entry.cwd = server.cwd;
			const literal: Record<string, string> = {};
			const forwarded: string[] = [];
			for (const [key, value] of [...server.env].sort(([a], [b]) => compare(a, b))) {
				if (typeof value === "string") literal[key] = value;
				// `env_vars` forwards a variable under its own name, so it cannot rename one.
				else if (value.ref === key && value.prefix === "") forwarded.push(key);
				else fail(`env.${key} refers to ${value.ref}, and Codex can only forward ${key} itself`);
			}
			if (Object.keys(literal).length > 0) entry.env = literal;
			if (forwarded.length > 0) entry.env_vars = forwarded;
			return entry;
		}
		entry.url = transport.url;
		const literal: Record<string, string> = {};
		const named: Record<string, string> = {};
		for (const [key, value] of [...server.headers].sort(([a], [b]) => compare(a, b))) {
			if (typeof value === "string") literal[key] = value;
			else if (value.prefix === "") named[key] = value.ref;
			else if (key.toLowerCase() === "authorization" && value.prefix === "Bearer ") {
				entry.bearer_token_env_var = value.ref;
			} else fail(`headers.${key} has text around its variable, which Codex cannot express`);
		}
		if (Object.keys(literal).length > 0) entry.http_headers = literal;
		if (Object.keys(named).length > 0) entry.env_http_headers = named;
		return entry;
	},
};

const EMITTERS: Partial<Record<RepositoryRuntime, Emitter>> = {
	"claude-code": jsonEmitter(".mcp.json", (name) => `\${${name}}`, { typed: true }),
	cursor: jsonEmitter(".cursor/mcp.json", (name) => `\${env:${name}}`, { typed: false }),
	"gemini-cli": gemini,
	codex,
};
