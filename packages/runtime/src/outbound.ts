/**
 * What a sandbox may reach. Its container has no internet of its own: every HTTP and HTTPS request
 * it makes comes to the Worker (`SandboxOutbound` in `./sandbox.ts`), which asks this. Package
 * registries are open for downloads, so a turn can install what a project needs, and github.com is
 * open for fetching the one repository the agent checks out, and for the push of the
 * conversation's branch that `open_pull_request` makes. While an engine runs a turn
 * (`./engines.ts`), its provider's API is open to the CLI's requests for the model, and so is the
 * host where it finds Gateweave's tools, which only the Worker answers (`./engine-tools.ts`).
 * Nothing else is, so what the sandbox holds cannot be sent anywhere.
 *
 * A request for the model is the one way out that carries what the sandbox chooses, with the
 * workspace's key added, so its contents are checked too (`checkModelRequest`), before the key is
 * (AGT-62). The providers run tools of their own on a request's behalf: Anthropic's MCP connector,
 * web search and fetch, code execution; OpenAI's MCP, web search, file search, code interpreter;
 * Google's search, URL context and code execution. Any of them would send what the request holds
 * to an address the request names, or run it elsewhere. So a request names only tools the CLI
 * runs itself, fetches no file or image by URL, calls only the turn's model, and goes out with
 * only the headers the engines need (`forwardedHeaders`), the betas among them by name. A request
 * that does otherwise gets a 403 and a failed span in the run's trace that says why.
 */
import {
	MODEL_PROVIDER_NAMES,
	type ModelProvider,
	PULL_REQUEST_TOOL,
} from "@gateweave/agents-model";

/** The hosts a sandbox downloads packages from: npm, PyPI, crates.io and Go's module proxy. */
export const PACKAGE_REGISTRIES: readonly string[] = [
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
];

const GITHUB = "github.com";

/** Where Claude Code, and OpenCode with an Anthropic model, send their requests for the model. */
export const ANTHROPIC_API = "api.anthropic.com";

/** Where Codex, and OpenCode with an OpenAI model, send their requests for the model. */
export const OPENAI_API = "api.openai.com";

/** Where OpenCode with a Google model sends its requests for the model. */
export const GOOGLE_API = "generativelanguage.googleapis.com";

/**
 * `@ai-sdk/google` posts to `/v1beta/models/<model>:generateContent`, and to
 * `/v1beta/models/<model>:streamGenerateContent?alt=sse` to stream (`doGenerate` and `doStream` in
 * its `dist/index.js`). A model's name holds neither a slash nor a colon.
 */
const GOOGLE_MODEL_PATH = /^\/v1beta\/models\/[^/:]+:(generateContent|streamGenerateContent)$/;

const GOOGLE_STREAM_QUERY = "?alt=sse";

/** Anthropic's count of a request's tokens, which no model answers and costs nothing. */
const ANTHROPIC_COUNT = "/v1/messages/count_tokens";

/**
 * The paths of each provider's API that the engines' requests for the model use: Anthropic's
 * Messages API, OpenAI's Responses API over HTTPS (`./codex.ts` turns Codex's WebSocket off),
 * compactions included, and Google's `generateContent` and `streamGenerateContent` for a model,
 * which `@ai-sdk/google` posts to (`GOOGLE_STREAM_QUERY` below is the query of the latter).
 */
const MODEL_APIS: readonly ModelApi[] = [
	{
		provider: "anthropic",
		host: ANTHROPIC_API,
		paths: new Set(["/v1/messages", ANTHROPIC_COUNT]),
	},
	{ provider: "openai", host: OPENAI_API, paths: new Set(["/v1/responses"]) },
	{ provider: "google", host: GOOGLE_API, paths: GOOGLE_MODEL_PATH },
];

interface ModelApi {
	provider: "anthropic" | "openai" | "google";
	host: string;
	/** The paths the engine's requests use: exact ones, or a pattern. */
	paths: ReadonlySet<string> | RegExp;
}

