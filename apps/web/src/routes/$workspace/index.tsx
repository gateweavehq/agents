import type { Overview } from "@gateweave/agents-model";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RuntimeMatrix } from "#/components/registry/runtime-matrix";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { useRefreshWhile } from "#/lib/refresh";
import { getOverview } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/")({
	loader: ({ params }) => getOverview({ data: params.workspace }),
	component: OverviewPage,
});

const FORMATS = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursor/rules", "skills", "MCP servers"];

const COUNTS: { key: keyof Overview; label: string }[] = [
	{ key: "projects", label: "Projects" },
	{ key: "repositories", label: "Repositories" },
	{ key: "agents", label: "Agents" },
	{ key: "assets", label: "Assets" },
];

const EMPTY: Overview = { projects: 0, repositories: 0, agents: 0, assets: 0 };

function OverviewPage() {
	const { name } = useWorkspace();
	const data = Route.useLoaderData();
	const counts = data?.counts ?? EMPTY;
	const repositories = data?.repositories ?? [];
	useDocumentTitle("Overview");
	useRefreshWhile(repositories.some((repository) => repository.scanPending));

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">{name}</h1>
				<p className="text-sm text-muted-foreground">
					Which agents work in which repositories, and how each one is set up.
				</p>
			</header>
			<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{COUNTS.map(({ key, label }) => (
					<div key={key} className="rounded-lg border p-4">
						<dt className="text-xs text-muted-foreground">{label}</dt>
						<dd className="mt-1 text-2xl font-semibold tabular-nums">{counts[key]}</dd>
					</div>
				))}
			</dl>
			{repositories.length === 0 ? <GetStarted /> : <RuntimeMatrix repositories={repositories} />}
		</div>
	);
}

function GetStarted() {
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());

	return (
		<section className="space-y-3 rounded-lg border p-6">
			<h2 className="text-sm font-medium">No repositories yet</h2>
			<p className="text-sm text-muted-foreground">
				Connect GitHub and choose repositories. Gateweave Agents reads the agent configuration in
				each one and lists it here, and reads it again on every push to the default branch.
			</p>
			<ul className="flex flex-wrap gap-2">
				{FORMATS.map((format) => (
					<li key={format} className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
						{format}
					</li>
				))}
			</ul>
			{admin ? (
				<Button asChild size="sm">
					<Link to="/$workspace/settings/github" params={{ workspace: slug }}>
						Connect GitHub
					</Link>
				</Button>
			) : (
				<p className="text-sm text-muted-foreground">An owner or admin can connect GitHub.</p>
			)}
		</section>
	);
}
