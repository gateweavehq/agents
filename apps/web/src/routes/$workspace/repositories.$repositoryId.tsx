import { ASSET_KIND_NAMES, ASSET_KINDS, type Asset } from "@gateweave/agents-model";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, Lock, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DriftRow } from "#/components/registry/drift";
import { PullState, RuntimeBadge, repositoryUrl, ScanStatus } from "#/components/registry/labels";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { useRefreshWhile } from "#/lib/refresh";
import { getRepository, scanRepository } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/repositories/$repositoryId")({
	loader: ({ params }) =>
		getRepository({ data: { slug: params.workspace, repositoryId: params.repositoryId } }),
	component: RepositoryPage,
});

function RepositoryPage() {
	const detail = Route.useLoaderData();
	useDocumentTitle(detail ? detail.repository.name : "Repository");
	useRefreshWhile(detail?.repository.scanPending ?? false);

	if (!detail) {
		return (
			<Notice title="Repository not found">
				It may have left the workspace, or GitHub no longer gives the app access to it.
			</Notice>
		);
	}
	const { repository, agents, assets, applications, applied } = detail;
	const assetsById = new Map(assets.map((asset) => [asset.id, asset]));

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="min-w-0 space-y-1">
					<h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
						<span className="truncate">
							<span className="font-normal text-muted-foreground">{repository.owner}/</span>
							{repository.name}
						</span>
						{repository.private && (
							<Lock aria-label="Private" className="size-4 shrink-0 text-muted-foreground" />
						)}
					</h1>
					<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<span>
							Branch <span className="font-mono">{repository.defaultBranch}</span>
						</span>
						{repository.scannedCommit && (
							<a
								href={`${repositoryUrl(repository)}/commit/${repository.scannedCommit}`}
								target="_blank"
								rel="noreferrer"
								className="font-mono hover:underline"
							>
								{repository.scannedCommit.slice(0, 7)}
							</a>
						)}
						<ScanStatus repository={repository} />
					</p>
				</div>
				<div className="flex shrink-0 gap-2">
					<ScanButton pending={repository.scanPending} />
					<Button asChild variant="ghost" size="sm">
						<a href={repositoryUrl(repository)} target="_blank" rel="noreferrer">
							<ExternalLink />
							GitHub
						</a>
					</Button>
				</div>
			</header>

			{repository.scanError && (
				<p
					role="alert"
					className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
				>
					The last scan failed: {repository.scanError}
					{repository.scannedAt !== null && " What an earlier scan found is still shown."}
				</p>
			)}

			<section aria-labelledby="agents-heading" className="space-y-3">
				<h2 id="agents-heading" className="text-sm font-medium">
					Agents
				</h2>
				{agents.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{repository.scannedAt === null
							? "Not scanned yet."
							: "No agent configuration was found in this repository."}
					</p>
				) : (
					<ul className="divide-y rounded-lg border">
						{agents.map((agent) => (
							<li key={agent.id} className="space-y-2 p-3">
								<div className="flex flex-wrap items-center gap-2">
									<RuntimeBadge runtime={agent.runtime} />
									<span className="text-sm font-medium">{agent.name}</span>
									{agent.path && (
										<span className="font-mono text-xs text-muted-foreground">{agent.path}</span>
									)}
									{agent.model && (
										<span className="ml-auto text-xs text-muted-foreground">
											Model <span className="font-mono">{agent.model}</span>
										</span>
									)}
								</div>
								{agent.description && (
									<p className="text-sm text-muted-foreground">{agent.description}</p>
								)}
								{agent.assetIds.length > 0 && (
									<p className="flex flex-wrap items-center gap-1.5 text-xs">
										<span className="text-muted-foreground">Reads</span>
										{agent.assetIds.map((assetId) => {
											const asset = assetsById.get(assetId);
											return asset ? <AssetLink key={assetId} asset={asset} /> : null;
										})}
									</p>
								)}
							</li>
						))}
					</ul>
				)}
			</section>

			{assets.length > 0 && (
				<section aria-labelledby="assets-heading" className="space-y-3">
					<h2 id="assets-heading" className="text-sm font-medium">
						Assets
					</h2>
					<div className="space-y-4">
						{ASSET_KINDS.map((kind) => {
							const ofKind = assets.filter((asset) => asset.kind === kind);
							if (ofKind.length === 0) return null;
							return (
								<div key={kind} className="space-y-1.5">
									<h3 className="text-xs text-muted-foreground">
										{ASSET_KIND_NAMES[kind]} · {ofKind.length}
									</h3>
									<ul className="divide-y rounded-lg border">
										{ofKind.map((asset) => (
											<AssetRow key={asset.id} asset={asset} />
										))}
									</ul>
								</div>
							);
						})}
					</div>
				</section>
			)}

			{applied.length > 0 && <AppliedSetups />}
			{applications.length > 0 && <Applications />}

			{repository.problems.length > 0 && (
				<section aria-labelledby="problems-heading" className="space-y-3">
					<h2 id="problems-heading" className="text-sm font-medium">
						Problems
					</h2>
					<ul className="divide-y rounded-lg border text-sm">
						{repository.problems.map((problem) => (
							<li key={`${problem.path}\0${problem.message}`} className="space-y-0.5 p-3">
								{problem.path && <p className="font-mono text-xs">{problem.path}</p>}
								<p className="text-muted-foreground">{problem.message}</p>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

/** The setups merged into this repository, and where the repository has moved away from each. */
function AppliedSetups() {
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const detail = Route.useLoaderData();
	if (!detail) return null;
	return (
		<section aria-labelledby="setups-heading" className="space-y-3">
			<h2 id="setups-heading" className="text-sm font-medium">
				Setups · {detail.applied.length}
			</h2>
			<ul className="divide-y rounded-lg border text-sm">
				{detail.applied.map(({ setup, drift }) => (
					<DriftRow
						key={setup.id}
						title={
							<Link
								to="/$workspace/setups/$setupId"
								params={{ workspace: slug, setupId: setup.id }}
								className="hover:underline"
							>
								{setup.name}
							</Link>
						}
						drift={drift}
						setup={setup}
						repository={detail.repository}
						admin={admin}
					/>
				))}
			</ul>
		</section>
	);
}

/** The pull requests that applied setups to this repository, newest first. */
function Applications() {
	const { slug } = useWorkspace();
	const detail = Route.useLoaderData();
	if (!detail) return null;
	return (
		<section aria-labelledby="applications-heading" className="space-y-3">
			<h2 id="applications-heading" className="text-sm font-medium">
				Pull requests · {detail.applications.length}
			</h2>
			<ul className="divide-y rounded-lg border text-sm">
				{detail.applications.map(({ application, setup }) => (
					<li key={application.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
						<span className="min-w-0 flex-1 truncate">
							<Link
								to="/$workspace/setups/$setupId"
								params={{ workspace: slug, setupId: setup.id }}
								className="hover:underline"
							>
								{setup.name}
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

function AssetLink({ asset }: { asset: Asset }) {
	const { slug } = useWorkspace();
	return (
		<Link
			to="/$workspace/assets/$assetId"
			params={{ workspace: slug, assetId: asset.id }}
			className="rounded border px-1.5 py-0.5 font-mono hover:bg-accent"
		>
			{asset.name}
		</Link>
	);
}

function AssetRow({ asset }: { asset: Asset }) {
	const { slug } = useWorkspace();
	return (
		<li>
			<Link
				to="/$workspace/assets/$assetId"
				params={{ workspace: slug, assetId: asset.id }}
				className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 hover:bg-accent/50"
			>
				<span className="text-sm font-medium">{asset.name}</span>
				{asset.path && asset.path !== asset.name && (
					<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
						{asset.path}
					</span>
				)}
				<span className="ml-auto text-xs text-muted-foreground tabular-nums">v{asset.version}</span>
				{asset.description && (
					<span className="w-full text-sm text-muted-foreground">{asset.description}</span>
				)}
			</Link>
		</li>
	);
}

function ScanButton({ pending }: { pending: boolean }) {
	const router = useRouter();
	const { workspace, repositoryId } = Route.useParams();
	const [asking, setAsking] = useState(false);

	async function scan() {
		setAsking(true);
		try {
			await scanRepository({ data: { slug: workspace, repositoryId } });
			await router.invalidate();
		} catch (error) {
			toast.error("Could not start a scan", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setAsking(false);
		}
	}

	return (
		<Button variant="outline" size="sm" onClick={scan} disabled={pending || asking}>
			<RefreshCw className={pending || asking ? "animate-spin" : undefined} />
			Scan now
		</Button>
	);
}
