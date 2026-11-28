import { CHECK_LIMITS } from "@gateweave/agents-model";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import {
	type ChecksDraft,
	checksOfText,
	checksProblem,
	draftAfterRefresh,
	maySaveDraft,
} from "#/lib/repository-checks";

const MINUTES = CHECK_LIMITS.commandSeconds / 60;

/** Each command with a key of its own: the same command may be listed twice. */
function keyed(checks: string[]): { key: string; command: string }[] {
	const seen = new Map<string, number>();
	return checks.map((command) => {
		const nth = (seen.get(command) ?? 0) + 1;
		seen.set(command, nth);
		return { key: `${nth}:${command}`, command };
	});
}

/**
 * A repository's checks: the commands `open_pull_request` runs on an agent's work before
 * it pushes it. Every member sees them; owners and admins set them, one to a line.
 */
export function RepositoryChecks({
	checks,
	admin,
	onSave,
}: {
	checks: string[];
	admin: boolean;
	onSave: (checks: string[]) => Promise<void>;
}) {
	const id = useId();
	const saved = checks.join("\n");
	const [draft, setDraft] = useState<ChecksDraft>({ text: saved, base: saved });
	const [pending, setPending] = useState(false);
	const [confirmedSaved, setConfirmedSaved] = useState<string | null>(null);
	// The saved list can change under the form: a save of this form's own, someone else's, or a
	// refresh of the page. A draft without edits follows it; one with edits stays, and says so.
	const { text, base, stale } = draftAfterRefresh(draft, saved);
	if (base !== draft.base) setDraft({ text, base });
	const setText = (next: string) => {
		setDraft({ text: next, base });
		setConfirmedSaved(null);
	};
	const problem = checksProblem(text);
	const changed = checksOfText(text).join("\n") !== saved;

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (pending || problem !== null || !maySaveDraft(stale, saved, confirmedSaved)) return;
		setPending(true);
		try {
			const next = checksOfText(text);
			await onSave(next);
			setDraft({ text: next.join("\n"), base: next.join("\n") });
			setConfirmedSaved(null);
			toast.success(next.length === 0 ? "Checks removed" : "Checks saved");
		} catch (error) {
			toast.error("Could not save the checks", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setPending(false);
		}
	}

	return (
		<section aria-labelledby={`${id}-heading`} className="space-y-3">
			<h2 id={`${id}-heading`} className="text-sm font-medium">
				Checks before a pull request
			</h2>
			<p id={`${id}-about`} className="text-sm text-muted-foreground">
				When an agent proposes its work on this repository, Gateweave runs these commands in the
				agent's sandbox on the work as committed, in order, before anything is pushed. If one fails,
				no pull request is opened and the agent is told what failed; after{" "}
				{CHECK_LIMITS.failedRounds} failed rounds in one run the pull request is opened as a draft.
				The pull request ends with a section, written by Gateweave, that lists each command that ran
				with its exit code and how long it took, and marks one that did not as not run. Each command
				may run for {MINUTES} minutes. Every member of the workspace sees these commands, and each
				pull request shows them: keep keys and passwords out of them.
			</p>
			{admin ? (
				<form onSubmit={onSubmit} className="space-y-2">
					<Textarea
						aria-labelledby={`${id}-heading`}
						aria-describedby={`${id}-about ${id}-hint`}
						aria-invalid={problem !== null}
						value={text}
						onChange={(event) => setText(event.target.value)}
						// What is typed while a save is under way would be lost to what was saved.
						readOnly={pending}
						placeholder={"pnpm check\npnpm typecheck\npnpm test"}
						// One line more than a repository can have, so a line too many is seen, not scrolled to.
						rows={Math.max(3, Math.min(CHECK_LIMITS.commands + 1, text.split("\n").length))}
						spellCheck={false}
						className="font-mono"
					/>
					<p
						id={`${id}-hint`}
						role={problem === null ? undefined : "alert"}
						className={
							problem === null ? "text-xs text-muted-foreground" : "text-xs text-destructive"
						}
					>
						{problem ??
							`One command to a line, at most ${CHECK_LIMITS.commands}, each run with bash in the repository's root. Leave it empty for no checks.`}
					</p>
					{stale && (
						<div role="status" className="space-y-2 text-xs text-muted-foreground">
							<p>The saved checks changed while you were editing. The current saved checks are:</p>
							<pre className="whitespace-pre-wrap break-all rounded border p-2">
								{saved || "(none)"}
							</pre>
							<p>Replacing them removes any commands absent from your draft.</p>
							<button
								type="button"
								className="underline underline-offset-2"
								onClick={() => {
									setDraft({ text: saved, base: saved });
									setConfirmedSaved(null);
								}}
							>
								Show the saved checks instead
							</button>
							{confirmedSaved !== saved && (
								<button
									type="button"
									className="ml-3 underline underline-offset-2"
									onClick={() => setConfirmedSaved(saved)}
								>
									Review and replace saved checks
								</button>
							)}
						</div>
					)}
					<Button
						type="submit"
						size="sm"
						disabled={
							pending || problem !== null || !changed || !maySaveDraft(stale, saved, confirmedSaved)
						}
					>
						{pending ? "Saving checks…" : stale ? "Confirm replacement" : "Save checks"}
					</Button>
				</form>
			) : checks.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					None are set. An owner or admin of the workspace can set them.
				</p>
			) : (
				<ol className="divide-y rounded-lg border font-mono text-sm">
					{keyed(checks).map(({ key, command }) => (
						<li key={key} className="break-all p-3">
							{command}
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
