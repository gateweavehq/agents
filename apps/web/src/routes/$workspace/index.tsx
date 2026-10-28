import { createFileRoute } from "@tanstack/react-router";
import { useWorkspace } from "#/components/workspace/context";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/")({
	component: OverviewPage,
});

const FORMATS = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursor/rules", "skills", "MCP servers"];

function OverviewPage() {
	const { name } = useWorkspace();
	useDocumentTitle("Overview");

	return (
		<div className="mx-auto max-w-3xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">{name}</h1>
				<p className="text-sm text-muted-foreground">
					Which agents work in which repositories, and how each one is set up.
				</p>
			</header>
			<section className="space-y-3 rounded-lg border p-6">
				<h2 className="text-sm font-medium">Nothing to show yet</h2>
				<p className="text-sm text-muted-foreground">
					Gateweave Agents reads the agent configuration in your repositories and lists it here, by
					project and repository. Connecting GitHub is the next step on the roadmap.
				</p>
				<ul className="flex flex-wrap gap-2">
					{FORMATS.map((format) => (
						<li key={format} className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
							{format}
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
