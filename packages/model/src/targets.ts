/** A target's complete value stays in the turn. Only kind and host belong in a trace. */
export interface ToolTarget {
	kind: "email" | "url" | "ip";
	value: string;
	host: string;
}

const ipHost = /^(?:\d+(?:\.\d+){3}|\[[\da-f:.]+\])$/i;
const dnsLabel = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;

export function normalizeHost(raw: string): string | null {
	if (raw.startsWith("[") && !raw.endsWith("]")) return null;
	if (!raw || raw.length > 255 || /[\s/@\\#?%]/u.test(raw)) return null;
	if (/^[a-z][a-z\d-]{0,62}$/i.test(raw) && !raw.endsWith("-") && !/^xn--/i.test(raw))
		return raw.toLowerCase();
	// URL's special-host parser handles IDNs and every IP spelling the runtime accepts.
	const name = raw.includes(":") && !raw.startsWith("[") ? `[${raw}]` : raw;
	try {
		const host = new URL(`http://${name}/`).hostname.replace(/\.$/, "");
		const labels = host.split(".");
		const suffix = labels.at(-1) ?? "";
		return ipHost.test(host) ||
			(host.length <= 253 &&
				labels.every((s) => dnsLabel.test(s)) &&
				(labels.length === 1 || (suffix.length >= 2 && !/^\d+$/.test(suffix))))
			? host
			: null;
	} catch {
		return null;
	}
}

const atomCharacter = "[\\p{L}\\p{M}\\p{N}!#$%&'*+/=?^_`{|}~-]";
const atom = `${atomCharacter}+`;
const mailbox = `(?:${atom}(?:\\.${atom})*|"(?:[^"\\\\\\r\\n]|\\\\.)+")`;
const domain = "(?:\\[[^\\]\\s]+\\]|[\\p{L}\\p{M}\\p{N}.\u3002\uff0e\uff61-]+)";
const address = new RegExp(`^(${mailbox})@(${domain})$`, "iu");

const argumentAddress = `(?:${mailbox}@+)+${domain}`;
const addressKey = new RegExp(`^${argumentAddress}$`, "iu");

function emailTarget(raw: string): ToolTarget | null {
	const parts = address.exec(raw);
	if (!parts?.[1] || !parts[2] || parts[1].length > 64) return null;
	const literal = parts[2].startsWith("[");
	const name = literal ? parts[2].slice(1, -1).replace(/^IPv6:/i, "") : parts[2];
	const host = normalizeHost(name);
	if (!host || (literal && !ipHost.test(host))) return null;
	const suffix = literal && !host.startsWith("[") ? `[${host}]` : host;
	return { kind: "email", value: `${parts[1].toLowerCase()}@${suffix}`, host };
}

function multipleAtTarget(raw: string): ToolTarget | null {
	const last = raw.lastIndexOf("@");
	if (raw.indexOf("@") === last) return null;
	const host = normalizeHost(raw.slice(last + 1));
	return host
		? { kind: "email", value: raw.slice(0, last).toLowerCase() + "@" + host, host }
		: null;
}

/** A settings entry must name exactly one destination. */
export function normalizeAllowedTarget(value: string): string | null {
	const text = normalizeText(value.trim());
	if (text.startsWith("@")) {
		const host = normalizeHost(text.slice(1));
		return host && !ipHost.test(host) ? `@${host}` : null;
	}
	return text.includes("@") ? (emailTarget(text)?.value ?? null) : normalizeHost(text);
}

function hostTarget(raw: string): ToolTarget | null {
	const host = normalizeHost(raw);
	return host ? { kind: ipHost.test(host) ? "ip" : "url", value: host, host } : null;
}

function urlTarget(url: string, named: boolean, implicitAuthority = false): ToolTarget | null {
	try {
		// Use the same host parser even for a custom scheme, whose opaque hosts preserve case.
		const { hostname } = new URL(url.startsWith("//") ? `http:${url}` : url);
		if (!hostname) return null;
		const host = normalizeHost(new URL(`http://${hostname}/`).hostname);
		if (!host) return null;
		// A zero first octet also identifies every packed number below 2^24, in any base.
		if (
			!implicitAuthority &&
			/^(?:\/\/|[a-z][a-z0-9+.-]*:\/(?!\/))/i.test(url) &&
			host.startsWith("0.") &&
			ipHost.test(host)
		)
			return null;
		if (ipHost.test(host) && (implicitAuthority || !/^(?:\/\/|[a-z][a-z0-9+.-]*:\/)/i.test(url))) {
			const authority = url.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/*/i, "").split(/[/?#]/, 1)[0] ?? "";
			const rawHost = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
			if (!validIpSpelling(rawHost, host, named)) return null;
		}
		return { kind: ipHost.test(host) ? "ip" : "url", value: host, host };
	} catch {
		return null;
	}
}

const destinationWord =
	/^(?:uri|href|domains?|callback|redirect|links?|website|recipients?|emails?|mail|address(?:es)?|destination|receiver|remote|site)$/;
const hostField =
	/^(?:hosts?|hostnames?|servers?|fqdns?|endpoints?|urls?|webhooks?|proxy|proxies)$/;
const recipientKey =
	/^(?:send|forward|reply|mail|email|deliver|post|notify|copy|redirect)[_-]?(to|cc|bcc)$/i;
const shortDestination = /^(?:to|cc|bcc|src|ip|dest|target|origin|from|replyto)$/;

function destinationPart(key: string): string {
	const parts = key
		.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.split(/[_.-]/);
	const last = parts.at(-1) ?? "";
	if (hostField.test(last) || destinationWord.test(last)) return last;
	const recipient = recipientKey.exec(key)?.[1];
	if (recipient) return recipient.toLowerCase();
	const whole = key.toLowerCase();
	return shortDestination.test(whole) ? whole : "";
}

function validIpSpelling(raw: string, host: string, named: boolean): boolean {
	const name = raw.replace(/\.$/, "");
	if (name.startsWith("[") || (named && name.includes(":"))) return true;
	const parts = name.split(".");
	if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255))
		return true;
	if (!named) return false;
	// The canonical first octet is nonzero at and above 2^24, in every input base.
	if (parts.length === 1) return !host.startsWith("0.");
	return parts.some((part) => /^0x/i.test(part)) || parts.length < 4;
}

const fileExtensions = new Set(
	"js ts tsx jsx mjs cjs json md txt yaml yml toml lock html css scss py go rs rb java kt sh ps1 xml csv log png jpg jpeg gif svg webp pdf zip gz tar c h cc cpp hpp cs php sql vue svelte mdx ini conf cfg env map wasm jsonl tsv ipynb swift m mm scala dart lua r pl ex exs erl hs clj tf hcl proto gradle bat cmd".split(
		" ",
	),
);
// Consume a URL as a unit so credentials, path and query never become independent trusted targets.
const dottedAuthority = String.raw`(?<![\p{L}\p{M}\p{N}_./@-])(?<name>[\p{L}\p{M}\p{N}.-]+\.(?<suffix>[a-z]{2,24}))(?::(?<port>\d+)(?![\w:-]|\.[\w.-])|(?=/))(?:[/?#][^\s<>"')]*)?`;
const explicitTarget = new RegExp(
	`(?<![a-z0-9+.-])(?:(?:[a-z][a-z0-9+.-]*:)?//|https?:/)[^\\s<>"']+|(?<![^\\s(])\\.{0,2}/(?!/)[^\\s)]*|(?<!\\.)(?<!${atomCharacter})${argumentAddress}|${dottedAuthority}`,
	"giu",
);

// What a skipped file path's tail can still name: a URL with its own authority, or an address.
const tailTarget = new RegExp(
	`(?<![a-z0-9+.-])(?:(?:[a-z][a-z0-9+.-]*:)?//|https?:/)[^\\s<>"']+|(?<!\\.)(?<!${atomCharacter})${argumentAddress}`,
	"giu",
);

function* tailTargets(tail: string, named: boolean): Generator<ToolTarget> {
	for (const match of tail.matchAll(tailTarget)) yield* explicitTargets(match[0], named);
}

function* explicitTargets(raw: string, named: boolean): Generator<ToolTarget> {
	const target = /^(?:(?:[a-z][a-z0-9+.-]*:)?\/\/|https?:\/)/i.test(raw)
		? urlTarget(raw.replace(/(?<![),;.!])[),;.!]+$/, ""), named)
		: (emailTarget(raw) ?? multipleAtTarget(raw));
	if (target) yield target;
}

/** A dotted name a person wrote is a host unless it reads as a file name. */
function proseHost(target: ToolTarget): boolean {
	if (target.host === "localhost") return true;
	const suffix = /\.([a-z]{2,24})$/.exec(target.host)?.[1];
	return suffix !== undefined && !fileExtensions.has(suffix);
}

function* plainHosts(text: string, named: boolean, prose = false): Generator<ToolTarget> {
	for (const match of text.matchAll(/\[[\da-f:.]+\]|[\p{L}\p{M}\p{N}_.:\u3002\uff0e\uff61-]+/giu)) {
		const raw = match[0];
		const possibleIp = /^\d/.test(raw) || raw.startsWith("[") || raw.includes(":");
		if (!possibleIp && !named && !prose) continue;
		const name = raw.replace(/^([^:]+):\d+$/, "$1");
		const target = hostTarget(name);
		if (target?.kind === "ip") {
			if (validIpSpelling(name, target.host, named)) yield target;
		} else if (target && named && target.host.includes(".")) yield target;
		else if (target && prose && proseHost(target)) yield target;
	}
}

function normalizeText(text: string): string {
	return text
		.replace(/[。．｡]/g, ".")
		.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:)(?:[/\\]{2}|\\)/gi, "$1//");
}

function* textTargets(text: string, field: string, prose = false): Generator<ToolTarget> {
	const named = field !== "";
	const allowsLabel =
		hostField.test(field) && !(/^(?:proxy|proxies)$/.test(field) && /^none\.?(?::|$)/i.test(text));
	const label = text.replace(/\.$/, "");
	if (allowsLabel && /^[\p{L}\p{M}\p{N}-]+$/u.test(label) && !/^\d{4}-\d{2}-\d{2}$/.test(label)) {
		const target = hostTarget(label);
		if (target?.kind === "url") {
			yield target;
			return;
		}
	}
	// A whole URL may contain punctuation that ends a URL in prose.
	if (/^(?:(?:[a-z][a-z0-9+.-]*:)?\/\/|(?:https?|wss?|ftp):)[^\s<>"]+$/i.test(text)) {
		const target = urlTarget(text, named);
		if (target) yield target;
		return;
	}
	if (named && !/\s/.test(text) && /^[^/@:]+(?::\d|[/?#])/.test(text) && !text.includes("://")) {
		// Slashes and question marks are valid in a mailbox's local part.
		const target = emailTarget(text) ?? urlTarget(`//${text}`, named, true);
		const port = /^[^\s/@:]+:(\d+)(?:[/?#]|$)/.exec(text)?.[1];
		if (
			target &&
			(target.kind !== "url" ||
				target.host.includes(".") ||
				(allowsLabel && port && Number(port) >= 1) ||
				(allowsLabel && target.host === "localhost" && /^localhost\.?\//i.test(text)))
		)
			yield target;
		return;
	}
	if (!text.includes("@") && !text.includes("/") && !text.includes(":")) {
		yield* plainHosts(text, named, prose);
		return;
	}
	let start = 0;
	const scanner = new RegExp(explicitTarget);
	for (let match = scanner.exec(text); match; match = scanner.exec(text)) {
		const before = text.slice(start, match.index);
		// A recipient can be written as a display name followed by <mailbox>.
		yield* plainHosts(before, named && !before.trimEnd().endsWith("<"), prose);
		const raw = match[0];
		start = match.index + raw.length;
		const groups = match.groups;
		if (groups?.name && groups.suffix) {
			if (
				(named || !fileExtensions.has(groups.suffix.toLowerCase())) &&
				(!groups.port || (Number(groups.port) >= 1 && Number(groups.port) <= 65535))
			) {
				const target = hostTarget(groups.name);
				if (target) {
					yield target;
					// A query can carry another URL with its own authority.
					const nested = raw.search(/(?<![a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:\/\/|https?:\/|\/\/)/i);
					if (nested < 0) continue;
					scanner.lastIndex = start = match.index + nested;
					continue;
				}
			}
			// Rescanning the tail from here would repeat for every file name in it: read it once.
			yield* tailTargets(raw.slice(groups.name.length), named);
			continue;
		}
		// A relative path can contain dotted filenames or addresses in its segments.
		if (/^\.{0,2}\/(?!\/)/.test(raw)) continue;
		yield* explicitTargets(raw, named);
	}
	yield* plainHosts(text.slice(start), named, prose);
}

/** Walk JSON iteratively: tools and engines can wrap structured input in strings more than once. */
export function* targetsIn(value: unknown, trustedProse = false): Generator<ToolTarget> {
	const pending = [{ value, field: "" }];
	while (pending.length) {
		const entry = pending.pop();
		if (!entry) break;
		const { value, field } = entry;
		if (Array.isArray(value)) {
			for (const child of value) pending.push({ value: child, field });
		} else if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value)) {
				pending.push({ value: child, field: trustedProse ? "" : destinationPart(key) });
				const name = normalizeText(key);
				if ((name.includes("@") && addressKey.test(name)) || /^[a-z][a-z0-9+.-]*:\/\//i.test(name))
					yield* textTargets(name, "");
			}
		} else if (typeof value === "string") {
			const text = value.trim();
			if (/^[{["]/.test(text)) {
				try {
					pending.push({ value: JSON.parse(text), field });
					continue;
				} catch {
					// Quoted display names and bracketed IP addresses can start the same way.
				}
			}
			yield* textTargets(normalizeText(text), field, trustedProse);
		} else if (
			typeof value === "number" &&
			Number.isInteger(value) &&
			field !== "" &&
			value >= 2 ** 24
		) {
			const target = hostTarget(String(value));
			if (target?.kind === "ip") yield target;
		}
	}
}

export function targetTrusted(target: ToolTarget, trusted: ReadonlySet<string>): boolean {
	return trusted.has(target.value) || (target.kind === "email" && trusted.has(`@${target.host}`));
}