/** Whether a request to a provider's API is one of the engine's requests for the model. */
function isModelRequest(api: ModelApi, method: string, url: URL): boolean {
	if (method !== "POST") return false;
	if (api.paths instanceof RegExp) {
		if (!api.paths.test(url.pathname)) return false;
		// Streaming asks for server-sent events; the other takes no query. A `key` parameter, which
		// Google also takes, would let a request carry a key of its own.
		const streams = url.pathname.endsWith(":streamGenerateContent");
		return url.search === (streams ? GOOGLE_STREAM_QUERY : "");
	}
	return api.paths.has(url.pathname);
}

/** Whether an engine's request to a provider is one the model answers, which the trace meters. */
export function isMeteredRequest(url: URL): boolean {
	return !(url.hostname === ANTHROPIC_API && url.pathname === ANTHROPIC_COUNT);
}

/** The providers whose APIs an engine calls from the sandbox. */
export type EngineProvider = ModelApi["provider"];

/**
 * The most of a request for the model the Worker reads to check it. Checking holds a request's
 * text and its parsed value at once, about four times its size, and a Worker's isolate has
 * 128 MB for every request it serves: so less than Anthropic's own 32 MB. A long context of text
 * is a few MB; images are what come near it.
 */
export const MAX_MODEL_REQUEST_BYTES = 16_000_000;

/**
 * The headers a request for the model keeps, for every provider: the rest, such as a CLI's
 * telemetry, session ids and organization or project headers, stay in the Worker. The key goes on
 * after (`./models.ts`).
 */
const FORWARDED_HEADERS = ["content-type", "accept", "user-agent"];

/**
 * Anthropic's betas that a request may use, by name; the header goes out with the others dropped.
 * The engines' own: Claude Code 2.1.308 (the betas its binary names, checked 2026-11-02), and
 * OpenCode 1.19.5 with `@ai-sdk/anthropic`. These change how the model answers, thinks, caches or
 * counts. Left out are those of other APIs (files, batches, environments, managed agents, MCP
 * servers and tunnels, memory), server tools (web search, advisor), and those that let the
 * provider answer with another model or at another price (server-side fallback, fast mode).
 */
export const ANTHROPIC_BETAS: ReadonlySet<string> = new Set([
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"fine-grained-tool-streaming-2025-05-14",
	"context-1m-2025-08-07",
	"context-management-2025-06-27",
	"structured-outputs-2025-11-13",
	"structured-outputs-2025-12-15",
	"effort-2025-11-24",
	"task-budgets-2026-03-13",
	"pdfs-2024-09-25",
	"compact-2026-01-12",
	"extended-cache-ttl-2025-04-11",
	"prompt-caching-scope-2026-01-05",
	"prompt-caching-evict-2026-05-12",
	"cache-keepalive-2026-09-03",
	"cache-diagnosis-2026-04-07",
	"redact-thinking-2026-02-12",
	"thinking-resumption-2026-07-17",
	"thinking-token-count-2026-05-13",
	"thinking-display-updates-2026-08-18",
	"thinking-binding-controls-2026-08-01",
	"context-hint-2026-04-09",
	"mid-conversation-system-2026-04-07",
	"mid-conversation-system-clear-at-2026-08-21",
	"mid-conversation-tool-changes-2026-07-01",
	"per-turn-control-2026-07-01",
	"timing-2026-09-09",
	"inline-tools-2026-09-15",
	// Deferred tools and the `tool_reference` blocks Claude Code's own tool search answers with.
	// The search tools that run on Anthropic's side are refused as any server tool is.
	"advanced-tool-use-2025-11-20",
	"tool-search-tool-2025-10-19",
]);

/**
 * The headers a request for the model goes out with: `FORWARDED_HEADERS`, Anthropic's version, and
 * the betas of `ANTHROPIC_BETAS` it names. OpenAI's `OpenAI-Beta` is left out: Codex sends it only
 * on the WebSocket it does not use here.
 */
export function forwardedHeaders(provider: EngineProvider, headers: Headers): Headers {
	const kept = new Headers();
	for (const name of FORWARDED_HEADERS) {
		const value = headers.get(name);
		if (value !== null) kept.set(name, value);
	}
	if (provider === "anthropic") {
		const version = headers.get("anthropic-version");
		if (version !== null) kept.set("anthropic-version", version);
		const betas = (headers.get("anthropic-beta") ?? "")
			.split(",")
			.map((beta) => beta.trim())
			.filter((beta) => ANTHROPIC_BETAS.has(beta));
		if (betas.length > 0) kept.set("anthropic-beta", [...new Set(betas)].join(","));
	}
	return kept;
}

