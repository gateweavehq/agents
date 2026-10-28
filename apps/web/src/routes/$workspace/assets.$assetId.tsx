import {
	type Asset,
	type AssetFile,
	type LibraryUse,
	type McpServerInput,
	type Metadata,
	type Repository,
	repositoryPathOf,
} from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Library, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { EditFiles } from "#/components/registry/edit-files";
import { fileUrl, KindLabel, RuntimeBadge } from "#/components/registry/labels";
import { AddToLibraryDialog } from "#/components/registry/library-dialogs";
import { McpServerDialog } from "#/components/registry/mcp-dialogs";
import { CompareVersions } from "#/components/registry/version-diff";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { editMcpServer, getAsset, getMcpSettings, removeFromLibrary } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/assets/$assetId")({
	validateSearch: z.object({ version: z.number().int().positive().optional().catch(undefined) }),
	loaderDeps: ({ search }) => ({ version: search.version }),
	loader: ({ params, deps }) =>
		getAsset({ data: { slug: params.workspace, assetId: params.assetId, version: deps.version } }),
	component: AssetPage,
});

const sizes = new Intl.NumberFormat(undefined, {
	style: "unit",
	unit: "kilobyte",
	maximumFractionDigits: 1,
});

function AssetPage() {
	const { slug } = useWorkspace();
	const detail = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	const [editing, setEditing] = useState(false);
	useDocumentTitle(detail ? detail.asset.name : "Asset");

	if (!detail) {
		return (
			<Notice title="Asset not found">
				A later scan may no longer find it, or that version does not exist.
			</Notice>
		);
	}
	const { asset, repository, agents, version, versions, sameContent, uses, library } = detail;
	const current = version.version === asset.version;
	const inLibrary = asset.repositoryId === null;
	// Only the current version is edited: a save always makes the next one.
	// Environment sets are edited on their own page, and MCP servers with their settings, which
	// keeps secrets out of the file.
	const canEdit =
		admin &&
		inLibrary &&
		current &&
		asset.kind !== "env-set" &&
		asset.kind !== "mcp-server" &&
		version.files.some((f) => f.content !== null);
	const canEditSettings = admin && inLibrary && current && asset.kind === "mcp-server";

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<KindLabel kind={asset.kind} />
					{inLibrary && (
						<Link
							to="/$workspace/library"
							params={{ workspace: slug }}
							className="text-xs hover:underline"
						>
							Library
						</Link>
					)}
					{repository && (
						<Link
							to="/$workspace/repositories/$repositoryId"
							params={{ workspace: slug, repositoryId: repository.id }}
							className="text-xs hover:underline"
						>
							<span className="text-muted-foreground">{repository.owner}/</span>
							{repository.name}
						</Link>
					)}
				</div>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<h1 className="text-xl font-semibold tracking-tight">{asset.name}</h1>
					<div className="flex gap-2">
						{canEdit && !editing && (
							<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
								<Pencil />
								Edit
							</Button>
						)}
						{canEditSettings && <McpSettingsButton asset={asset} />}
						<LibraryActions asset={asset} />
					</div>
				</div>
				{asset.path && asset.path !== asset.name && (
					<p className="font-mono text-xs text-muted-foreground">{asset.path}</p>
				)}
				{asset.description && <p className="text-sm text-muted-foreground">{asset.description}</p>}
			</header>

			{!current && (
				<p role="status" className="rounded-lg border p-3 text-sm">
					This is version {version.version}. The current one is version {asset.version}.{" "}
					<Link
						to="/$workspace/assets/$assetId"
						params={{ workspace: slug, assetId: asset.id }}
						className="underline"
					>
						Show it
					</Link>
				</p>
			)}

			{(!inLibrary || agents.length > 0 || Object.keys(asset.metadata).length > 0) && (
				<dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
					{!inLibrary && (
						<>
							<dt className="text-muted-foreground">Read by</dt>
							<dd className="flex flex-wrap gap-1.5">
								{agents.length === 0 ? (
									<span className="text-muted-foreground">No agent</span>
								) : (
									agents.map((agent) => (
										<span key={agent.id} className="inline-flex items-center gap-1.5">
											<RuntimeBadge runtime={agent.runtime} />
											{agent.key !== "main" && <span>{agent.name}</span>}
										</span>
									))
								)}
							</dd>
							<dt className="text-muted-foreground">In the library</dt>
							<dd className="flex flex-wrap gap-x-3 gap-y-1">
								{library.length === 0 ? (
									<span className="text-muted-foreground">No</span>
								) : (
									library.map((match) => (
										<LibraryMatch
											key={match.asset.id}
											asset={match.asset}
											version={match.version}
										/>
									))
								)}
							</dd>
							<dt className="text-muted-foreground">Same content</dt>
							<dd>
								{sameContent === 0
									? "Nowhere else in this workspace"
									: sameContent === 1
										? "In 1 other place in this workspace"
										: `In ${sameContent} other places in this workspace`}
							</dd>
						</>
					)}
					{inLibrary && agents.length > 0 && (
						<>
							<dt className="text-muted-foreground">Agents</dt>
							<dd className="flex flex-wrap gap-x-3 gap-y-1">
								{agents.map((agent) => (
									<Link
										key={agent.id}
										to="/$workspace/agents/$agentId"
										params={{ workspace: slug, agentId: agent.id }}
										className="hover:underline"
									>
										{agent.name}
									</Link>
								))}
							</dd>
						</>
					)}
					<MetadataRows metadata={asset.metadata} />
				</dl>
			)}

			{inLibrary && <Uses uses={uses} current={asset.version} />}

			<section aria-labelledby="files-heading" className="space-y-3">
				<h2 id="files-heading" className="text-sm font-medium">
					{version.files.length === 1 ? "File" : `Files · ${version.files.length}`}
				</h2>
				{editing && canEdit ? (
					<EditFiles
						assetId={asset.id}
						version={asset.version}
						files={version.files}
						onClose={() => setEditing(false)}
					/>
				) : (
					version.files.map((file) => (
						<FileView
							key={file.path}
							file={file}
							repository={repository}
							commit={version.commit}
							path={
								asset.path === null
									? null
									: repositoryPathOf({ kind: asset.kind, path: asset.path }, version.files, file)
							}
						/>
					))
				)}
			</section>

			{versions.length > 1 && (
				<section aria-labelledby="versions-heading" className="space-y-3">
					<h2 id="versions-heading" className="text-sm font-medium">
						Versions
					</h2>
					<ol className="divide-y rounded-lg border text-sm">
						{versions.map((entry) => (
							<li key={entry.version}>
								<Link
									to="/$workspace/assets/$assetId"
									params={{ workspace: slug, assetId: asset.id }}
									search={entry.version === asset.version ? {} : { version: entry.version }}
									className="flex items-center gap-3 p-3 hover:bg-accent/50"
									aria-current={entry.version === version.version ? "page" : undefined}
								>
									<span className="w-10 font-medium tabular-nums">v{entry.version}</span>
									{entry.commit && (
										<span className="font-mono text-xs text-muted-foreground">
											{entry.commit.slice(0, 7)}
										</span>
									)}
									<span
										className="ml-auto text-xs text-muted-foreground"
										title={formatDateTime(entry.createdAt)}
									>
										{formatRelative(entry.createdAt)}
									</span>
								</Link>
							</li>
						))}
					</ol>
				</section>
			)}

			{versions.length > 1 && (
				<CompareVersions assetId={asset.id} versions={versions} shown={version.version} />
			)}
		</div>
	);
}

