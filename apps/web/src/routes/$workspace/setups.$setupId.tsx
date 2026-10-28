import type { SetupAsset, SetupDetail } from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { GitPullRequest, Library, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DriftRow } from "#/components/registry/drift";
import { KindLabel, PullState, RuntimeBadge } from "#/components/registry/labels";
import {
	ApplySetupDialog,
	SetupAssetsDialog,
	SetupDialog,
} from "#/components/registry/setup-dialogs";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { useRefreshWhile } from "#/lib/refresh";
import {
	applySetup,
	deleteSetup,
	getLibrary,
	getRepositories,
	getSetup,
	setSetupAssets,
	updateSetup,
} from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/setups/$setupId")({
	loader: async ({ params }) => {
		const [detail, library, repositories] = await Promise.all([
			getSetup({ data: { slug: params.workspace, setupId: params.setupId } }),
			getLibrary({ data: params.workspace }),
			getRepositories({ data: params.workspace }),
		]);
		return detail && { ...detail, library: library ?? [], repositories: repositories ?? [] };
	},
	component: SetupPage,
});

function SetupPage() {
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle(data ? data.setup.name : "Setup");
	// A merge queues a scan of the repository; drift is known once it has run.
	const scanning = new Set(data?.repositories.filter((r) => r.scanPending).map((r) => r.id));
	useRefreshWhile(
		data?.applied.some(
			({ repository, drift }) => drift.state === "unscanned" && scanning.has(repository.id),
		) ?? false,
	);

	if (!data) {
		return <Notice title="Setup not found">It may have been deleted.</Notice>;
	}
	const { setup, assets, files, problems, applications, applied } = data;

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-2">
					<h1 className="text-xl font-semibold tracking-tight">{setup.name}</h1>
					{setup.description && (
						<p className="text-sm whitespace-pre-line text-muted-foreground">{setup.description}</p>
					)}
					<p className="flex flex-wrap gap-1.5">
						{setup.runtimes.map((runtime) => (
							<RuntimeBadge key={runtime} runtime={runtime} />
						))}
					</p>
				</div>
				{admin && <SetupActions />}
			</header>

			<section aria-labelledby="assets-heading" className="space-y-3">
				<h2 id="assets-heading" className="text-sm font-medium">
					{assets.length === 0 ? "Assets" : `Assets · ${assets.length}`}
				</h2>
				{assets.length === 0 ? (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						No assets in this setup yet.
						{admin
							? " Choose them from the library with Assets."
							: " An owner or admin can choose them."}
					</p>
				) : (
					<ul className="divide-y rounded-lg border text-sm">
						{assets.map((pin) => (
							<PinRow key={pin.asset.id} pin={pin} admin={admin} />
						))}
					</ul>
				)}
			</section>

			{applied.length > 0 && <AppliedTo admin={admin} />}
			{applications.length > 0 && <Applications />}

			{assets.length > 0 && <Preview files={files} problems={problems} />}
		</div>
	);
}

