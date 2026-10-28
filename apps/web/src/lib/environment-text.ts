/**
 * The environment set dialog edits variables as `NAME=value` lines, as an `.env` file has them,
 * and secret names as a list. These turn that text into the registry's input and back.
 */
import { envName } from "@gateweave/agents-model";

export type ParsedVariables =
	| { ok: true; variables: Record<string, string> }
	| { ok: false; error: string };

/**
 * One variable per line, split at the first `=`; the value is the rest of the line as written.
 * Blank lines and lines starting with `#` are skipped.
 */
export function parseVariables(text: string): ParsedVariables {
	const variables: Record<string, string> = {};
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trimStart();
		if (line === "" || line.startsWith("#")) continue;
		const at = line.indexOf("=");
		if (at < 1) return { ok: false, error: `Line ${index + 1}: write NAME=value` };
		const name = line.slice(0, at).trim();
		if (!envName.safeParse(name).success) {
			return {
				ok: false,
				error: `Line ${index + 1}: ${name} is not a valid name (use A-Z, 0-9 and _)`,
			};
		}
		if (name in variables) return { ok: false, error: `Line ${index + 1}: ${name} appears twice` };
		variables[name] = line.slice(at + 1);
	}
	return { ok: true, variables };
}

export function formatVariables(variables: Record<string, string>): string {
	return Object.entries(variables)
		.map(([name, value]) => `${name}=${value}`)
		.join("\n");
}

/** Names separated by newlines, commas or spaces; repeated names count once. */
export function parseSecretNames(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter((name) => name !== ""))];
}
