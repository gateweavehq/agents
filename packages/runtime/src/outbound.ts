/**
 * What a sandbox may reach. Its container has no internet of its own: every HTTP and HTTPS request
 * it makes comes to the Worker (`SandboxOutbound` in `./sandbox.ts`), which asks this. Package
 * registries are open for downloads, so a turn can install what a project needs, and github.com is
 * open for fetching the one repository the agent checks out, and for the push of the
 * conversation's branch that `open_pull_request` makes. While an engine runs a turn
 * (`./engines.ts`), its provider's API is open to the CLI's requests for the model, and so is the
 * host where it finds Gateweave's tools, which only the Worker answers (`./engine-tools.ts`).
 * Nothing else is, so what the sandbox holds cannot be sent anywhere.
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
		paths: new Set(["/v1/messages", "/v1/messages/count_tokens"]),
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