/** One pinned asset, and its newer version if the library has one. */
function PinRow({ pin, admin }: { pin: SetupAsset; admin: boolean }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const data = Route.useLoaderData();
	const [pending, setPending] = useState(false);
	const { asset, version, removed } = pin;
	const update = !removed && version < asset.version;

	async function moveToLatest() {
		if (!data) return;
		setPending(true);
		try {
			const pins = data.assets.map((other) => ({
				assetId: other.asset.id,
				version: other.asset.id === asset.id ? asset.version : other.version,
			}));
			await setSetupAssets({ data: { slug, setupId: data.setup.id, pins } });
			toast.success(`${asset.name} is pinned to v${asset.version}`);
			await router.invalidate();
		} catch (error) {
			toast.error("Could not move the pin", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setPending(false);
		}
	}

	return (
		<li className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
			<KindLabel kind={asset.kind} />
			<span className="min-w-0 flex-1 truncate">
				{removed ? (
					asset.name
				) : (
					<Link
						to="/$workspace/assets/$assetId"
						params={{ workspace: slug, assetId: asset.id }}
						search={{ version }}
						className="hover:underline"
					>
						{asset.name}
					</Link>
				)}
			</span>
			<span className="text-xs tabular-nums">
				<span className="text-muted-foreground">v{version}</span>
				{removed && <span className="text-muted-foreground">, left the library</span>}
				{update && (
					<span className="text-amber-600 dark:text-amber-500">, v{asset.version} is out</span>
				)}
			</span>
			{update && admin && (
				<Button variant="outline" size="sm" onClick={moveToLatest} disabled={pending}>
					Use v{asset.version}
				</Button>
			)}
		</li>
	);
}

/** The repositories this setup was merged into, and where each has moved away from it. */
function AppliedTo({ admin }: { admin: boolean }) {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	if (!data) return null;
	const reached = new Map(data.repositories.map((repository) => [repository.id, repository]));
	return (
		<section aria-labelledby="applied-heading" className="space-y-3">
			<h2 id="applied-heading" className="text-sm font-medium">
				Repositories · {data.applied.length}
			</h2>
			<ul className="divide-y rounded-lg border text-sm">
				{data.applied.map(({ repository, drift }) => (
					<DriftRow
						key={repository.id}
						title={
							<Link
								to="/$workspace/repositories/$repositoryId"
								params={{ workspace: slug, repositoryId: repository.id }}
								className="hover:underline"
							>
								{repository.owner}/{repository.name}
							</Link>
						}
						drift={drift}
						setup={data.setup}
						repository={reached.get(repository.id)}
						admin={admin}
					/>
				))}
			</ul>
		</section>
	);
}

/** The pull requests that applied this setup, and whether the pins have moved since. */
function Applications() {
	const { slug } = useWorkspace();
	const data = Route.useLoaderData();
	if (!data) return null;
	const current = new Map(data.assets.map((pin) => [pin.asset.id, pin.version]));
	const moved = (pins: { assetId: string; version: number }[]) =>
		pins.length !== current.size || pins.some((pin) => current.get(pin.assetId) !== pin.version);

	return (
		<section aria-labelledby="applications-heading" className="space-y-3">
			<h2 id="applications-heading" className="text-sm font-medium">
				Pull requests · {data.applications.length}
			</h2>
			<ul className="divide-y rounded-lg border text-sm">
				{data.applications.map(({ application, repository }) => (
					<li key={application.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
						<span className="min-w-0 flex-1 truncate">
							<Link
								to="/$workspace/repositories/$repositoryId"
								params={{ workspace: slug, repositoryId: repository.id }}
								className="hover:underline"
							>
								{repository.owner}/{repository.name}
							</Link>{" "}
							<a
								href={application.pullUrl}
								target="_blank"
								rel="noreferrer"
								className="text-muted-foreground hover:underline"
							>
								#{application.pullNumber}
							</a>
						</span>
						{application.state === "open" && moved(application.pins) && (
							<span className="text-xs text-amber-600 dark:text-amber-500">Pins moved since</span>
						)}
						<PullState state={application.state} />
						<span
							className="text-xs text-muted-foreground"
							title={formatDateTime(application.updatedAt)}
						>
							{formatRelative(application.updatedAt)}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The files the setup writes, as the writers produce them, and what they could not write. */
function Preview({ files, problems }: Pick<SetupDetail, "files" | "problems">) {
	return (
		<>
			<section aria-labelledby="files-heading" className="space-y-3">
				<div className="space-y-1">
					<h2 id="files-heading" className="text-sm font-medium">
						{files.length === 1 ? "1 file" : `${files.length} files`}
					</h2>
					<p className="text-sm text-muted-foreground">
						What this setup writes into a repository, in the format of each coding agent. Secrets
						are references to environment variables, never values.
					</p>
				</div>
				{files.map((file) => (
					<details key={file.path} className="overflow-hidden rounded-lg border">
						<summary className="cursor-pointer bg-muted/40 px-3 py-2 font-mono text-xs">
							{file.path}
						</summary>
						<pre className="max-h-[32rem] overflow-auto border-t p-3 text-xs leading-relaxed">
							<code>{file.content}</code>
						</pre>
					</details>
				))}
			</section>
			{problems.length > 0 && (
				<section aria-labelledby="problems-heading" className="space-y-3">
					<h2 id="problems-heading" className="text-sm font-medium">
						Not written · {problems.length}
					</h2>
					<ul className="divide-y rounded-lg border text-sm">
						{problems.map((problem) => (
							<li key={`${problem.asset}\0${problem.message}`} className="p-3">
								<span className="font-medium">{problem.asset}</span>
								<span className="text-muted-foreground"> · {problem.message}</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}

function SetupActions() {
	const { slug } = useWorkspace();
	const router = useRouter();
	const navigate = useNavigate();
	const data = Route.useLoaderData();
	const [open, setOpen] = useState<"apply" | "assets" | "edit" | "delete" | null>(null);
	if (!data) return null;
	const { setup } = data;
	const close = () => setOpen(null);
	const connected = data.repositories.filter((repository) => repository.installationId !== null);
	const openIn = new Set(
		data.applications
			.filter(({ application }) => application.state === "open")
			.map(({ repository }) => repository.id),
	);

	return (
		<div className="flex shrink-0 flex-wrap gap-2">
			<Button
				size="sm"
				onClick={() => setOpen("apply")}
				disabled={data.files.length === 0}
				title={data.files.length === 0 ? "This setup writes no files yet" : undefined}
			>
				<GitPullRequest />
				Apply
			</Button>
			<Button variant="outline" size="sm" onClick={() => setOpen("assets")}>
				<Library />
				Assets
			</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen("edit")}>
				<Pencil />
				Edit
			</Button>
			<Button variant="ghost" size="sm" onClick={() => setOpen("delete")}>
				<Trash2 />
				<span className="sr-only sm:not-sr-only">Delete</span>
			</Button>

			{open === "apply" && (
				<ApplySetupDialog
					setup={setup}
					repositories={connected}
					openIn={openIn}
					onApply={async (repositoryId) => {
						const outcome = await applySetup({ data: { slug, setupId: setup.id, repositoryId } });
						await router.invalidate();
						return outcome;
					}}
					onClose={close}
				/>
			)}
			{open === "assets" && (
				<SetupAssetsDialog
					setup={setup}
					pinned={data.assets}
					library={data.library}
					onSave={async (pins) => {
						await setSetupAssets({ data: { slug, setupId: setup.id, pins } });
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "edit" && (
				<SetupDialog
					setup={setup}
					onSave={async (input) => {
						await updateSetup({ data: { slug, setupId: setup.id, setup: input } });
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "delete" && (
				<ConfirmDialog
					title={`Delete ${setup.name}?`}
					confirmLabel="Delete setup"
					onConfirm={async () => {
						try {
							await deleteSetup({ data: { slug, setupId: setup.id } });
						} catch (error) {
							toast.error("Could not delete the setup", {
								description: error instanceof Error ? error.message : undefined,
							});
							return;
						}
						toast.success(`${setup.name} was deleted`);
						await navigate({ to: "/$workspace/setups", params: { workspace: slug } });
					}}
					onClose={close}
				>
					The library keeps its assets, and repositories keep their files.
				</ConfirmDialog>
			)}
		</div>
	);
}
