import { parseDocument } from "yaml";
import { isPlainObject, messageOf } from "./util";

export type FrontMatter =
	| { ok: true; data: Record<string, unknown>; body: string }
	| { ok: false; message: string };

const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** A byte order mark before the first `---` is part of the file's encoding, not its text. */
function withoutBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Reads the YAML block between the first two `---` lines. A file without one has empty data.
 * `lenient` falls back to `key: value` lines when the YAML is invalid, for Cursor's `.mdc` files,
 * whose `globs: *.ts` is not YAML but is what Cursor's own editor writes.
 */
export function parseFrontMatter(text: string, options: { lenient?: boolean } = {}): FrontMatter {
	const source = withoutBom(text);
	const match = FRONT_MATTER.exec(source);
	if (!match) return { ok: true, data: {}, body: source };
	const raw = match[1] ?? "";
	const body = source.slice(match[0].length);
	// `parse` hides errors at the silent log level, so read the document and look at its errors.
	const document = parseDocument(raw, { logLevel: "silent" });
	let value: unknown;
	let failure: unknown = document.errors[0];
	if (!failure) {
		try {
			// An alias with no anchor (`globs: *.ts`) parses, then fails here.
			value = document.toJS();
		} catch (error) {
			failure = error;
		}
	}
	if (failure) {
		if (options.lenient) return { ok: true, data: parseLines(raw), body };
		return { ok: false, message: `Front matter is not valid YAML: ${messageOf(failure)}` };
	}
	if (value === null || value === undefined) return { ok: true, data: {}, body };
	if (!isPlainObject(value)) return { ok: false, message: "Front matter is not a mapping" };
	return { ok: true, data: value, body };
}

function parseLines(raw: string): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = /^([A-Za-z][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
		if (!match?.[1]) continue;
		const text = (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
		data[match[1]] = text === "true" ? true : text === "false" ? false : text;
	}
	return data;
}