/**
 * The tool types OpenAI's API may take from the sandbox: those the CLI runs itself, `function`
 * and `custom` (Codex's `apply_patch`); a `namespace` of them (Codex groups an MCP server's tools
 * so); and `tool_search`, which looks only through the request's own deferred tools. Codex 0.165
 * names these; OpenCode sends `function` alone.
 */
const OPENAI_TOOLS: ReadonlySet<string> = new Set(["function", "custom", "tool_search"]);

/**
 * Why a request for the model may not go out, or null when it may: its body, already parsed, as
 * JSON. `model` is the turn's agent's, the only one the request may call.
 */
export function checkModelRequest(
	provider: EngineProvider,
	model: string,
	url: URL,
	body: unknown,
): string | null {
	if (!isObject(body)) return "A request for the model from this sandbox must be a JSON object";
	// Each provider takes its tools as a list; anything else would go unchecked.
	if (body.tools !== undefined && !Array.isArray(body.tools)) {
		return "A request for the model from this sandbox gives its tools as a list";
	}
	switch (provider) {
		case "anthropic":
			return checkAnthropic(model, body);
		case "openai":
			return checkOpenAI(model, body);
		case "google":
			return checkGoogle(model, url, body);
	}
}

function checkAnthropic(model: string, body: Record<string, unknown>): string | null {
	const name = MODEL_PROVIDER_NAMES.anthropic;
	if ("mcp_servers" in body) {
		return `This sandbox's requests to ${name} name no MCP servers: ${name} would call them`;
	}
	if ("container" in body) {
		return `This sandbox's requests to ${name} use no container: it would run code on ${name}'s side`;
	}
	const wrong = checkModel(name, model, body.model);
	if (wrong) return wrong;
	// They change what the workspace pays; no engine sets them here.
	if ("inference_geo" in body) {
		return `This sandbox's requests to ${name} choose no region to run in: it costs more`;
	}
	if (body.speed !== undefined && body.speed !== "standard") {
		return `This sandbox's requests to ${name} ask for no faster speed: it costs more`;
	}
	for (const tool of listOf(body.tools)) {
		const type = isObject(tool) ? tool.type : undefined;
		if (type !== undefined && type !== null && type !== "custom") {
			return `This sandbox's requests to ${name} take only tools the engine runs, not ${describe(type)}, which runs on ${name}'s side`;
		}
	}
	if (
		someBlock(body.messages, isAnthropicUrlSource) ||
		someBlock(body.system, isAnthropicUrlSource)
	) {
		return `This sandbox's requests to ${name} fetch no image or document by URL`;
	}
	return null;
}

function checkOpenAI(model: string, body: Record<string, unknown>): string | null {
	const name = MODEL_PROVIDER_NAMES.openai;
	const wrong = checkModel(name, model, body.model);
	if (wrong) return wrong;
	for (const tool of listOf(body.tools)) {
		const problem = openAIToolProblem(tool);
		if (problem) return `This sandbox's requests to ${name} ${problem}`;
	}
	if ("web_search_options" in body) {
		return `This sandbox's requests to ${name} take only tools the engine runs, not its web search`;
	}
	// A stored prompt brings tools of its own, which the request does not show.
	if ("prompt" in body) return `This sandbox's requests to ${name} use no stored prompt`;
	// Both read what the workspace's organization stored: Codex and OpenCode send neither, since
	// they store nothing (`store: false`) and send the whole conversation each time.
	for (const field of ["previous_response_id", "conversation"]) {
		if (field in body) {
			return `This sandbox's requests to ${name} read no stored response or conversation (${field})`;
		}
	}
	if (
		body.service_tier !== undefined &&
		body.service_tier !== null &&
		body.service_tier !== "auto" &&
		body.service_tier !== "default"
	) {
		return `This sandbox's requests to ${name} take the default service tier, not ${describe(body.service_tier)}`;
	}
	if (someBlock(body.input, isOpenAIStoredFile) || someBlock(body.messages, isOpenAIStoredFile)) {
		return `This sandbox's requests to ${name} read no stored file (file_id)`;
	}
	// The input of the Responses API, and the messages of chat completions.
	if (someBlock(body.input, isOpenAIUrlInput) || someBlock(body.messages, isOpenAIUrlInput)) {
		return `This sandbox's requests to ${name} fetch no image or file by URL`;
	}
	return null;
}

