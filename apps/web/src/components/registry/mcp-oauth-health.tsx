import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getMcpOAuthHealth } from "#/lib/registry";
import type { McpOAuthHealth, McpOAuthHealthState } from "#/server/mcp-health";

/** Checks on page load, without delaying the page's first paint. */
export function useMcpOAuthHealth(slug: string, agentIds?: string[]): McpOAuthHealth[] | null {
	const ids = agentIds?.join(",");
	const [health, setHealth] = useState<McpOAuthHealth[] | null>(null);
	useEffect(() => {
		let live = true;
		setHealth(null);
		void getMcpOAuthHealth({
			data: { slug, ...(ids === undefined ? {} : { agentIds: ids ? ids.split(",") : [] }) },
		})
			.then((found) => {
				if (live) setHealth(found ?? []);
			})
			.catch(() => {
				if (live) {
					setHealth([]);
					toast.error("Could not check MCP connections");
				}
			});
		return () => {
			live = false;
		};
	}, [slug, ids]);
	return health;
}

export function McpOAuthStatus({
	state,
	checkedAt,
	reason,
}: {
	state: McpOAuthHealthState | "checking";
	checkedAt?: number;
	reason?: string;
}) {
	const checked = checkedAt ? ` (last checked ${new Date(checkedAt).toLocaleString()})` : "";
	if (state === "checking")
		return <span className="text-muted-foreground">Checking connection…</span>;
	if (state === "connected")
		return <span className="text-emerald-700 dark:text-emerald-400">Connected{checked}</span>;
	if (state === "needs-reconnecting")
		return <span className="text-amber-600 dark:text-amber-500">Needs reconnecting{checked}</span>;
	return (
		<span className="text-muted-foreground">
			Could not check{reason ? `: ${reason}` : ""}
			{checked}
		</span>
	);
}
