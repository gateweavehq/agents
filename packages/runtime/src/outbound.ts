/**
 * What a sandbox may reach. Its container has no internet of its own: every HTTP and HTTPS request
 * it makes comes to the Worker (`SandboxOutbound` in `./sandbox.ts`), which asks this. Package
 * registries are open for downloads, so a turn can install what a project needs; nothing else is,
 * so what the sandbox holds cannot be sent anywhere.
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

export type OutboundDecision = { allow: true } | { allow: false; reason: string };

/** Whether a request from a sandbox goes out, and why not, in words a command prints. */
export function decideOutbound(method: string, url: URL): OutboundDecision {
	const host = url.hostname;
	if (url.protocol !== "https:") return refuse(`${host} is reachable only over HTTPS`);
	if (!PACKAGE_REGISTRIES.includes(host) || url.port !== "") {
		return refuse(`${host} is not reachable from this sandbox: only package registries are`);
	}
	// A download carries nothing out; publishing or posting could.
	if (method !== "GET" && method !== "HEAD") {
		return refuse(`${host} takes only downloads from this sandbox`);
	}
	return { allow: true };
}

function refuse(reason: string): OutboundDecision {
	return { allow: false, reason };
}
