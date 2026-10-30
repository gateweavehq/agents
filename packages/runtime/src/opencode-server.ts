/**
 * OpenCode's server in the sandbox (AGT-50): `opencode serve`, started once per container and
 * driven over HTTP, so that a turn skips what `opencode run` spends before its first request:
 * starting Bun, loading the settings, plugins and MCP servers, and opening the database. On one
 * vCPU that was about 4 s a turn, and on staging's `standard-1` about 9 s; a turn on the running
 * server reaches its first request in a few tens of milliseconds. The container's first turn pays
 * for the server's start instead.
 *
 * The turn's events come out as `opencode run --format json` prints them, so `OpenCodeTurn`
 * (`./opencode.ts`) reads them as it did that command's.
 *
 * Checked 2026-10-30 against OpenCode 1.19.5, in its source (the tag `v1.19.5` of
 * github.com/anomalyco/opencode) and with its server against fake model APIs:
 * - `opencode run --attach` would skip the start too, but with `--format json` it prints nothing:
 *   it returns as soon as its prompt is sent, without waiting for the events (`finish` in
 *   `cli/cmd/run.ts`). So the sandbox speaks to the server itself, as that command does.
 * - the routes, from its `/doc`: `GET /global/health`; `POST /session` and `GET /session/{id}`;
 *   `POST /session/{id}/prompt_async`, which answers 204 at once; `GET /event`, the project's
 *   events as server-sent events, `server.connected` first; `POST /session/{id}/abort`;
 *   `POST /permission/{id}/reply`; and `POST /mcp/{name}/connect`. `?directory=` picks the
 *   project, as the working directory picks it for `opencode run`.
 * - what `run` prints, and when (`loop` in `cli/cmd/run.ts`): an update of a part of its own
 *   session, as `step_start`, `step_finish`, `text` once the text has ended and `tool_use` once
 *   the tool has its result; a `session.error` as `error`; and it ends when the session's status
 *   is idle. With `--auto` it answers each `permission.asked` with `once`, and the sessions it
 *   makes deny `question`, `plan_enter` and `plan_exit`, which would wait for someone.
 * - the server reads the instruction files, the repository's `AGENTS.md` and those in
 *   `instructions`, at each prompt (`session/instruction.ts`), but lists an MCP server's tools only
 *   when it connects to it (`mcp/index.ts`): reconnecting `gateweave` at the start of a turn lists
 *   the turn's own. It reads its settings when it starts, so it starts over when a turn's differ.
 * - a stopped prompt ends with a `session.error` named `MessageAbortedError`, then idle.
 */
import { z } from "zod";
import { ENGINE_TOOLS_SERVER } from "./engine-tools";
import { type EngineJob, enginePrompt } from "./engines";
import { failureForLogs } from "./models";
import { openCodeSettings } from "./opencode";

/** The port the server listens on in the sandbox. */
export const OPENCODE_PORT = 4096;

/** Where the server's own messages go, those of every turn. */
export const OPENCODE_SERVER_LOG = "/tmp/opencode-server.log";

/** Where the server's exit status goes when it exits. */
export const OPENCODE_SERVER_EXIT = "/tmp/opencode-server.exit";

/**
 * Starts the server with the settings in `OPENCODE_SETTINGS`, the variables it runs with as JSON,
 * unless it runs with those already, then prints whether it started one and how long its log was.
 *
 * - The server outlives the command that starts it (`setsid`), and its exit status is written when
 *   it exits.
 * - It listens on every address of the container: the Worker reaches it through the container's
 *   port (`getTcpPort`), and nothing else reaches the container.
 * - It asks for no password. Anything in the sandbox that could reach it can run `opencode` itself,
 *   and only the turn under way gets its requests out (`SandboxOutbound`).
 * - Its log keeps what it writes to its standard error: its warnings and errors, such as a
 *   provider's refusal. Its standard output has only its banner, which warns of the password.
 */