function openAIToolProblem(tool: unknown): string | null {
	const type = isObject(tool) ? tool.type : undefined;
	if (type === "namespace" && isObject(tool)) {
		for (const inner of listOf(tool.tools)) {
			const problem = openAIToolProblem(inner);
			if (problem) return problem;
		}
		return null;
	}
	if (typeof type === "string" && OPENAI_TOOLS.has(type)) return null;
	return `take only tools the engine runs, not ${describe(type)}, which runs on ${MODEL_PROVIDER_NAMES.openai}'s side`;
}

function checkGoogle(model: string, url: URL, body: Record<string, unknown>): string | null {
	const name = MODEL_PROVIDER_NAMES.google;
	const wrong = checkModel(name, model, googleModel(url));
	if (wrong) return wrong;
	for (const tool of listOf(body.tools)) {
		const others = isObject(tool)
			? Object.keys(tool).filter((key) => key !== "functionDeclarations")
			: [];
		if (!isObject(tool) || others.length > 0) {
			return `This sandbox's requests to ${name} take only the engine's function declarations as tools, not ${others.join(", ") || "that"}, which run on ${name}'s side`;
		}
	}
	// Google takes its fields in snake case too.
	// Cached content brings a system instruction and tools of its own, which the request does not
	// show.
	if ("cachedContent" in body || "cached_content" in body) {
		return `This sandbox's requests to ${name} use no cached content`;
	}
	// Anywhere in the body: the system instruction takes parts too.
	if (someBlock(body, isGoogleFileData)) {
		return `This sandbox's requests to ${name} name no file by its URI (fileData)`;
	}
	return null;
}

/** The model a request to Google names in its path, as `GOOGLE_MODEL_PATH` takes it. */
function googleModel(url: URL): string | null {
	const named = /^\/v1beta\/models\/([^/:]+):/.exec(url.pathname)?.[1];
	if (named === undefined) return null;
	try {
		return decodeURIComponent(named);
	} catch {
		return null;
	}
}

function checkModel(name: string, model: string, named: unknown): string | null {
	return named === model
		? null
		: `This sandbox calls only the agent's model ${model} from ${name}, not ${describe(named)}`;
}

/** A Google part that names a file by its URI, which Google would fetch or read. */
function isGoogleFileData(part: Record<string, unknown>): boolean {
	return [part.fileData, part.file_data].some(
		(data) => isObject(data) && ("fileUri" in data || "file_uri" in data),
	);
}

/** An Anthropic image or document whose source is a URL, which Anthropic would fetch. */
function isAnthropicUrlSource(block: Record<string, unknown>): boolean {
	return isObject(block.source) && block.source.type === "url";
}

/**
 * An OpenAI image or file given by the id of one stored in the workspace's organization: the
 * Responses API's `input_image` and `input_file`, and chat completions' `file`.
 */
function isOpenAIStoredFile(block: Record<string, unknown>): boolean {
	if (block.type === "input_image" || block.type === "input_file") {
		return block.file_id !== undefined && block.file_id !== null;
	}
	return block.type === "file" && isObject(block.file) && "file_id" in block.file;
}

/** An OpenAI image or file given by a URL other than a `data:` one, which OpenAI would fetch. */
function isOpenAIUrlInput(block: Record<string, unknown>): boolean {
	for (const key of ["image_url", "file_url"]) {
		const value = block[key];
		const target = isObject(value) ? value.url : value;
		if (target !== undefined && target !== null && !String(target).startsWith("data:")) return true;
	}
	return false;
}

/**
 * Whether any object in a request's messages is one `test` finds: content blocks, parts, and those
 * in tool results, at any depth. A tool call's own arguments are skipped (Anthropic's `tool_use`
 * input, Google's `functionCall`): the model wrote them, and the provider acts on none of it.
 */
