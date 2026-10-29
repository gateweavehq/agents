/**
 * What a sandbox may reach. Its container has no internet of its own: every HTTP and HTTPS request
 * it makes comes to the Worker (`SandboxOutbound` in `./sandbox.ts`), which asks this. Package
 * registries are open for downloads, so a turn can install what a project needs, and github.com is
 * open for fetching the one repository the agent checks out; nothing else is, so what the sandbox
 * holds cannot be sent anywhere.
 */

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

/** The repository a sandbox's git may fetch from GitHub. */
export interface GitRepository {
	owner: string;
	name: string;
}

/**
 * Whether a request from a sandbox goes out, and why not, in words a command prints. A request to
 * GitHub that goes out does so with a token for the repository, which the Worker adds.
 */
export type OutboundDecision =
	| { allow: true; credentials?: "github" }
	| { allow: false; reason: string };

export function decideOutbound(
	method: string,
	url: URL,
	repository: GitRepository | null = null,
): OutboundDecision {
	const host = url.hostname;
	if (url.protocol !== "https:") return refuse(`${host} is reachable only over HTTPS`);
	if (host === GITHUB && url.port === "") return decideGitHub(method, url, repository);
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
 * Git's smart HTTP fetch of the agent's repository, and nothing else: the refs (`info/refs` for
 * `git-upload-pack`) and the pack. Pushing is `git-receive-pack`, which is refused.
 */
function decideGitHub(method: string, url: URL, repository: GitRepository | null) {
	if (!repository) {
		return refuse(`${GITHUB} is not reachable from this sandbox: its agent has no repository`);
	}
	const only = refuse(
		`${GITHUB} is reachable from this sandbox only to fetch ${repository.owner}/${repository.name}`,
	);
	const rest = gitPath(url.pathname, repository);
	if (rest === null) return only;
	const service = url.searchParams.get("service");
	if (rest === "/git-receive-pack" || service === "git-receive-pack") {
		return refuse(`This sandbox cannot push to ${GITHUB}`);
	}
	const refs = rest === "/info/refs" && method === "GET" && service === "git-upload-pack";
	const pack = rest === "/git-upload-pack" && method === "POST";
	return refs || pack ? ({ allow: true, credentials: "github" } as const) : only;
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

/** The request as git sent it, with the token the way GitHub takes it over HTTPS. */
export function withGitHubToken(request: Request, token: string): Request {
	const headers = new Headers(request.headers);
	headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
	return new Request(request, { headers });
}

function refuse(reason: string): OutboundDecision {
	return { allow: false, reason };
}
