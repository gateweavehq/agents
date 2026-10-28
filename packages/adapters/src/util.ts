/** Small helpers shared by the adapters: paths, text limits and ordering. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** The directory of a path, or "" for a file at the repository root. */
export function dirname(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Splits a path at the first `root/` that starts a path segment, so `.claude/skills` matches at
 * the repository root and in a monorepo package alike. `rest` is never empty.
 */
export function under(path: string, root: string): { prefix: string; rest: string } | null {
	const needle = `${root}/`;
	let from = 0;
	for (;;) {
		const at = path.indexOf(needle, from);
		if (at === -1) return null;
		if (at === 0 || path[at - 1] === "/") {
			const rest = path.slice(at + needle.length);
			return rest === "" ? null : { prefix: path.slice(0, at), rest };
		}
		from = at + 1;
	}
}

export function withoutExtension(path: string, extension: string): string {
	return path.endsWith(extension) ? path.slice(0, -extension.length) : path;
}

/** `.env` files hold secrets; no adapter downloads or stores them. */
export function isEnvFile(path: string): boolean {
	const name = basename(path);
	return name === ".env" || name.startsWith(".env.");
}

/** Cuts text to at most `max` UTF-16 units, the way the model's limits count, without splitting a pair. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}…`;
}

/** A non-empty string, trimmed; anything else is null. */
export function str(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text === "" ? null : text;
}

/** The first line of prose in Markdown, without heading marks. */
export function firstLine(body: string): string | null {
	for (const line of body.split(/\r?\n/)) {
		const text = line.replace(/^#+\s*/, "").trim();
		if (text !== "") return text;
	}
	return null;
}

export function messageOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncate(message.split("\n")[0] ?? message, 200);
}
