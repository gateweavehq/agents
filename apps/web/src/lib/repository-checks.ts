import { repositoryChecksInput } from "@gateweave/agents-model";

/**
 * A repository's checks as the form on its page holds them: one command to a line. No server
 * code, so the page reads these too.
 */

/** The commands one to a line, without the blank ones, as the form's text is read. */
export function checksOfText(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/** The form's text, and the saved list it was typed over, as text. */
export interface ChecksDraft {
	text: string;
	base: string;
}

/**
 * The form's draft once the page has the saved list again, which may be another than the draft
 * was typed over: someone else saved, or the page refreshed for another reason. A draft without
 * edits of its own takes the new list. One with edits is kept as it is and reported as stale, so
 * that nobody's typing is thrown away and nobody saves over a list they have not seen.
 */
export function draftAfterRefresh(
	draft: ChecksDraft,
	saved: string,
): ChecksDraft & { stale: boolean } {
	if (saved === draft.base) return { ...draft, stale: false };
	const typed = checksOfText(draft.text).join("\n");
	if (typed === draft.base || typed === saved) return { text: saved, base: saved, stale: false };
	return { ...draft, stale: true };
}

/** A stale draft may replace the saved list only after that exact list was reviewed. */
export function maySaveDraft(
	stale: boolean,
	saved: string,
	confirmedSaved: string | null,
): boolean {
	return !stale || confirmedSaved === saved;
}

/** Wait for the saved list to reach the route before the form adopts it as its baseline. */
export async function saveChecksAndRefresh(
	checks: string[],
	save: (checks: string[]) => Promise<unknown>,
	invalidate: (options: { sync: true }) => Promise<void>,
): Promise<void> {
	await save(checks);
	await invalidate({ sync: true });
}

/** Why the form's text cannot be saved, in the schema's own words; null when it can. */
export function checksProblem(text: string): string | null {
	const read = repositoryChecksInput.safeParse(checksOfText(text));
	return read.success ? null : (read.error.issues[0]?.message ?? "These checks cannot be saved");
}