function someBlock(value: unknown, test: (block: Record<string, unknown>) => boolean): boolean {
	if (Array.isArray(value)) return value.some((item) => someBlock(item, test));
	if (!isObject(value)) return false;
	if (test(value)) return true;
	return Object.entries(value).some(
		([key, inner]) =>
			!(key === "input" && value.type === "tool_use") &&
			key !== "functionCall" &&
			key !== "function_call" &&
			someBlock(inner, test),
	);
}

function listOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A value from a request, quoted for a refusal: short, and only if it is a string. */
function describe(value: unknown): string {
	if (typeof value !== "string") return "none";
	return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
}

/**
 * Where an engine finds Gateweave's tools. No such host exists outside the sandbox: the Worker
 * answers it, under a name no one can register.
 */
export const ENGINE_TOOLS_HOST = "tools.gateweave.internal";

/** The path the tools are answered at, on that host. */
export const ENGINE_TOOLS_PATH = "/mcp";

/** The repository a sandbox's git may fetch from GitHub. */
export interface GitRepository {
	owner: string;
	name: string;
}

/**
 * The one push a sandbox may make, while `open_pull_request` makes it (`RunnerSandbox.push`): the
 * conversation's branch, from where the conversation last left it.
 */
export interface PushWindow {
	branch: string;
	/** The commit the conversation last pushed to the branch; null before its first push. */
	from: string | null;
}

/** What a sandbox's git reaches on GitHub: its repository, and the push under way, if any. */
export interface GitAccess {
	repository: GitRepository;
	push: PushWindow | null;
}

/**
 * Whether a request from a sandbox goes out, and why not, in words a command prints. A request to
 * GitHub that goes out does so with a token for the repository, which the Worker adds: one that
 * reads, or one that writes for a push, whose ref updates the Worker checks against `push` first.
 */
export type OutboundDecision =
	| {
			allow: true;
			credentials?: "read" | "write" | "anthropic" | "openai" | "google" | "tools";
			push?: PushWindow;
	  }
	| { allow: false; reason: string };

/**
 * `provider` is the provider whose models the engine running a turn in the sandbox calls, if one
 * runs; a request for the model to that provider's API goes out with the workspace's key, which
 * the Worker puts in place of the placeholder. `tools` says whether that turn has Gateweave's
 * tools, which the conversation answers.
 */
export function decideOutbound(
	method: string,
	url: URL,
	access: GitAccess | null = null,
	provider: ModelProvider | null = null,
	tools = false,
): OutboundDecision {
	const host = url.hostname;
	if (host === ENGINE_TOOLS_HOST) {
		if (!tools) return refuse(`${host} answers this sandbox only while a turn has its tools`);
		return url.protocol === "http:" && url.port === "" && url.pathname === ENGINE_TOOLS_PATH
			? { allow: true, credentials: "tools" }
			: refuse(`${host} answers only at http://${host}${ENGINE_TOOLS_PATH}`);
	}
	if (url.protocol !== "https:") return refuse(`${host} is reachable only over HTTPS`);
	if (host === GITHUB && url.port === "") return decideGitHub(method, url, access);
	const api = MODEL_APIS.find((candidate) => candidate.host === host);
	if (api && url.port === "") {
		if (api.provider !== provider) {
			const name = MODEL_PROVIDER_NAMES[api.provider];
			return refuse(
				`${host} is reachable from this sandbox only while a turn calls ${name}'s models`,
			);
		}
		return isModelRequest(api, method, url)
			? { allow: true, credentials: api.provider }
			: refuse(`${host} takes only the engine's requests for the model from this sandbox`);
	}
	if (!PACKAGE_REGISTRIES.includes(host) || url.port !== "") {
		return refuse(`${host} is not reachable from this sandbox: only package registries are`);
	}
	// A download carries nothing out; publishing or posting could.
	if (method !== "GET" && method !== "HEAD") {
		return refuse(`${host} takes only downloads from this sandbox`);
	}
	return { allow: true };
}

/**
 * Git's smart HTTP with the agent's repository, and nothing else: a fetch (`info/refs` for
 * `git-upload-pack`, then the pack) at any time, and a push (the same for `git-receive-pack`) only
 * while a push window is open.
 */
