import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { Notice } from "#/components/workspace/notice";
import { disconnectGitHub, type GitHubInstallationSummary, getGitHubSettings } from "#/lib/github";
import { useDocumentTitle } from "#/lib/title";

const RESULTS = ["connected", "denied", "taken", "requested", "failed", "forbidden"] as const;

export const Route = createFileRoute("/$workspace/settings/github")({
	validateSearch: z.object({ github: z.enum(RESULTS).optional().catch(undefined) }),
	loader: ({ params }) => getGitHubSettings({ data: params.workspace }),
	component: GitHubPage,
});

const MESSAGES: Record<(typeof RESULTS)[number], { text: string; ok: boolean }> = {
	connected: {
		text: "GitHub is connected. Its repositories are listed in this workspace.",
		ok: true,
	},
	requested: {
		text: "An owner of that organization has to approve the app. Connect again once they have.",
		ok: true,
	},
	denied: {
		text: "Your GitHub account cannot reach that installation, so it was not connected.",
		ok: false,
	},
	taken: {
		text: "That installation is connected to another workspace. Disconnect it there first.",
		ok: false,
	},
	forbidden: { text: "Only owners and admins can connect GitHub.", ok: false },
	failed: { text: "Connecting GitHub did not work. Try again.", ok: false },
};

function GitHubPage() {
	const data = Route.useLoaderData();
	const { workspace } = Route.useParams();
	const { github: result } = Route.useSearch();
	useDocumentTitle("GitHub");

	if (!data) {
		return (
			<Notice title="GitHub unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	if (!data.configured) {
		return (
			<Notice title="GitHub is not set up on this server">
				Whoever runs this server can create a GitHub App for it; see docs/github-app.md in the
				repository.
			</Notice>
		);
	}
	const message = result && MESSAGES[result];
	const connect = `/api/github/install?workspace=${encodeURIComponent(workspace)}`;

	return (
		<section aria-labelledby="github-heading" className="space-y-6">
			<div className="space-y-1">
				<h2 id="github-heading" className="text-base font-semibold">
					GitHub
				</h2>
				<p className="text-sm text-muted-foreground">
					The Gateweave Agents app reads the agent configuration in the repositories you choose. It
					asks only to read their contents.
				</p>
			</div>
			{message && (
				<p
					role="status"
					className={`rounded-lg border p-3 text-sm ${message.ok ? "" : "border-destructive/40 text-destructive"}`}
				>
					{message.text}
				</p>
			)}
			{data.installations.length > 0 && (
				<ul className="divide-y rounded-lg border">
					{data.installations.map((installation) => (
						<InstallationRow
							key={installation.id}
							installation={installation}
							canManage={data.canManage}
						/>
					))}
				</ul>
			)}
			{data.canManage ? (
				<Button asChild>
					<a href={connect}>
						{data.installations.length > 0 ? "Connect another account" : "Connect GitHub"}
					</a>
				</Button>
			) : (
				data.installations.length === 0 && (
					<p className="text-sm text-muted-foreground">An owner or admin can connect GitHub.</p>
				)
			)}
		</section>
	);
}

function InstallationRow({
	installation,
	canManage,
}: {
	installation: GitHubInstallationSummary;
	canManage: boolean;
}) {
	const router = useRouter();
	const { workspace } = Route.useParams();
	const [confirming, setConfirming] = useState(false);
	const { id, accountLogin, accountType } = installation;
	const configure =
		accountType === "Organization"
			? `https://github.com/organizations/${encodeURIComponent(accountLogin)}/settings/installations/${id}`
			: `https://github.com/settings/installations/${id}`;

	async function disconnect() {
		try {
			await disconnectGitHub({ data: { slug: workspace, installationId: id } });
		} catch (error) {
			toast.error(`Could not disconnect ${accountLogin}`, {
				description: error instanceof Error ? error.message : undefined,
			});
			return;
		}
		toast.success(`${accountLogin} was disconnected`);
		await router.invalidate();
	}

	return (
		<li className="flex items-center justify-between gap-4 p-3">
			<div className="min-w-0">
				<p className="truncate text-sm font-medium">{accountLogin}</p>
				<p className="text-xs text-muted-foreground">
					{accountType === "Organization" ? "Organization" : "Personal account"}
				</p>
			</div>
			<div className="flex shrink-0 gap-2">
				<Button asChild variant="outline" size="sm">
					<a href={configure} target="_blank" rel="noreferrer">
						Choose repositories
					</a>
				</Button>
				{canManage && (
					<Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
						Disconnect
					</Button>
				)}
			</div>
			{confirming && (
				<ConfirmDialog
					title={`Disconnect ${accountLogin}?`}
					confirmLabel="Disconnect"
					onConfirm={disconnect}
					onClose={() => setConfirming(false)}
				>
					Its repositories leave this workspace. The app stays installed on GitHub until you
					uninstall it there, and connecting it again brings everything back.
				</ConfirmDialog>
			)}
		</li>
	);
}
