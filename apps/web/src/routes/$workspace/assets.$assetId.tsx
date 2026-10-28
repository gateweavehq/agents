import {
	type AssetFile,
	type Metadata,
	type Repository,
	repositoryPathOf,
} from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { fileUrl, KindLabel, RuntimeBadge } from "#/components/registry/labels";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { getAsset } from "#/lib/registry";
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
	useDocumentTitle(detail ? detail.asset.name : "Asset");

	if (!detail) {
		return (
			<Notice title="Asset not found">
				A later scan may no longer find it, or that version does not exist.
			</Notice>
		);
	}
	const { asset, repository, agents, version, versions, sameContent } = detail;
	const current = version.version === asset.version;

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<KindLabel kind={asset.kind} />
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
				<h1 className="text-xl font-semibold tracking-tight">{asset.name}</h1>
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

			<dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
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
				<dt className="text-muted-foreground">Same content</dt>
				<dd>
					{sameContent === 0
						? "Nowhere else in this workspace"
						: sameContent === 1
							? "In 1 other place in this workspace"
							: `In ${sameContent} other places in this workspace`}
				</dd>
				<MetadataRows metadata={asset.metadata} />
			</dl>

			<section aria-labelledby="files-heading" className="space-y-3">
				<h2 id="files-heading" className="text-sm font-medium">
					{version.files.length === 1 ? "File" : `Files · ${version.files.length}`}
				</h2>
				{version.files.map((file) => (
					<FileView
						key={file.path}
						file={file}
						repository={repository}
						commit={version.commit}
						path={
							asset.path === null
								? null
								: repositoryPathOf({ path: asset.path }, version.files, file)
						}
					/>
				))}
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
		</div>
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
