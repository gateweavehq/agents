/**
 * The MCP server dialog edits headers as `Name: value` lines, as an HTTP request has them. These
 * turn that text into the registry's input and back; the registry checks each header itself.
 */

export type ParsedHeaders =
	| { ok: true; headers: { name: string; value: string }[] }
	| { ok: false; error: string };

/** One header per line, split at the first `:`. Blank lines and lines starting with `#` are skipped. */
export function parseHeaders(text: string): ParsedHeaders {
	const headers: { name: string; value: string }[] = [];
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const at = line.indexOf(":");
		if (at < 1) return { ok: false, error: `Line ${index + 1}: write Name: value` };
		headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
	}
	return { ok: true, headers };
}

export function formatHeaders(headers: { name: string; value: string }[]): string {
	return headers.map(({ name, value }) => `${name}: ${value}`).join("\n");
}