/** A library asset this repository asset matches, and whether it is behind. */
function LibraryMatch({ asset, version }: { asset: Asset; version: number }) {
	const { slug } = useWorkspace();
	return (
		<span>
			<Link
				to="/$workspace/assets/$assetId"
				params={{ workspace: slug, assetId: asset.id }}
				className="underline"
			>
				{asset.name}
			</Link>{" "}
			{version === asset.version ? (
				<span className="text-muted-foreground">v{version}, the latest</span>
			) : (
				<span className="text-amber-600 dark:text-amber-500">
					v{version}, behind v{asset.version}
				</span>
			)}
		</span>
	);
}

/** The repository assets that carry one of a library asset's versions. */
function Uses({ uses, current }: { uses: LibraryUse[]; current: number }) {
	const { slug } = useWorkspace();
	return (
		<section aria-labelledby="uses-heading" className="space-y-3">
			<h2 id="uses-heading" className="text-sm font-medium">
				{uses.length === 0 ? "Used in" : `Used in · ${uses.length}`}
			</h2>
			{uses.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No repository has any version of it right now.
				</p>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{uses.map(({ asset, repository, version }) => (
						<li key={asset.id}>
							<Link
								to="/$workspace/assets/$assetId"
								params={{ workspace: slug, assetId: asset.id }}
								className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 hover:bg-accent/50"
							>
								<span className="min-w-0 flex-1 truncate">
									<span className="text-muted-foreground">{repository.owner}/</span>
									{repository.name}
									{asset.path && (
										<span className="ml-2 font-mono text-xs text-muted-foreground">
											{asset.path}
										</span>
									)}
								</span>
								{version === current ? (
									<span className="text-xs text-muted-foreground">v{version}, the latest</span>
								) : (
									<span className="text-xs text-amber-600 dark:text-amber-500">
										v{version}, behind
									</span>
								)}
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** "Add to library" for a repository asset, "Remove from library" for a library one. Admins only. */
/** Opens a library MCP server's settings; saving new ones makes its next version. */
function McpSettingsButton({ asset }: { asset: Asset }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [settings, setSettings] = useState<Omit<McpServerInput, "name"> | null>(null);
	const [pending, setPending] = useState(false);

	async function open() {
		setPending(true);
		try {
			const found = await getMcpSettings({ data: { slug, assetId: asset.id } });
			if (found) setSettings(found);
			else toast.error("This server runs as a local command, which has no settings to edit here");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Something went wrong");
		} finally {
			setPending(false);
		}
	}

	return (
		<>
			<Button variant="outline" size="sm" onClick={open} disabled={pending}>
				<Pencil />
				Edit settings
			</Button>
			{settings && (
				<McpServerDialog
					server={{ name: asset.name, settings }}
					onSave={async ({ transport, url, headers }) => {
						const saved = await editMcpServer({
							data: { slug, server: { assetId: asset.id, transport, url, headers } },
						});
						toast.success(
							saved === asset.version ? "Nothing changed" : `Saved as version ${saved}`,
						);
						await router.invalidate();
					}}
					onClose={() => setSettings(null)}
				/>
			)}
		</>
	);
}

function LibraryActions({ asset }: { asset: Asset }) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const admin = isAdmin(useMyRole());
	const [open, setOpen] = useState(false);
	if (!admin) return null;

	if (asset.repositoryId !== null) {
		// The library keeps environment sets written on the Environment page only.
		if (asset.kind === "env-set") return null;
		return (
			<>
				<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
					<Library />
					Add to library
				</Button>
				{open && (
					<AddToLibraryDialog
						asset={asset}
						onAdded={async (libraryAssetId) => {
							toast.success("Added to the library");
							await navigate({
								to: "/$workspace/assets/$assetId",
								params: { workspace: slug, assetId: libraryAssetId },
							});
						}}
						onClose={() => setOpen(false)}
					/>
				)}
			</>
		);
	}

	return (
		<>
			<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
				<Trash2 />
				Remove from library
			</Button>
			{open && (
				<ConfirmDialog
					title={`Remove ${asset.name} from the library?`}
					confirmLabel="Remove"
					onConfirm={async () => {
						try {
							await removeFromLibrary({ data: { slug, assetId: asset.id } });
						} catch (error) {
							toast.error("Could not remove it", {
								description: error instanceof Error ? error.message : undefined,
							});
							return;
						}
						toast.success(`${asset.name} left the library`);
						await navigate({ to: "/$workspace/library", params: { workspace: slug } });
					}}
					onClose={() => setOpen(false)}
				>
					Repositories that carry one of its versions keep their files.
				</ConfirmDialog>
			)}
		</>
	);
}

function MetadataRows({ metadata }: { metadata: Metadata }) {
	return Object.entries(metadata).map(([key, value]) => (
		<div key={key} className="contents">
			<dt className="font-mono text-xs text-muted-foreground">{key}</dt>
			<dd className="min-w-0 break-words">
				{Array.isArray(value) ? (
					<span className="flex flex-wrap gap-1">
						{value.map((item) => (
							<span key={item} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
								{item}
							</span>
						))}
					</span>
				) : (
					<span className="font-mono text-xs">{String(value)}</span>
				)}
			</dd>
		</div>
	));
}

function FileView({
	file,
	repository,
	commit,
	path,
}: {
	file: AssetFile;
	repository: Repository | null;
	commit: string | null;
	/** Where the file sits in the repository, if the asset is in one. */
	path: string | null;
}) {
	const onGitHub = repository && commit && path ? fileUrl(repository, commit, path) : null;

	return (
		<figure className="overflow-hidden rounded-lg border">
			<figcaption className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs">
				<span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
				<span className="text-muted-foreground tabular-nums">{sizes.format(file.size / 1000)}</span>
				{onGitHub && (
					<a href={onGitHub} target="_blank" rel="noreferrer" className="hover:underline">
						GitHub
					</a>
				)}
			</figcaption>
			{file.content === null ? (
				<p className="p-3 text-sm text-muted-foreground">
					Its text is not kept, only its size and Git blob id,{" "}
					<span className="font-mono text-xs">{file.blob.slice(0, 12)}</span>, which show when it
					changes.
				</p>
			) : (
				<pre className="max-h-[32rem] overflow-auto p-3 text-xs leading-relaxed">
					<code>{file.content}</code>
				</pre>
			)}
		</figure>
	);
}
