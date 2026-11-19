import {
	MEMORY_KIND_NAMES,
	MEMORY_KINDS,
	MEMORY_LIMITS,
	MEMORY_SCOPE_NAMES,
	MEMORY_SCOPES,
	MEMORY_STATES,
	type MemoryKind,
	type MemoryOrigin,
	type MemoryScope,
	type MemoryState,
} from "@gateweave/agents-model";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Plus, Search } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { MemoryDialog } from "#/components/registry/memory-dialogs";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative, formatShortDate } from "#/lib/dates";
import {
	addMemory,
	approveMemory,
	deleteMemory,
	dismissMemory,
	editMemory,
	getMemory,
	type MemoryEntry,
	type MemoryList,
	type MemoryTargets,
} from "#/lib/memory";
import { httpUrl } from "#/lib/safe-url";
import { useDocumentTitle } from "#/lib/title";
import { cn } from "#/lib/utils";

const search = z.object({
	q: z.string().max(MEMORY_LIMITS.query).optional().catch(undefined),
	kind: z.enum(MEMORY_KINDS).optional().catch(undefined),
	scope: z.enum(MEMORY_SCOPES).optional().catch(undefined),
	state: z.enum(MEMORY_STATES).optional().catch(undefined),
});
type MemorySearch = z.infer<typeof search>;

const filterOf = ({ q, kind, scope, state }: MemorySearch) => ({
	search: q ?? "",
	kind: kind ?? null,
	scope: scope ?? null,
	state: state ?? ("live" as const),
});

export const Route = createFileRoute("/$workspace/memory")({
	validateSearch: search,
	loaderDeps: ({ search: deps }) => deps,
	loader: ({ params, deps }) =>
		getMemory({ data: { slug: params.workspace, filter: filterOf(deps) } }),
	component: MemoryPage,
});

const SELECT = "h-9 rounded-md border bg-transparent px-2 text-sm";

const STATE_NAMES: Record<MemoryState, string> = {
	live: "Recalled",
	waiting: "Waiting for approval",
	forgotten: "Forgotten",
};

const EMPTY: Record<MemoryState, string> = {
	live: "Nothing here yet. Agents with memory add to it as they work, and owners and admins can add to it by hand.",
	waiting:
		"Nothing waits. What an agent notes about the workspace or a repository, or in a run a trigger started, shows here until an owner or admin approves or dismisses it.",
	forgotten: "Nothing was forgotten. A memory an agent takes back shows here.",
};

/** What started the run a memory was written in, after "in a run", when no trigger is named. */
const RUN_ORIGINS: Record<MemoryOrigin, string> = {
	person: "",
	trigger: " a trigger started",
	replay: " that replays one a trigger started",
	outside: " an outside task started",
	unknown: " whose start could not be read",
};

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

