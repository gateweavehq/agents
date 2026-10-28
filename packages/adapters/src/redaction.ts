/**
 * Secrets never leave the adapters. Repositories sometimes carry tokens in settings and MCP
 * configuration, so everything stored from those files goes through `redact` first, and the
 * result is written back in a canonical form so the same configuration always has the same text.
 */
import { stringify as stringifyToml } from "smol-toml";
import { isPlainObject } from "./util";

export const REDACTED = "<redacted>";

/**
 * Objects whose every value is replaced, whatever it is: environments, request headers and
 * query parameters, and Codex's `shell_environment_policy.set`, which sets environment variables.
 */
const SECRET_CONTAINERS = new Set(["env", "headers", "http_headers", "query_params", "set"]);
/** Keys that hold a credential in their own right, such as `CLIENT_SECRET` or `apiKey`. */
const SECRET_KEY =
	/(secret|password|passwd|token|api[-_]?key|private[-_]?key|access[-_]?key|credentials?|authorization)$/i;
/**
 * Credentials whose shape gives them away wherever they sit, such as a token passed as a plain
 * argument: GitHub, OpenAI and Anthropic, Slack, AWS access key ids, Google API keys.
 */
const KNOWN_CREDENTIAL =
	/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g;
const URL_KEYS = new Set(["url", "httpUrl"]);
/** `--token=abc`, `-e GITHUB_TOKEN=abc`: an argument that assigns a credential. */
const SECRET_ASSIGNMENT = /^(-{0,2}[\w-]*(?:token|secret|password|passwd|key|auth)[\w-]*=)(.+)$/is;
/** `--token abc`: a flag whose next argument is the credential. */
const SECRET_FLAG = /^--?[\w-]*(?:token|secret|password|passwd|key|auth)[\w-]*$/i;

/** `${GITHUB_TOKEN}` names a secret without containing it, which is how configuration should. */
function isReference(value: string): boolean {
	return /^\$\{[^}]*\}$|^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function redact(value: unknown, key = ""): unknown {
	if (SECRET_CONTAINERS.has(key)) return redactAll(value);
	if (Array.isArray(value)) {
		return key === "args" ? redactArguments(value) : value.map((item) => redact(item, key));
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
		);
	}
	if (typeof value === "string") {
		if (SECRET_KEY.test(key) && !isReference(value)) return REDACTED;
		const text = value.replace(KNOWN_CREDENTIAL, REDACTED);
		return URL_KEYS.has(key) ? redactUrl(text) : text;
	}
	if (typeof value === "number" && SECRET_KEY.test(key)) {
		return REDACTED;
	}
	return value;
}

function redactAll(value: unknown): unknown {
	if (isPlainObject(value)) {
		return Object.fromEntries(Object.keys(value).map((name) => [name, REDACTED]));
	}
	return REDACTED;
}

function redactArguments(args: unknown[]): unknown[] {
	let afterFlag = false;
	return args.map((item) => {
		if (typeof item !== "string") {
			afterFlag = false;
			return item;
		}
		const arg = item.replace(KNOWN_CREDENTIAL, REDACTED);
		if (afterFlag && !arg.startsWith("-")) {
			afterFlag = false;
			return isReference(arg) ? arg : REDACTED;
		}
		afterFlag = SECRET_FLAG.test(arg);
		const assignment = SECRET_ASSIGNMENT.exec(arg);
		if (assignment?.[1] && assignment[2] !== undefined && !isReference(assignment[2])) {
			return `${assignment[1]}${REDACTED}`;
		}
		return arg;
	});
}

function redactUrl(url: string): string {
	return url
		.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#\s]*@/i, `$1${REDACTED}@`)
		.replace(
			/([?&][^=&#]*(?:token|secret|password|key|auth|sig)[^=&#]*=)([^&#]*)/gi,
			(_match, name: string, value: string) => `${name}${isReference(value) ? value : REDACTED}`,
		);
}

/** The names under an object such as `env` or `headers`; their values are never read. */
export function namesIn(value: unknown): string[] {
	return isPlainObject(value) ? Object.keys(value).sort() : [];
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((name) => [name, sortKeys(value[name])]),
		);
	}
	return value;
}

/** Stable key order, two-space indent and a trailing newline. */
export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function canonicalToml(value: Record<string, unknown>): string {
	const text = stringifyToml(sortKeys(value) as Record<string, unknown>);
	return text.endsWith("\n") ? text : `${text}\n`;
}
