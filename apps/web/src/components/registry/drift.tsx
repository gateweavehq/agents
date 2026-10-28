import type { DriftFileState, DriftState, Repository, SetupDrift } from "@gateweave/agents-model";
import { useRouter } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/button";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime } from "#/lib/dates";
import { applySetup } from "#/lib/registry";
import { cn } from "#/lib/utils";
import { ApplySetupDialog } from "./setup-dialogs";

const DRIFT_STATES: Record<DriftState, { label: string; description: string; className: string }> =
	{
		missing: {
			label: "Missing",
			description: "Files the setup wrote are gone from the repository",
			className: "text-destructive",
		},
		changed: {
			label: "Changed",
			description: "Files the setup wrote were edited in the repository",
			className: "text-orange-700 dark:text-orange-400",
		},
		behind: {
			label: "Behind",
			description: "The setup writes something newer than the repository holds",
			className: "text-amber-700 dark:text-amber-500",
		},
		unscanned: {
			label: "Waiting for a scan",
			description: "Merged after the repository was last scanned",
			className: "text-muted-foreground",
		},
		in_sync: {
			label: "In sync",
			description: "The repository holds what the setup writes",
			className: "text-emerald-700 dark:text-emerald-400",
		},
	};

const FILE_STATES: Record<DriftFileState, string> = {
	missing: "Deleted in the repository",
	changed: "Edited in the repository",
	behind: "The setup writes something else now",
};

/** How a repository compares with a setup merged into it, in a word or two. */
export function DriftBadge({ state }: { state: DriftState }) {
	const { label, description, className } = DRIFT_STATES[state];
	return (
		<span
			title={description}
			className={cn("rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap", className)}
		>
			{label}
		</span>
	);
}

/**
 * One setup merged into one repository: how they compare, the files that differ and why, and
 * applying the setup again when they differ.
 */
export function DriftRow({
	title,
	drift,
	setup,
	repository,
	admin,
}: {
	/** The setup or the repository, whichever the page is not about. */
	title: ReactNode;
	drift: SetupDrift;
	setup: { id: string; name: string };
	/** The repository as the GitHub App reaches it, for applying again. */
	repository: Repository | undefined;
	admin: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [applying, setApplying] = useState(false);
	const { merged, open, files, state } = drift;
	const differs = state === "missing" || state === "changed" || state === "behind";
	const reachable = repository !== undefined && repository.installationId !== null;

	return (
		<li className="space-y-2 p-3">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="min-w-0 flex-1 truncate">
					{title}{" "}
					<a
						href={merged.pullUrl}
						target="_blank"
						rel="noreferrer"
						title={`Merged ${formatDateTime(merged.mergedAt)}`}
						className="text-muted-foreground hover:underline"
					>
						#{merged.pullNumber}
					</a>
				</span>
				{open && (
					<a
						href={open.pullUrl}
						target="_blank"
						rel="noreferrer"
						className="text-xs text-muted-foreground hover:underline"
					>
						#{open.pullNumber} open
					</a>
				)}
				<DriftBadge state={state} />
				{admin && differs && reachable && (
					<Button variant="outline" size="sm" onClick={() => setApplying(true)}>
						<GitPullRequest />
						Apply again
					</Button>
				)}
			</div>
			{files.length > 0 && (
				<ul className="space-y-1 text-xs">
					{files.map((file) => (
						<li key={file.path} className="truncate">
							<span className="font-mono">{file.path}</span>
							<span className="text-muted-foreground"> · {FILE_STATES[file.state]}</span>
						</li>
					))}
				</ul>
			)}
			{applying && repository && (
				<ApplySetupDialog
					setup={setup}
					repositories={[repository]}
					openIn={new Set(open ? [repository.id] : [])}
					onApply={async (repositoryId) => {
						const outcome = await applySetup({ data: { slug, setupId: setup.id, repositoryId } });
						await router.invalidate();
						return outcome;
					}}
					onClose={() => setApplying(false)}
				/>
			)}
		</li>
	);
}
