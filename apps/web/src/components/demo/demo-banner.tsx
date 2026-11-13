/**
 * Says, on every page of a demo sandbox, what the visitor is looking at: sample data, agents that
 * answer from a script, and a workspace that goes away.
 */
export function DemoBanner() {
	return (
		<div className="shrink-0 border-b bg-muted/60 px-4 py-2 text-xs text-muted-foreground">
			<span className="font-medium text-foreground">Demo.</span> Acme is made up, its agents answer
			from a script, and this workspace is deleted a day after you opened it. Keys, MCP servers,
			triggers, scans and pull requests are off.{" "}
			<a
				className="font-medium text-foreground underline underline-offset-4"
				href="https://github.com/gateweavehq/agents/blob/main/docs/self-hosting.md"
				target="_blank"
				rel="noreferrer"
			>
				Deploy your own
			</a>{" "}
			to use it for real.
		</div>
	);
}