function MemoryPage() {
	const data = Route.useLoaderData();
	const filter = Route.useSearch();
	useDocumentTitle("Memory");
	if (!data) {
		return (
			<Notice title="Memory unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	// Keyed by what is listed, so another search starts its pages afresh.
	return <MemoryView key={JSON.stringify(filter)} data={data} filter={filter} />;
}

function MemoryView({ data, filter }: { data: MemoryList; filter: MemorySearch }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const navigate = Route.useNavigate();
	const admin = isAdmin(useMyRole());
	const state = filter.state ?? "live";
	const [query, setQuery] = useState(filter.q ?? "");
	const [adding, setAdding] = useState(false);
	// Pages after the first, as "Load more" fetches them.
	const [older, setOlder] = useState<{ memories: MemoryEntry[]; next: number | null } | null>(null);
	const [loading, setLoading] = useState(false);
	// Which listing the pages belong to: a page asked for before a change is of the one before.
	const listing = useRef(0);
	const memories = older ? [...data.memories, ...older.memories] : data.memories;
	const next = older ? older.next : data.next;
	// A change may have taken a memory out of a page loaded before, so the pages start afresh.
	const changed = async () => {
		listing.current += 1;
		setOlder(null);
		await router.invalidate();
	};
	const show = (change: Partial<MemorySearch>) =>
		navigate({ search: (current) => ({ ...current, ...change }), replace: true });

	function onSearch(event: FormEvent) {
		event.preventDefault();
		void show({ q: query.trim() || undefined });
	}

	async function loadMore() {
		if (next === null) return;
		setLoading(true);
		const asked = listing.current;
		try {
			const page = await getMemory({
				data: { slug, filter: { ...filterOf(filter), offset: next } },
			});
			// The list was read again meanwhile: this page would repeat what moved into the first.
			if (page && asked === listing.current) {
				setOlder({ memories: [...(older?.memories ?? []), ...page.memories], next: page.next });
			}
		} catch (error) {
			toast.error(message(error));
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="mx-auto max-w-4xl space-y-6 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">Memory</h1>
					<p className="text-sm text-muted-foreground">
						What the workspace's agents and people have noted to be recalled in later runs: facts,
						decisions and preferences, each with who or what wrote it. Every member of the workspace
						reads them here, the notes an agent keeps while someone chats with it included. An agent
						reads them as notes, never as instructions. What an agent notes about the workspace or a
						repository, or in a run a trigger started, waits for an owner or admin first, since an
						outsider may have written what it read.
					</p>
				</div>
				{admin && data.targets && (
					<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
						<Plus />
						New memory
					</Button>
				)}
			</header>
			{adding && data.targets && (
				<MemoryDialog
					targets={data.targets}
					onSave={async (memory) => {
						await addMemory({ data: { slug, memory } });
						toast.success("The memory was added");
						await changed();
					}}
					onClose={() => setAdding(false)}
				/>
			)}

			<div className="space-y-3">
				<fieldset aria-label="Memories by state" className="flex flex-wrap gap-1">
					{MEMORY_STATES.map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={state === option}
							onClick={() => show({ state: option === "live" ? undefined : option })}
							className={cn(
								"rounded-md border px-3 py-1.5 text-sm",
								state === option
									? "border-foreground/30 bg-accent font-medium"
									: "border-transparent text-muted-foreground hover:bg-accent/50",
								option === "waiting" &&
									data.counts.waiting > 0 &&
									"text-amber-600 dark:text-amber-500",
							)}
						>
							{STATE_NAMES[option]}{" "}
							<span className="tabular-nums">· {data.counts[option].toLocaleString()}</span>
						</button>
					))}
				</fieldset>
				<form onSubmit={onSearch} className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-48 flex-1">
						<Search
							aria-hidden
							className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
						/>
						<Input
							type="search"
							aria-label="Search memory"
							placeholder="Search by word"
							className="pl-8"
							value={query}
							maxLength={MEMORY_LIMITS.query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					<select
						aria-label="Kind"
						className={SELECT}
						value={filter.kind ?? ""}
						onChange={(event) =>
							show({ kind: (event.target.value || undefined) as MemoryKind | undefined })
						}
					>
						<option value="">Every kind</option>
						{MEMORY_KINDS.map((option) => (
							<option key={option} value={option}>
								{MEMORY_KIND_NAMES[option]}
							</option>
						))}
					</select>
					<select
						aria-label="About"
						className={SELECT}
						value={filter.scope ?? ""}
						onChange={(event) =>
							show({ scope: (event.target.value || undefined) as MemoryScope | undefined })
						}
					>
						<option value="">About anything</option>
						{MEMORY_SCOPES.map((option) => (
							<option key={option} value={option}>
								{MEMORY_SCOPE_NAMES[option]}
							</option>
						))}
					</select>
					<Button type="submit" variant="outline" size="sm">
						Search
					</Button>
				</form>
			</div>

			{memories.length === 0 ? (
				<p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
					{filter.q || filter.kind || filter.scope ? "No memory matches." : EMPTY[state]}
				</p>
			) : (
				<ul className="divide-y rounded-lg border" aria-label={STATE_NAMES[state]}>
					{memories.map((memory) => (
						<MemoryRow
							key={memory.id}
							memory={memory}
							admin={admin}
							targets={data.targets}
							onChanged={changed}
						/>
					))}
				</ul>
			)}
			{next !== null && (
				<div className="flex justify-center">
					<Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
						{loading ? "Loading…" : "Load more"}
					</Button>
				</div>
			)}
		</div>
	);
}

function MemoryRow({
	memory,
	admin,
	targets,
	onChanged,
}: {
	memory: MemoryEntry;
	admin: boolean;
	targets: MemoryTargets | null;
	/** Reads the list again, once a memory has changed. */
	onChanged: () => Promise<void>;
}) {
	const { slug } = useWorkspace();
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState<"delete" | "dismiss" | null>(null);
	const [pending, setPending] = useState(false);
	const waiting = !memory.trusted && memory.forgottenAt === null;
	const expired = memory.expiresAt !== null && memory.expiresAt <= Date.now();
	const link = memory.source.url === null ? null : httpUrl(memory.source.url);

	async function approve() {
		setPending(true);
		try {
			await approveMemory({ data: { slug, memoryId: memory.id } });
			toast.success("The memory was approved: agents recall it now");
			await onChanged();
		} catch (failure) {
			toast.error(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="space-y-2 p-4">
			<p className="text-sm break-words whitespace-pre-wrap">{memory.text}</p>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
				<span className="rounded-md border px-1.5 py-0.5">{MEMORY_KIND_NAMES[memory.kind]}</span>
				{waiting && (
					<span className="rounded-md border border-amber-500/40 px-1.5 py-0.5 text-amber-600 dark:text-amber-500">
						Waiting for approval
					</span>
				)}
				{expired && <span className="rounded-md border px-1.5 py-0.5">Expired</span>}
				<span>
					About{" "}
					{memory.scope === "workspace"
						? "the workspace"
						: `${MEMORY_SCOPE_NAMES[memory.scope].toLowerCase()} ${memory.aboutName ?? "(removed)"}`}
				</span>
				<span aria-hidden>·</span>
				<span>
					{memory.author.kind === "agent" ? "Written by the agent " : "Written by "}
					{memory.author.kind === "agent" ? (
						<Link
							to="/$workspace/agents/$agentId"
							params={{ workspace: slug, agentId: memory.author.id }}
							className="text-foreground hover:underline"
						>
							{memory.authorName}
						</Link>
					) : (
						<span className="text-foreground">{memory.authorName}</span>
					)}
					{memory.run && (
						<>
							{" in "}
							{memory.run.id !== null ? (
								<Link
									to="/$workspace/runs/$runId"
									params={{ workspace: slug, runId: memory.run.id }}
									className="text-foreground underline-offset-4 hover:underline"
								>
									a run
								</Link>
							) : (
								"a run"
							)}
							{memory.run.trigger !== null
								? ` the trigger ${memory.run.trigger} started`
								: RUN_ORIGINS[memory.run.origin]}
						</>
					)}
					{memory.editedByName !== null && `, edited by ${memory.editedByName}`}
				</span>
				<span aria-hidden>·</span>
				<span title={formatDateTime(memory.createdAt)}>{formatRelative(memory.createdAt)}</span>
				{memory.approvedByName !== null && <span>· Approved by {memory.approvedByName}</span>}
				{memory.forgottenAt !== null && (
					<span title={formatDateTime(memory.forgottenAt)}>
						· Forgotten {formatRelative(memory.forgottenAt)}
					</span>
				)}
				{memory.expiresAt !== null && !expired && (
					<span title={formatDateTime(memory.expiresAt)}>
						· Recalled until {formatShortDate(memory.expiresAt)}
					</span>
				)}
				{(memory.source.label !== null || link !== null) && (
					<span>
						· Source:{" "}
						{link === null ? (
							memory.source.label
						) : (
							<a
								href={link}
								target="_blank"
								rel="noreferrer noopener"
								className="text-foreground underline-offset-4 hover:underline"
							>
								{memory.source.label ?? new URL(link).host}
							</a>
						)}
					</span>
				)}
			</div>
			{admin && (
				<div className="flex flex-wrap gap-2">
					{waiting && (
						<>
							<Button variant="outline" size="sm" onClick={approve} disabled={pending}>
								Approve
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setConfirming("dismiss")}
								disabled={pending}
							>
								Dismiss
							</Button>
						</>
					)}
					{memory.forgottenAt === null && targets && (
						<Button variant="ghost" size="sm" onClick={() => setEditing(true)} disabled={pending}>
							Edit
						</Button>
					)}
					{!waiting && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setConfirming("delete")}
							disabled={pending}
						>
							Delete
						</Button>
					)}
				</div>
			)}
			{editing && targets && (
				<MemoryDialog
					memory={memory}
					targets={targets}
					onSave={async ({ text, kind, sourceLabel, sourceUrl, expiresAt }) => {
						await editMemory({
							data: {
								slug,
								memory: { id: memory.id, text, kind, sourceLabel, sourceUrl, expiresAt },
							},
						});
						toast.success("The memory was saved");
						await onChanged();
					}}
					onClose={() => setEditing(false)}
				/>
			)}
			{confirming && (
				<ConfirmDialog
					title={confirming === "dismiss" ? "Dismiss this memory?" : "Delete this memory?"}
					confirmLabel={confirming === "dismiss" ? "Dismiss" : "Delete"}
					onConfirm={async () => {
						try {
							await (confirming === "dismiss" ? dismissMemory : deleteMemory)({
								data: { slug, memoryId: memory.id },
							});
						} catch (failure) {
							toast.error(message(failure));
							return;
						}
						toast.success(
							confirming === "dismiss" ? "The memory was dismissed" : "The memory was deleted",
						);
						await onChanged();
					}}
					onClose={() => setConfirming(null)}
				>
					{confirming === "dismiss"
						? "It is removed from the memory and its search, and no agent ever recalls it."
						: "It is removed from the memory and its search, and agents no longer recall it."}{" "}
					Two things stay: the audit log keeps the first {MEMORY_LIMITS.excerpt} characters from
					when it was added, unless it is about a person, for as long as it keeps its entries, and
					what an agent already recalled stays in that conversation.
				</ConfirmDialog>
			)}
		</li>
	);
}