function decideGitHub(method: string, url: URL, access: GitAccess | null): OutboundDecision {
	if (!access) {
		return refuse(`${GITHUB} is not reachable from this sandbox: its agent has no repository`);
	}
	const { repository, push } = access;
	const only = refuse(
		`${GITHUB} is reachable from this sandbox only to fetch ${repository.owner}/${repository.name}`,
	);
	const rest = gitPath(url.pathname, repository);
	if (rest === null) return only;
	const service = url.searchParams.get("service");
	if (rest === "/git-receive-pack" || service === "git-receive-pack") {
		if (!push) {
			return refuse(`This sandbox cannot push to ${GITHUB}: ${PULL_REQUEST_TOOL} pushes the work`);
		}
		if (rest === "/info/refs" && method === "GET") return { allow: true, credentials: "write" };
		if (rest === "/git-receive-pack" && method === "POST") {
			return { allow: true, credentials: "write", push };
		}
		return only;
	}
	const refs = rest === "/info/refs" && method === "GET" && service === "git-upload-pack";
	const pack = rest === "/git-upload-pack" && method === "POST";
	return refs || pack ? { allow: true, credentials: "read" } : only;
}

/** What follows the repository in a path to it, `.git` or not; GitHub ignores case in both names. */
function gitPath(pathname: string, repository: GitRepository): string | null {
	const lower = pathname.toLowerCase();
	const base = `/${repository.owner}/${repository.name}`.toLowerCase();
	for (const prefix of [`${base}.git/`, `${base}/`]) {
		if (lower.startsWith(prefix)) return pathname.slice(prefix.length - 1);
	}
	return null;
}

/** One ref a push changes: from the commit it is at to another. */
export interface RefUpdate {
	ref: string;
	from: string;
	to: string;
}

const OBJECT_ID = "[0-9a-f]{40}|[0-9a-f]{64}";
const COMMAND = new RegExp(`^(${OBJECT_ID}) (${OBJECT_ID}) (refs/[^\\s\\0]+)$`);
const NO_OBJECT = /^0+$/;

/**
 * The ref updates a push's request starts with: git's commands to `git-receive-pack`, each a
 * pkt-line, up to a flush packet. Null when the body does not start that way, or holds anything
 * else before its pack, such as a signed push's certificate.
 */
export function pushedRefs(body: Uint8Array): RefUpdate[] | null {
	const text = new TextDecoder();
	const updates: RefUpdate[] = [];
	let at = 0;
	for (;;) {
		const size = text.decode(body.subarray(at, at + 4));
		if (!/^[0-9a-f]{4}$/.test(size)) return null;
		const length = Number.parseInt(size, 16);
		if (length === 0) break;
		if (length <= 4 || at + length > body.length) return null;
		const line = text.decode(body.subarray(at + 4, at + length));
		at += length;
		// The first command carries git's capabilities after a NUL.
		const command = COMMAND.exec(line.split("\0")[0]?.replace(/\n$/, "") ?? "");
		if (!command) return null;
		const [, from = "", to = "", ref = ""] = command;
		updates.push({ ref, from, to });
	}
	return updates.length > 0 ? updates : null;
}

/**
 * Why a push is refused, or null when it is the one update its window allows: the branch, made or
 * moved on from the commit the conversation left it at. So a push never deletes the branch, never
 * touches another ref, and never drops commits someone else pushed to it since.
 */
export function checkPush(updates: RefUpdate[] | null, push: PushWindow): string | null {
	const only = `This sandbox pushes only to ${push.branch}`;
	if (updates === null || updates.length !== 1) return only;
	const [update] = updates;
	if (!update || update.ref !== `refs/heads/${push.branch}`) return only;
	if (NO_OBJECT.test(update.to)) return `This sandbox does not delete ${push.branch}`;
	if (!NO_OBJECT.test(update.from) && update.from !== push.from) {
		return `Someone else pushed to ${push.branch}, and this sandbox does not push over their commits`;
	}
	return null;
}

/** The request as git sent it, with the token the way GitHub takes it over HTTPS. */
export function withGitHubToken(request: Request, token: string): Request {
	const headers = new Headers(request.headers);
	headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
	return new Request(request, { headers });
}

function refuse(reason: string): OutboundDecision {
	return { allow: false, reason };
}
