import { ASSET_KIND_NAMES, ASSET_KINDS, type LibraryEntry } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { getLibrary } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/library")({
	loader: ({ params }) => getLibrary({ data: params.workspace }),
	component: LibraryPage,
});

function LibraryPage() {
	const library = Route.useLoaderData() ?? [];
	useDocumentTitle("Library");

	if (library.length === 0) {
		return (
			<Notice title="The library is empty">
				Open a skill, a prompt or any other asset in a repository and choose "Add to library". The
				library keeps its versions and shows every repository that carries one of them.
			</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">Library</h1>
				<p className="text-sm text-muted-foreground">
					The workspace's own versions of its skills, prompts and configuration, and where each is
					used.
				</p>
			</header>
			{ASSET_KINDS.map((kind) => {
				const ofKind = library.filter((entry) => entry.asset.kind === kind);
				if (ofKind.length === 0) return null;
				return (
					<section key={kind} aria-label={ASSET_KIND_NAMES[kind]} className="space-y-2">
						<h2 className="text-xs text-muted-foreground">
							{ASSET_KIND_NAMES[kind]} · {ofKind.length}
						</h2>
						<ul className="divide-y rounded-lg border">
							{ofKind.map((entry) => (
								<LibraryRow key={entry.asset.id} entry={entry} />
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}

function LibraryRow({ entry: { asset, uses, behind } }: { entry: LibraryEntry }) {
	const { slug } = useWorkspace();
	return (
		<li>
			<Link
				to="/$workspace/assets/$assetId"
				params={{ workspace: slug, assetId: asset.id }}
				className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3 hover:bg-accent/50"
			>
				<span className="min-w-0 flex-1">
					<span className="text-sm font-medium">{asset.name}</span>
					{asset.description && (
						<span className="block truncate text-sm text-muted-foreground">
							{asset.description}
						</span>
					)}
				</span>
				<span className="text-xs text-muted-foreground tabular-nums">v{asset.version}</span>
				<span className="w-44 text-right text-xs tabular-nums">
					{uses === 0 ? (
						<span className="text-muted-foreground">Not in any repository</span>
					) : (
						<>
							<span className="text-muted-foreground">
								{uses === 1 ? "In 1 repository asset" : `In ${uses} repository assets`}
							</span>
							{behind > 0 && (
								<span className="block text-amber-600 dark:text-amber-500">
									{behind} on an older version
								</span>
							)}
						</>
					)}
				</span>
			</Link>
		</li>
	);
}
