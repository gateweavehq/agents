import {
	type AgentRuntime,
	type ApplicationState,
	ASSET_KIND_NAMES,
	type AssetKind,
	type Repository,
	RUNTIME_NAMES,
} from "@gateweave/agents-model";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { cn } from "#/lib/utils";

/** A color per runtime, so the same agent reads the same on every page. */
const RUNTIME_DOTS: Record<AgentRuntime, string> = {
	"claude-code": "bg-orange-500",
	codex: "bg-emerald-500",
	"gemini-cli": "bg-sky-500",
	cursor: "bg-violet-500",
	gateweave: "bg-zinc-500",
};

export function RuntimeBadge({
	runtime,
	className,
}: {
	runtime: AgentRuntime;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap",
				className,
			)}
		>
			<span aria-hidden className={cn("size-1.5 rounded-full", RUNTIME_DOTS[runtime])} />
			{RUNTIME_NAMES[runtime]}
		</span>
	);
}

export function KindLabel({ kind }: { kind: AssetKind }) {
	return (
		<span className="rounded bg-muted px-1.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground">
			{ASSET_KIND_NAMES[kind]}
		</span>
	);
}

const PULL_STATES: Record<ApplicationState, { label: string; className: string }> = {
	open: { label: "Open", className: "text-emerald-700 dark:text-emerald-400" },
	merged: { label: "Merged", className: "text-violet-700 dark:text-violet-400" },
	closed: { label: "Closed", className: "text-muted-foreground" },
};

/** Where a pull request that applies a setup stands. */
export function PullState({ state }: { state: ApplicationState }) {
	const { label, className } = PULL_STATES[state];
	return (
		<span className={cn("rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap", className)}>
			{label}
		</span>
	);
}

/** Where the repository's last scan stands, in a few words. */
export function ScanStatus({ repository }: { repository: Repository }) {
	const { scanPending, scanError, scannedAt } = repository;
	if (scanPending) {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
				<LoaderCircle aria-hidden className="size-3.5 animate-spin" />
				{scannedAt === null ? "Scanning" : "Scanning again"}
			</span>
		);
	}
	if (scanError !== null) {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-destructive" title={scanError}>
				<CircleAlert aria-hidden className="size-3.5" />
				Scan failed
			</span>
		);
	}
	if (scannedAt === null) return <span className="text-xs text-muted-foreground">Not scanned</span>;
	return (
		<span className="text-xs text-muted-foreground" title={formatDateTime(scannedAt)}>
			Scanned {formatRelative(scannedAt)}
		</span>
	);
}

/** The repository's page on its host. */
export function repositoryUrl({ owner, name }: Pick<Repository, "owner" | "name">) {
	return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** A file at a commit, on the repository's host. */
export function fileUrl(repository: Repository, commit: string, path: string) {
	const segments = path.split("/").map(encodeURIComponent).join("/");
	return `${repositoryUrl(repository)}/blob/${commit}/${segments}`;
}
