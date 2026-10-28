import type { EnvSetEntry } from "@gateweave/agents-model";
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
import { formatVariables, parseSecretNames, parseVariables } from "#/lib/environment-text";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * Creates an environment set, or edits `set`: its variables as `NAME=value` lines and the names
 * of its secrets. Secret values are never part of it; they are stored one by one.
 */
export function EnvSetDialog({
	set,
	onSave,
	onClose,
}: {
	set?: EnvSetEntry;
	onSave: (input: {
		name: string;
		variables: Record<string, string>;
		secrets: string[];
	}) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(set?.asset.name ?? "");
	const [variables, setVariables] = useState(formatVariables(set?.variables ?? {}));
	const [secrets, setSecrets] = useState(
		set?.secrets.map((secret) => secret.name).join("\n") ?? "",
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const parsed = parseVariables(variables);
		if (!parsed.ok) {
			setError(parsed.error);
			return;
		}
		setPending(true);
		setError(null);
		try {
			await onSave({
				name: name.trim(),
				variables: parsed.variables,
				secrets: parseSecretNames(secrets),
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
						<DialogTitle>{set ? `Edit ${set.asset.name}` : "New environment set"}</DialogTitle>
						<DialogDescription>
							Variables are saved as a version of the set and everyone in the workspace can read
							them. Put anything private in a secret: only its name is saved here.
						</DialogDescription>
					</DialogHeader>
					{!set && (
						<div className="space-y-2">
							<Label htmlFor="env-name">Name</Label>
							<Input
								id="env-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={200}
								autoFocus
								required
							/>
						</div>
					)}
					<div className="space-y-2">
						<Label htmlFor="env-variables">Variables</Label>
						<Textarea
							id="env-variables"
							value={variables}
							onChange={(event) => setVariables(event.target.value)}
							rows={6}
							spellCheck={false}
							placeholder="LOG_LEVEL=info"
							className="font-mono text-xs"
						/>
						<p className="text-xs text-muted-foreground">
							One NAME=value per line. Names use capital letters, digits and underscores.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="env-secrets">Secrets</Label>
						<Textarea
							id="env-secrets"
							value={secrets}
							onChange={(event) => setSecrets(event.target.value)}
							rows={3}
							spellCheck={false}
							placeholder="DATABASE_PASSWORD"
							className="font-mono text-xs"
						/>
						<p className="text-xs text-muted-foreground">
							Names only, one per line. Set each value after saving.
						</p>
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
						<Button type="submit" disabled={pending || (!set && !name.trim())}>
							{set ? "Save" : "Create set"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Types a secret's value. It goes to the registry, sealed, and is never shown again. */
export function SecretDialog({
	setName,
	name,
	replacing,
	onSave,
	onClose,
}: {
	setName: string;
	name: string;
	replacing: boolean;
	onSave: (value: string) => Promise<void>;
	onClose: () => void;
}) {
	const [value, setValue] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave(value);
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>
							<span className="font-mono">{name}</span>
						</DialogTitle>
						<DialogDescription>
							The value of this secret in {setName}. It is encrypted, and nobody can read it back
							here, not even an admin.
							{replacing ? " It replaces the value that is stored now." : ""}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="secret-value">Value</Label>
						<Input
							id="secret-value"
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							maxLength={10000}
							autoFocus
							required
						/>
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
						<Button type="submit" disabled={pending || value === ""}>
							{pending ? "Saving…" : "Save value"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
