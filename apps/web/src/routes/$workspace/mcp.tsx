import type { McpCheck, McpServerEntry } from "@gateweave/agents-model";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import { checkMcpServer, disconnectMcpServer, getMcpServers } from "#/lib/registry";
import { useDocumentTitle } from "#/lib/title";

const OAUTH_RESULTS = ["connected", "denied", "failed", "forbidden", "expired"] as const;

/** What the OAuth flow's callback says about how it went (`apps/web/src/server/mcp-oauth.ts`). */
const OAUTH_MESSAGES: Record<(typeof OAUTH_RESULTS)[number], [ok: boolean, text: string]> = {
	connected: [true, "Connected. Agents that pin the server now sign in with your account on it"],
	denied: [false, "The server was not given access"],
	failed: [false, "The server could not be connected. Check that it supports OAuth sign-in"],
	forbidden: [false, "Only owners and admins can connect MCP servers"],
	expired: [false, "That sign-in had expired or was not yours. Try connecting again"],
};

export const Route = createFileRoute("/$workspace/mcp")({
	validateSearch: z.object({ oauth: z.enum(OAUTH_RESULTS).optional().catch(undefined) }),
	loader: ({ params }) => getMcpServers({ data: params.workspace }),
	component: McpPage,
});

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

function McpPage() {
	const servers = Route.useLoaderData();
	const { slug } = useWorkspace();
	const { oauth } = Route.useSearch();
	const navigate = useNavigate();
	useDocumentTitle("MCP servers");

	// Say once how connecting went, then drop it from the address.
	useEffect(() => {
		if (!oauth) return;
		const [ok, text] = OAUTH_MESSAGES[oauth];
		if (ok) toast.success(text);
		else toast.error(text);
		void navigate({
			to: "/$workspace/mcp",
			params: { workspace: slug },
			search: {},
			replace: true,
		});
	}, [oauth, navigate, slug]);

	if (!servers) {
		return (
			<Notice title="MCP servers unavailable">You are no longer a member of this workspace.</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="space-y-1">
				<h1 className="text-xl font-semibold tracking-tight">MCP servers</h1>
				<p className="text-sm text-muted-foreground">
					The servers in the library that agents run by Gateweave can use for tools, and the agents
					that pin each. A check connects the way an agent does and lists the tools the server
					offers.
				</p>
			</header>
			{servers.length === 0 ? (
				<div className="space-y-1 rounded-lg border p-6 text-center">
					<h2 className="text-base font-medium">No MCP servers yet</h2>
					<p className="text-sm text-muted-foreground">
						Add one with “New MCP server” in the{" "}
						<Link to="/$workspace/library" params={{ workspace: slug }} className="underline">
							library
						</Link>
						, then pin it on an agent.
					</p>
				</div>
			) : (
				<ul className="space-y-6">
					{servers.map((server) => (
						<ServerCard key={server.asset.id} server={server} />
					))}
				</ul>
			)}
		</div>
	);
}

function ServerCard({ server }: { server: McpServerEntry }) {
	const { slug } = useWorkspace();
	const { asset, connection, variables, agents, check } = server;

	return (
		<li className="space-y-4 rounded-lg border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="min-w-0 truncate text-base font-medium">
					<Link
						to="/$workspace/assets/$assetId"
						params={{ workspace: slug, assetId: asset.id }}
						className="hover:underline"
					>
						{asset.name}
					</Link>{" "}
					<span className="text-xs font-normal text-muted-foreground tabular-nums">
						v{asset.version}
					</span>
				</h2>
				{"problem" in connection || connection.transport === "stdio" ? null : (
					<CheckButton server={server} />
				)}
			</div>

			{"problem" in connection ? (
				<p className="text-sm text-muted-foreground">{connection.problem}</p>
			) : connection.transport === "stdio" ? (
				<div className="space-y-0.5 text-sm">
					<p>
						<span className="text-xs uppercase text-muted-foreground">command</span>{" "}
						<span className="break-all font-mono text-xs">
							{[connection.command, ...connection.args].join(" ")}
						</span>
					</p>
					<p className="text-xs text-muted-foreground">
						Starts in the sandbox of each agent with one that uses it, so it is checked there.
					</p>
				</div>
			) : (
				<p className="text-sm">
					<span className="text-xs uppercase text-muted-foreground">{connection.transport}</span>{" "}
					<span className="break-all font-mono text-xs">{connection.url}</span>
				</p>
			)}

			{!("problem" in connection) && connection.transport !== "stdio" && (
				<OAuthConnection server={server} />
			)}

			<section aria-label={`Variables of ${asset.name}`} className="space-y-1">
				<h3 className="text-xs text-muted-foreground">Variables it needs · {variables.length}</h3>
				{variables.length === 0 ? (
					<p className="text-sm text-muted-foreground">None.</p>
				) : (
					<ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
						{variables.map((name) => (
							<li key={name}>{name}</li>
						))}
					</ul>
				)}
			</section>

			<section aria-label={`Agents using ${asset.name}`} className="space-y-1">
				<h3 className="text-xs text-muted-foreground">Used by · {agents.length}</h3>
				{agents.length === 0 ? (
					<p className="text-sm text-muted-foreground">No agent pins this server.</p>
				) : (
					<ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
						{agents.map((agent) => (
							<li key={agent.id}>
								<Link
									to="/$workspace/agents/$agentId"
									params={{ workspace: slug, agentId: agent.id }}
									className="hover:underline"
								>
									{agent.name}
								</Link>{" "}
								<span className="text-xs text-muted-foreground tabular-nums">
									v{agent.version}
									{agent.version < asset.version && `, v${asset.version} is out`}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>

			<section aria-label={`Last check of ${asset.name}`} className="space-y-1">
				<h3 className="text-xs text-muted-foreground">Last check</h3>
				{check ? (
					<CheckResult check={check} current={asset.version} />
				) : (
					<p className="text-sm text-muted-foreground">Not checked yet.</p>
				)}
			</section>
		</li>
	);
}

/**
 * The workspace's OAuth connection to a remote server (AGT-78): who made it, and Connect or
 * Disconnect for owners and admins. Connecting sends them through the server's own sign-in.
 */
function OAuthConnection({ server }: { server: McpServerEntry }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const admin = isAdmin(useMyRole());
	const [pending, setPending] = useState(false);
	const { oauth, asset } = server;
	const connect = `/api/mcp-oauth/connect?${new URLSearchParams({ workspace: slug, server: asset.id })}`;

	async function disconnect() {
		setPending(true);
		try {
			await disconnectMcpServer({ data: { slug, assetId: asset.id } });
			toast.success(`${asset.name} is no longer connected`);
			await router.invalidate();
		} catch (failure) {
			toast.error(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<section aria-label={`Sign-in to ${asset.name}`} className="space-y-1">
			<h3 className="text-xs text-muted-foreground">OAuth</h3>
			{oauth ? (
				<p className="text-sm">
					{oauth.current ? (
						<>
							Connected by {oauth.connectedBy}{" "}
							<span className="text-muted-foreground" title={formatDateTime(oauth.connectedAt)}>
								{formatRelative(oauth.connectedAt)}
							</span>
							. Agents that pin it act as them on the server.
						</>
					) : (
						<span className="text-amber-600 dark:text-amber-500">
							Connected for an earlier URL, so it is not used. Connect again for this one.
						</span>
					)}
				</p>
			) : (
				<p className="text-sm text-muted-foreground">
					Not connected. A server that signs in with OAuth needs no key in a header.
				</p>
			)}
			{admin && (
				<div className="flex gap-2 pt-1">
					<Button asChild variant="outline" size="sm">
						<a href={connect}>{oauth ? "Connect again" : "Connect"}</a>
					</Button>
					{oauth && (
						<Button variant="ghost" size="sm" onClick={disconnect} disabled={pending}>
							Disconnect
						</Button>
					)}
				</div>
			)}
		</section>
	);
}

function CheckButton({ server }: { server: McpServerEntry }) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const admin = isAdmin(useMyRole());
	const [checking, setChecking] = useState(false);
	if (!admin) return null;

	async function run() {
		setChecking(true);
		try {
			const check = await checkMcpServer({ data: { slug, assetId: server.asset.id } });
			if (check.ok) toast.success(`${server.asset.name} works`);
			else toast.error(check.error ?? `${server.asset.name} did not work`);
			await router.invalidate();
		} catch (failure) {
			toast.error(message(failure));
		} finally {
			setChecking(false);
		}
	}

	return (
		<Button variant="outline" size="sm" onClick={run} disabled={checking}>
			{checking ? "Checking…" : "Check"}
		</Button>
	);
}

function CheckResult({ check, current }: { check: McpCheck; current: number }) {
	return (
		<div className="space-y-2">
			<p className="text-sm">
				{check.ok ? (
					<span className="text-emerald-700 dark:text-emerald-400">Worked</span>
				) : (
					<span className="text-destructive">{check.error}</span>
				)}{" "}
				<span className="text-xs text-muted-foreground">
					<span title={formatDateTime(check.checkedAt)}>{formatRelative(check.checkedAt)}</span>, v
					{check.version}
					{check.version < current && `; v${current} has not been checked`}
				</span>
			</p>
			{check.ok &&
				(check.tools.length === 0 ? (
					<p className="text-sm text-muted-foreground">It offers no tools.</p>
				) : (
					<ul className="divide-y rounded-md border text-sm">
						{check.tools.map((tool) => (
							<li key={tool.name} className="space-y-0.5 p-2">
								<p className="break-all font-mono text-xs">{tool.name}</p>
								{tool.description && (
									<p className="text-xs text-muted-foreground">{tool.description}</p>
								)}
							</li>
						))}
					</ul>
				))}
		</div>
	);
}
