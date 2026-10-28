import type { Project, Repository } from "@gateweave/agents-model";
import { Lock } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
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

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/** Names a new project, or renames `project`. */
export function ProjectDialog({
	project,
	onSave,
	onClose,
}: {
	project?: Project;
	onSave: (input: { name: string; description: string | null }) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(project?.name ?? "");
	const [description, setDescription] = useState(project?.description ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave({ name: name.trim(), description: description.trim() || null });
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
						<DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
						<DialogDescription>
							A project groups the repositories of one product or initiative. A repository can be in
							several.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="project-name">Name</Label>
						<Input
							id="project-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							autoFocus
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="project-description">Description</Label>
						<Textarea
							id="project-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							maxLength={2000}
							rows={3}
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
						<Button type="submit" disabled={pending || !name.trim()}>
							{project ? "Save" : "Create project"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Chooses which of the workspace's repositories are in `project`. */
export function RepositoriesDialog({
	project,
	repositories,
	onSave,
	onClose,
}: {
	project: Project;
	repositories: Repository[];
	onSave: (repositoryIds: string[]) => Promise<void>;
	onClose: () => void;
}) {
	const [chosen, setChosen] = useState(() => new Set(project.repositoryIds));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(id: string, on: boolean) {
		setChosen((current) => {
			const next = new Set(current);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	}

	async function save() {
		setPending(true);
		setError(null);
		try {
			// In the list's order, so the result reads the same as the choice.
			await onSave(repositories.filter((r) => chosen.has(r.id)).map((r) => r.id));
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
				<DialogHeader>
					<DialogTitle>Repositories in {project.name}</DialogTitle>
					<DialogDescription>
						{repositories.length === 0
							? "Connect GitHub in the workspace's settings to list repositories here."
							: "The agents of the repositories you choose show on the project's page."}
					</DialogDescription>
				</DialogHeader>
				{repositories.length > 0 && (
					<ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
						{repositories.map((repository) => (
							<li key={repository.id}>
								<Label className="flex cursor-pointer items-center gap-3 p-3 font-normal hover:bg-accent/50">
									<Checkbox
										checked={chosen.has(repository.id)}
										onCheckedChange={(checked) => toggle(repository.id, checked === true)}
									/>
									<span className="min-w-0 flex-1 truncate">
										<span className="text-muted-foreground">{repository.owner}/</span>
										{repository.name}
									</span>
									{repository.private && (
										<Lock
											aria-label="Private"
											className="size-3.5 shrink-0 text-muted-foreground"
										/>
									)}
								</Label>
							</li>
						))}
					</ul>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<DialogFooter className="gap-2">
					<Button variant="outline" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button onClick={save} disabled={pending || repositories.length === 0}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
