import {
	MEMORY_KIND_NAMES,
	MEMORY_KINDS,
	MEMORY_LIMITS,
	MEMORY_SCOPE_NAMES,
	MEMORY_SCOPES,
	type MemoryKind,
	type MemoryScope,
} from "@gateweave/agents-model";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import type { MemoryEntry, MemoryTargets } from "#/lib/memory";
import { dayOf, expiryOf } from "#/lib/memory-expiry";

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** What the form hands back: a memory's own fields, and what it is about for a new one. */
export interface MemoryForm {
	text: string;
	kind: MemoryKind;
	scope: MemoryScope;
	scopeId: string | null;
	sourceLabel: string | null;
	sourceUrl: string | null;
	expiresAt: number | null;
}

/**
 * Adds a memory, or edits `memory`. What a memory is about is chosen once: an edit changes its
 * text, kind, source and end date, and leaves who wrote it as it was.
 */
export function MemoryDialog({
	memory,
	targets,
	onSave,
	onClose,
}: {
	memory?: MemoryEntry;
	targets: MemoryTargets;
	onSave: (form: MemoryForm) => Promise<void>;
	onClose: () => void;
}) {
	const [text, setText] = useState(memory?.text ?? "");
	const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? "fact");
	const [scope, setScope] = useState<MemoryScope>(memory?.scope ?? "workspace");
	const [scopeId, setScopeId] = useState(memory?.scopeId ?? "");
	const [sourceLabel, setSourceLabel] = useState(memory?.source.label ?? "");
	const [sourceUrl, setSourceUrl] = useState(memory?.source.url ?? "");
	const [expires, setExpires] = useState(dayOf(memory?.expiresAt ?? null));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const choices = {
		workspace: [],
		agent: targets.agents,
		repository: targets.repositories,
		person: targets.people,
	}[scope];

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave({
				text: text.trim(),
				kind,
				scope,
				scopeId: scope === "workspace" ? null : scopeId,
				sourceLabel: sourceLabel.trim() || null,
				sourceUrl: sourceUrl.trim() || null,
				expiresAt: expiryOf(expires, memory?.expiresAt ?? null),
			});
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-lg">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{memory ? "Edit memory" : "New memory"}</DialogTitle>
						<DialogDescription>
							{memory && !memory.trusted
								? "This memory waits for approval. Saving it changes its text; agents recall it only once it is approved."
								: "Agents with memory recall this in later runs, as a note with who wrote it. Keep it to what should outlast a conversation, and put no secret in it."}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="memory-text">Text</Label>
						<Textarea
							id="memory-text"
							value={text}
							onChange={(event) => setText(event.target.value)}
							rows={5}
							maxLength={MEMORY_LIMITS.text}
							placeholder="Deploys go out on Tuesdays, after the team's review."
							autoFocus
							required
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="memory-kind">Kind</Label>
							<select
								id="memory-kind"
								className={SELECT}
								value={kind}
								onChange={(event) => setKind(event.target.value as MemoryKind)}
							>
								{MEMORY_KINDS.map((option) => (
									<option key={option} value={option}>
										{MEMORY_KIND_NAMES[option]}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="memory-expires">Recalled until</Label>
							<Input
								id="memory-expires"
								type="date"
								value={expires}
								onChange={(event) => setExpires(event.target.value)}
							/>
						</div>
					</div>
					{!memory && (
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="memory-scope">About</Label>
								<select
									id="memory-scope"
									className={SELECT}
									value={scope}
									onChange={(event) => {
										setScope(event.target.value as MemoryScope);
										setScopeId("");
									}}
								>
									{MEMORY_SCOPES.map((option) => (
										<option key={option} value={option}>
											{MEMORY_SCOPE_NAMES[option]}
										</option>
									))}
								</select>
							</div>
							{scope !== "workspace" && (
								<div className="space-y-2">
									<Label htmlFor="memory-scope-id">{MEMORY_SCOPE_NAMES[scope]}</Label>
									<select
										id="memory-scope-id"
										className={SELECT}
										value={scopeId}
										onChange={(event) => setScopeId(event.target.value)}
										required
									>
										<option value="">Choose…</option>
										{choices.map((choice) => (
											<option key={choice.id} value={choice.id}>
												{choice.name}
											</option>
										))}
									</select>
								</div>
							)}
						</div>
					)}
					<p className="text-xs text-muted-foreground">
						{
							{
								workspace: "Every agent with memory recalls what is about the workspace.",
								agent: "Only that agent recalls what is about it.",
								repository: "The agents that work in that repository recall it.",
								person: "Agents recall it in the runs that person's messages start.",
							}[scope]
						}{" "}
						Without a date, it is recalled until someone deletes it.
					</p>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="memory-source">Source</Label>
							<Input
								id="memory-source"
								value={sourceLabel}
								onChange={(event) => setSourceLabel(event.target.value)}
								maxLength={MEMORY_LIMITS.sourceLabel}
								placeholder="Planning notes, 4 November"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="memory-source-url">Link</Label>
							<Input
								id="memory-source-url"
								type="url"
								value={sourceUrl}
								onChange={(event) => setSourceUrl(event.target.value)}
								maxLength={2000}
								placeholder="https://"
							/>
						</div>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || !text.trim()}>
							{memory ? "Save" : "Add memory"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