export const OPENCODE_SERVER_SCRIPT = `set -u
settings=/tmp/opencode-server.settings pid=/tmp/opencode-server.pid
status=${OPENCODE_SERVER_EXIT} log=${OPENCODE_SERVER_LOG}
from=$(stat -c %s "$log" 2>/dev/null || echo 0)
if [ -s "$pid" ] && kill -0 "$(cat "$pid")" 2>/dev/null \\
  && [ "$(cat "$settings" 2>/dev/null)" = "$OPENCODE_SETTINGS" ]; then
  echo "running $from"
  exit 0
fi
if [ -s "$pid" ]; then
  old=$(cat "$pid")
  kill "$old" 2>/dev/null
  for _ in $(seq 100); do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done
  kill -9 "$old" 2>/dev/null
fi
rm -f "$pid" "$status"
printf '%s' "$OPENCODE_SETTINGS" > "$settings"
setsid nohup bash -c 'opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT} --print-logs --log-level WARN >/dev/null &
echo $! > "$1"; wait $!; echo $? > "$2"' opencode-server "$pid" "$status" >> "$log" 2>&1 < /dev/null &
echo "started $from"
`;

/** What a turn reaches of the sandbox to drive OpenCode's server. */
export interface OpenCodeServerPort {
	/**
	 * Makes sure the server runs with these variables, starting it, or starting it over, if not,
	 * as `OPENCODE_SERVER_SCRIPT` does. Says how long its log was before the turn.
	 */
	ensure(env: Record<string, string>): Promise<{ logFrom: number }>;
	/** A request to the server: a path, with its query. */
	fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** A turn of OpenCode on its server. */
export interface OpenCodeServerTurn {
	/** The conversation's session, which its next turn continues; null when it has none yet. */
	session: string | null;
	/** How long the server's log was when the turn began, so its own messages can be told apart. */
	logFrom: number;
	/** The turn's events, a JSON object a line, as `opencode run --format json` prints them. */
	events: ReadableStream<Uint8Array>;
	/** Settles once the events have ended. */
	ended: Promise<void>;
	/**
	 * Stops the turn as Ctrl+C stops `opencode run`: the server stops the session, and the events
	 * end without the failure that says so. They end anyway after `graceMs`.
	 */
	stop(): Promise<void>;
}

export interface OpenCodeServerOptions {
	/** How long the server may take to answer once started. */
	startMs?: number;
	/** How often it is asked meanwhile. */
	pollMs?: number;
	/** How long a stopped turn has to end before its events end anyway. */
	graceMs?: number;
}

/** The title of the conversation's session, which spares a request to the model for one. */
export const OPENCODE_SESSION_TITLE = "Gateweave";

/** What `opencode run` denies the sessions it makes: each would wait for someone to answer. */
const DENIED_PERMISSIONS = ["question", "plan_enter", "plan_exit"].map((permission) => ({
	permission,
	action: "deny",
	pattern: "*",
}));

/** The failure that says a session was stopped, which `stop` leaves out. */
const ABORTED = "MessageAbortedError";

const START_MS = 120_000;
const POLL_MS = 250;
const GRACE_MS = 10_000;

/**
 * Starts a turn of the job on the sandbox's OpenCode server: makes sure it runs with the turn's
 * settings, reconnects Gateweave's tools so that it lists the turn's own, continues the
 * conversation's session if the server still has it, or starts one with the conversation so far,
 * and sends the message. A failure on the way comes out as the turn's one event, an `error` in
 * OpenCode's words, so the turn fails as when OpenCode itself does.
 */
export async function startOpenCodeTurn(
	server: OpenCodeServerPort,
	job: EngineJob,
	session: string | undefined,
	options: OpenCodeServerOptions = {},
): Promise<OpenCodeServerTurn> {
	const query = `directory=${encodeURIComponent(job.cwd)}`;
	const call = async (path: string, init?: RequestInit): Promise<Response> => {
		const response = await server.fetch(`${path}?${query}`, init);
		if (!response.ok) throw await ServerError.from(response);
		return response;
	};
	let logFrom = 0;
	let id: string | null = session ?? null;
	let events: ReadableStreamDefaultReader<string> | null = null;
	try {
		({ logFrom } = await server.ensure(openCodeSettings(job)));
		await waitForServer(server, options.startMs ?? START_MS, options.pollMs ?? POLL_MS);
		if (job.access.tools !== null) {
			await (await call(`/mcp/${ENGINE_TOOLS_SERVER}/connect`, post())).body?.cancel();
		}
		let resumed = false;
		if (session !== undefined) {
			const kept = await server.fetch(`/session/${session}?${query}`);
			await kept.body?.cancel();
			resumed = kept.ok;
		}
		let sessionId: string;
		if (resumed && session !== undefined) {
			sessionId = session;
		} else {
			const created = await call(
				"/session",
				post({ title: OPENCODE_SESSION_TITLE, permission: DENIED_PERMISSIONS }),
			);
			sessionId = createdSession.parse(await created.json()).id;
		}
		id = sessionId;
		const stream = await call("/event");
		if (!stream.body) throw new ServerError("its events could not be read");
		events = stream.body.pipeThrough(new TextDecoderStream()).getReader();
		const frames = new ServerEvents(events);
		// The events come only from when the stream opened, so the message waits for it.
		if ((await frames.next()) === null) throw new ServerError("its events ended at once");
		await (
			await call(
				`/session/${sessionId}/prompt_async`,
				post({
					model: { providerID: job.provider, modelID: job.model },
					parts: [{ type: "text", text: enginePrompt(job, resumed) }],
				}),
			)
		).body?.cancel();
		return follow(server, query, sessionId, logFrom, frames, options.graceMs ?? GRACE_MS);
	} catch (error) {
		await events?.cancel().catch(() => {});
		return failedTurn(id, logFrom, error);
	}
}

/** Asks the server until it answers, which a server just started takes a few seconds to do. */
async function waitForServer(
	server: OpenCodeServerPort,
	startMs: number,
	pollMs: number,
): Promise<void> {
	const deadline = Date.now() + startMs;
	for (;;) {
		try {
			const health = await server.fetch("/global/health");
			await health.body?.cancel();
			if (health.ok) return;
		} catch {
			// Not listening yet.
		}
		if (Date.now() >= deadline) {
			throw new ServerError(`its server did not answer within ${startMs / 1000} seconds`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/** A failure on the way to the turn, in the words its `error` event gives it. */
class ServerError extends Error {
	/** Reads OpenCode's own words for a refused request: `{ name, data: { message } }`. */
	static async from(response: Response): Promise<ServerError> {
		const said = serverFailure.safeParse(await response.json().catch(() => null));
		const words = said.success ? (said.data.data?.message ?? said.data.name) : undefined;
		return new ServerError(words ?? `its server answered ${response.status}`);
	}
}

const createdSession = z.object({ id: z.string() });

const serverFailure = z.object({
	name: z.string().optional(),
	data: z.object({ message: z.string().optional() }).loose().optional(),
});

/** A turn that failed before it started: its one event says why, as OpenCode's would. */
function failedTurn(session: string | null, logFrom: number, error: unknown): OpenCodeServerTurn {
	const message = error instanceof ServerError ? error.message : "its server could not be reached";
	if (!(error instanceof ServerError)) {
		console.error("OpenCode's server could not be reached", failureForLogs(error));
	}
	const line = JSON.stringify({
		type: "error",
		timestamp: Date.now(),
		error: { name: "ServerError", data: { message } },
	});
	return {
		session,
		logFrom,
		events: new Blob([`${line}\n`]).stream(),
		ended: Promise.resolve(),
		stop: async () => {},
	};
}

/** Reads server-sent events, one JSON object each. */
class ServerEvents {
	readonly #reader: ReadableStreamDefaultReader<string>;
	#buffer = "";

	constructor(reader: ReadableStreamDefaultReader<string>) {
		this.#reader = reader;
	}

	/** The next event's data, or null once the stream has ended. */
	async next(): Promise<unknown> {
		for (;;) {
			const end = /\r?\n\r?\n/.exec(this.#buffer);
			if (end) {
				const frame = this.#buffer.slice(0, end.index);
				this.#buffer = this.#buffer.slice(end.index + end[0].length);
				const data = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data === "") continue;
				try {
					return JSON.parse(data);
				} catch {
					continue;
				}
			}
			const { value, done } = await this.#reader.read();
			if (done) return null;
			this.#buffer += value;
		}
	}

	cancel(): void {
		this.#reader.cancel().catch(() => {});
	}
}

const partEvent = z.object({
	type: z.literal("message.part.updated"),
	properties: z.object({
		part: z
			.object({
				id: z.string(),
				sessionID: z.string(),
				type: z.string(),
				time: z.object({ end: z.number().optional() }).loose().optional(),
				state: z.object({ status: z.string() }).loose().optional(),
			})
			.loose(),
	}),
});
const sessionError = z.object({
	type: z.literal("session.error"),
	properties: z.object({
		sessionID: z.string().optional(),
		error: z.object({ name: z.string().optional() }).loose().optional(),
	}),
});
const sessionStatus = z.object({
	type: z.literal("session.status"),
	properties: z.object({ sessionID: z.string(), status: z.object({ type: z.string() }) }),
});
const sessionCreated = z.object({
	type: z.literal("session.created"),
	properties: z.object({
		info: z.object({ id: z.string(), parentID: z.string().optional() }),
	}),
});
const permissionAsked = z.object({
	type: z.literal("permission.asked"),
	properties: z.object({ id: z.string(), sessionID: z.string() }),
});

/**
 * The turn's events, from the server's: what `opencode run --format json --auto` would print of
 * them, and its answers to permissions, until the session is idle or the stream ends.
 */
function follow(
	server: OpenCodeServerPort,
	query: string,
	session: string,
	logFrom: number,
	frames: ServerEvents,
	graceMs: number,
): OpenCodeServerTurn {
	const encoder = new TextEncoder();
	/** The session and those it started, whose permissions are answered too. */
	const sessions = new Set([session]);
	/** The parts printed already: each is printed once, however often it is updated after. */
	const printed = new Set<string>();
	let stopping = false;
	let closed = false;
	let grace: ReturnType<typeof setTimeout> | undefined;
	let settle = () => {};
	const ended = new Promise<void>((resolve) => {
		settle = resolve;
	});
	let output: ReadableStreamDefaultController<Uint8Array> | undefined;

	const close = () => {
		if (closed) return;
		closed = true;
		clearTimeout(grace);
		frames.cancel();
		output?.close();
		settle();
	};
	const print = (type: string, data: Record<string, unknown>) => {
		if (closed) return;
		const line = JSON.stringify({ type, timestamp: Date.now(), sessionID: session, ...data });
		output?.enqueue(encoder.encode(`${line}\n`));
	};
	const answer = (permission: string) => {
		server
			.fetch(`/permission/${permission}/reply?${query}`, post({ reply: "once" }))
			.then((response) => response.body?.cancel())
			.catch((error: unknown) => console.error("OpenCode's permission was not answered", error));
	};
	/** Prints what the event says of the turn; true once the turn is over. */
	const take = (event: unknown): boolean => {
		const part = partEvent.safeParse(event);
		if (part.success) {
			const { id, sessionID, type, time, state } = part.data.properties.part;
			const kind =
				type === "step-start"
					? "step_start"
					: type === "step-finish"
						? "step_finish"
						: type === "text" && time?.end !== undefined
							? "text"
							: type === "tool" && (state?.status === "completed" || state?.status === "error")
								? "tool_use"
								: null;
			if (sessionID !== session || kind === null || printed.has(id)) return false;
			printed.add(id);
			print(kind, { part: (event as { properties: { part: unknown } }).properties.part });
			return false;
		}
		const status = sessionStatus.safeParse(event);
		if (status.success) {
			const { sessionID, status: now } = status.data.properties;
			return sessionID === session && now.type === "idle";
		}
		const error = sessionError.safeParse(event);
		if (error.success) {
			const { sessionID, error: failure } = error.data.properties;
			if (sessionID !== session || failure === undefined) return false;
			if (!(stopping && failure.name === ABORTED)) {
				print("error", { error: (event as { properties: { error: unknown } }).properties.error });
			}
			return false;
		}
		const created = sessionCreated.safeParse(event);
		if (created.success) {
			const { id, parentID } = created.data.properties.info;
			if (parentID !== undefined && sessions.has(parentID)) sessions.add(id);
			return false;
		}
		const asked = permissionAsked.safeParse(event);
		if (asked.success && sessions.has(asked.data.properties.sessionID)) {
			answer(asked.data.properties.id);
		}
		return false;
	};

	const events = new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller;
			void (async () => {
				try {
					for (;;) {
						const event = await frames.next();
						if (event === null || closed || take(event)) break;
					}
				} catch (error) {
					if (!closed) console.error("OpenCode's events broke off", error);
				} finally {
					close();
				}
			})();
		},
		cancel() {
			close();
		},
	});

	return {
		session,
		logFrom,
		events,
		ended,
		stop: async () => {
			if (closed || stopping) return;
			stopping = true;
			grace = setTimeout(close, graceMs);
			try {
				const response = await server.fetch(`/session/${session}/abort?${query}`, post());
				await response.body?.cancel();
			} catch {
				close();
			}
		},
	};
}

function post(body?: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}
