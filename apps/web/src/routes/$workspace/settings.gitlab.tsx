import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { Notice } from "#/components/workspace/notice";
import { formatRelative } from "#/lib/dates";
import {
	connectGitLab,
	disconnectGitLab,
	type GitLabConnectionView,
	getGitLabConnections,
	newGitLabWebhookSecret,
	syncGitLab,
} from "#/lib/gitlab";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/gitlab")({
	loader: ({ params }) => getGitLabConnections({ data: params.workspace }),
	component: GitLabPage,
});

const failure = (error: unknown) => (error instanceof Error ? error.message : undefined);

/** A webhook's secret token, shown the one time it exists outside the registry. */
interface ShownSecret {
	connectionId: string;
	secret: string;
}

function GitLabPage() {
	const data = Route.useLoaderData();
	const [shown, setShown] = useState<ShownSecret | null>(null);
	useDocumentTitle("GitLab");

	if (!data.member) {
		return (
			<Notice title="GitLab unavailable">You are no longer a member of this workspace.</Notice>
		);
	}

	return (
		<section aria-labelledby="gitlab-heading" className="space-y-6">
			<div className="space-y-1">
				<h2 id="gitlab-heading" className="text-base font-semibold">
					GitLab
				</h2>
				<p className="text-sm text-muted-foreground">
					Connect gitlab.com or your own GitLab with an access token, and its projects are scanned
					for agents like GitHub repositories are. Applying setups and sandboxes work with GitHub
					repositories only, for now.
				</p>
			</div>
			{data.connections.length > 0 && (
				<ul className="divide-y rounded-lg border">
					{data.connections.map((connection) => (
						<ConnectionRow
							key={connection.id}
							connection={connection}
							admin={data.admin}
							secret={shown?.connectionId === connection.id ? shown.secret : null}
							onSecret={(secret) => setShown({ connectionId: connection.id, secret })}
						/>
					))}
				</ul>
			)}
			{data.admin ? (
				<ConnectForm onConnected={setShown} />
			) : (
				data.connections.length === 0 && (
					<p className="text-sm text-muted-foreground">An owner or admin can connect GitLab.</p>
				)
			)}
		</section>
	);
}

function ConnectForm({ onConnected }: { onConnected: (shown: ShownSecret) => void }) {
	const router = useRouter();
	const { workspace } = Route.useParams();
	const id = useId();
	const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		try {
			const made = await connectGitLab({
				data: { slug: workspace, connection: { baseUrl, token } },
			});
			setToken("");
			onConnected({ connectionId: made.connection.id, secret: made.webhookSecret });
			toast.success(
				`Connected as ${made.connection.account}, with ${made.connection.repositories} ${made.connection.repositories === 1 ? "project" : "projects"}`,
			);
			await router.invalidate();
		} catch (error) {
			toast.error("GitLab was not connected", { description: failure(error) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit} className="space-y-4 rounded-lg border p-4" aria-label="Connect GitLab">
			<div className="space-y-1">
				<h3 className="text-sm font-medium">Connect a GitLab</h3>
				<p className="text-sm text-muted-foreground">
					Make a project, group or personal access token in GitLab with the read_api and
					read_repository scopes, and at least the Reporter role. Its projects become repositories
					here. The token is kept encrypted and never shown again.
				</p>
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${id}-url`}>GitLab address</Label>
				<Input
					id={`${id}-url`}
					type="url"
					required
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
					placeholder="https://gitlab.com"
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor={`${id}-token`}>Access token</Label>
				<Input
					id={`${id}-token`}
					type="password"
					required
					autoComplete="off"
					value={token}
					onChange={(event) => setToken(event.target.value)}
					placeholder="glpat-…"
				/>
			</div>
			<Button type="submit" disabled={busy || token.trim() === ""}>
				{busy ? "Connecting…" : "Connect GitLab"}
			</Button>
		</form>
	);
}

function ConnectionRow({
	connection,
	admin,
	secret,
	onSecret,
}: {
	connection: GitLabConnectionView;
	admin: boolean;
	secret: string | null;
	onSecret: (secret: string) => void;
}) {
	const router = useRouter();
	const { workspace } = Route.useParams();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const host = new URL(connection.baseUrl).host;
	const data = { slug: workspace, connectionId: connection.id };

	async function sync() {
		setBusy(true);
		try {
			const synced = await syncGitLab({ data });
			toast.success(
				`${synced.repositories} ${synced.repositories === 1 ? "project" : "projects"} from ${host}`,
			);
		} catch (error) {
			toast.error(`Could not list ${host}'s projects`, { description: failure(error) });
		} finally {
			setBusy(false);
			await router.invalidate();
		}
	}

	async function renewSecret() {
		try {
			onSecret(await newGitLabWebhookSecret({ data }));
		} catch (error) {
			toast.error("No new secret token was made", { description: failure(error) });
		}
	}

	async function disconnect() {
		try {
			await disconnectGitLab({ data });
		} catch (error) {
			toast.error(`Could not disconnect ${host}`, { description: failure(error) });
			return;
		}
		toast.success(`${host} was disconnected`);
		await router.invalidate();
	}

	return (
		<li className="space-y-3 p-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{host}</p>
					<p className="text-xs text-muted-foreground">
						As {connection.account} · token ending {connection.tokenHint} ·{" "}
						{connection.repositories} {connection.repositories === 1 ? "project" : "projects"}
						{connection.syncedAt !== null && ` · listed ${formatRelative(connection.syncedAt)}`}
					</p>
					{connection.syncError && (
						<p className="text-xs text-destructive">{connection.syncError}</p>
					)}
				</div>
				{admin && (
					<div className="flex shrink-0 flex-wrap gap-2">
						<Button variant="outline" size="sm" onClick={sync} disabled={busy}>
							{busy ? "Listing…" : "List projects again"}
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
							Disconnect
						</Button>
					</div>
				)}
			</div>
			{admin && connection.webhookUrl && (
				<div className="space-y-2 rounded-md bg-muted/50 p-3 text-xs">
					<p className="text-muted-foreground">
						To rescan on every push, add a webhook in GitLab (the project's or group's Settings,
						then Webhooks) for push events, with this URL and the secret token.{" "}
						{connection.lastDeliveryAt === null
							? "No push has arrived yet."
							: `The last push arrived ${formatRelative(connection.lastDeliveryAt)}.`}
					</p>
					<CopyField label="URL" value={connection.webhookUrl} />
					{secret ? (
						<>
							<CopyField label="Secret token" value={secret} />
							<p className="text-muted-foreground">
								Copy the secret token now: it is not shown again.
							</p>
						</>
					) : (
						<Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={renewSecret}>
							Make a new secret token
						</Button>
					)}
				</div>
			)}
			{confirming && (
				<ConfirmDialog
					title={`Disconnect ${host}?`}
					confirmLabel="Disconnect"
					onConfirm={disconnect}
					onClose={() => setConfirming(false)}
				>
					Its projects leave this workspace and the token is forgotten. Revoke the token in GitLab
					too. Connecting again brings what was found back.
				</ConfirmDialog>
			)}
		</li>
	);
}

function CopyField({ label, value }: { label: string; value: string }) {
	async function copy() {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${label} copied`);
		} catch {
			toast.error("Copying did not work; select the text instead");
		}
	}
	return (
		<div className="flex items-center gap-2">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1" title={value}>
				{value}
			</code>
			<Button variant="outline" size="sm" className="h-7" onClick={copy}>
				Copy
			</Button>
		</div>
	);
}
