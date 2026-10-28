import type { EnvSetEntry } from "@gateweave/agents-model";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EnvSetDialog, SecretDialog } from "#/components/registry/environment-dialogs";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole, useWorkspace } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import {
	createEnvSet,
	editEnvSet,
	getEnvironment,
	removeEnvSecret,
	setEnvSecret,
} from "#/lib/environment";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/environment")({
	loader: ({ params }) => getEnvironment({ data: params.workspace }),
	component: EnvironmentPage,
});

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

function EnvironmentPage() {
	const data = Route.useLoaderData();
	const router = useRouter();
	const { slug } = useWorkspace();
	const admin = isAdmin(useMyRole());
	const [creating, setCreating] = useState(false);
	useDocumentTitle("Environment");

	if (!data) {
		return (
			<Notice title="Environment unavailable">You are no longer a member of this workspace.</Notice>
		);
	}

	return (
		<div className="mx-auto max-w-4xl space-y-8 px-4 py-10 sm:px-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">Environment</h1>
					<p className="text-sm text-muted-foreground">
						The variables and secrets agents run with. Variables are versioned like any library
						asset; secret values are encrypted and nobody can read one back, not even an admin.
					</p>
				</div>
				{admin && (
					<Button variant="outline" size="sm" onClick={() => setCreating(true)}>
						<Plus />
						New set
					</Button>
				)}
			</header>
			{!data.configured && (
				<p
					role="status"
					className="rounded-lg border border-amber-500/40 p-3 text-sm text-amber-600 dark:text-amber-500"
				>
					Secret values cannot be stored: this server has no SECRETS_KEY. Whoever runs it can turn
					them on by setting that secret; see the README in the repository. Sets with only variables
					work as they are.
				</p>
			)}
			{creating && (
				<EnvSetDialog
					onSave={async (set) => {
						await createEnvSet({ data: { slug, set } });
						toast.success(`${set.name} was created`);
						await router.invalidate();
					}}
					onClose={() => setCreating(false)}
				/>
			)}
			{data.sets.length === 0 ? (
				<div className="space-y-1 rounded-lg border p-6 text-center">
					<h2 className="text-base font-medium">No environment sets yet</h2>
					<p className="text-sm text-muted-foreground">
						A set holds the variables and secrets an agent needs, such as a region or an API token.
						An agent run by Gateweave picks one set.
						{admin ? "" : " An owner or admin can create one."}
					</p>
				</div>
			) : (
				<ul className="space-y-6">
					{data.sets.map((set) => (
						<EnvSetCard key={set.asset.id} set={set} configured={data.configured} admin={admin} />
					))}
				</ul>
			)}
		</div>
	);
}

function EnvSetCard({
	set,
	configured,
	admin,
}: {
	set: EnvSetEntry;
	configured: boolean;
	admin: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const { asset, variables, secrets, orphans, agents } = set;
	const names = Object.keys(variables);

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
				{admin && (
					<Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
						<Pencil />
						Edit
					</Button>
				)}
			</div>
			{editing && (
				<EnvSetDialog
					set={set}
					onSave={async (input) => {
						const version = await editEnvSet({
							data: {
								slug,
								set: { assetId: asset.id, variables: input.variables, secrets: input.secrets },
							},
						});
						toast.success(
							version === asset.version ? "Nothing changed" : `${asset.name} is now v${version}`,
						);
						await router.invalidate();
					}}
					onClose={() => setEditing(false)}
				/>
			)}

			<section aria-label={`Variables of ${asset.name}`} className="space-y-1">
				<h3 className="text-xs text-muted-foreground">Variables · {names.length}</h3>
				{names.length === 0 ? (
					<p className="text-sm text-muted-foreground">None.</p>
				) : (
					<dl className="divide-y rounded-md border font-mono text-xs">
						{Object.entries(variables).map(([name, value]) => (
							<div key={name} className="flex flex-wrap gap-x-4 gap-y-1 p-2">
								<dt className="w-56 shrink-0 truncate">{name}</dt>
								<dd className="min-w-0 flex-1 break-all text-muted-foreground">{value}</dd>
							</div>
						))}
					</dl>
				)}
			</section>

			<section aria-label={`Secrets of ${asset.name}`} className="space-y-1">
				<h3 className="text-xs text-muted-foreground">Secrets · {secrets.length}</h3>
				{secrets.length === 0 ? (
					<p className="text-sm text-muted-foreground">None.</p>
				) : (
					<ul className="divide-y rounded-md border text-sm">
						{secrets.map((secret) => (
							<SecretRow
								key={secret.name}
								set={set}
								name={secret.name}
								stored={secret.state === "set" ? secret : null}
								configured={configured}
								admin={admin}
							/>
						))}
					</ul>
				)}
			</section>

			{orphans.length > 0 && (
				<section aria-label={`Unused values of ${asset.name}`} className="space-y-1">
					<h3 className="text-xs text-muted-foreground">
						Values for names that are no longer secrets · {orphans.length}
					</h3>
					<ul className="divide-y rounded-md border text-sm">
						{orphans.map((orphan) => (
							<SecretRow
								key={orphan.name}
								set={set}
								name={orphan.name}
								stored={orphan}
								configured={configured}
								admin={admin}
								orphan
							/>
						))}
					</ul>
				</section>
			)}

			<section aria-label={`Agents using ${asset.name}`} className="space-y-1">
				<h3 className="text-xs text-muted-foreground">Used by · {agents.length}</h3>
				{agents.length === 0 ? (
					<p className="text-sm text-muted-foreground">No agent runs with this set.</p>
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
		</li>
	);
}

function SecretRow({
	set,
	name,
	stored,
	configured,
	admin,
	orphan = false,
}: {
	set: EnvSetEntry;
	name: string;
	stored: { setBy: string | null; setAt: number | null } | null;
	configured: boolean;
	admin: boolean;
	orphan?: boolean;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [setting, setSetting] = useState(false);
	const [removing, setRemoving] = useState(false);
	const assetId = set.asset.id;

	return (
		<li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-2">
			<div className="min-w-0 space-y-0.5">
				<p className="truncate font-mono text-xs">{name}</p>
				{stored?.setAt != null && (
					<p className="text-xs text-muted-foreground">
						Set by {stored.setBy}{" "}
						<span title={formatDateTime(stored.setAt)}>{formatRelative(stored.setAt)}</span>
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{!orphan &&
					(stored ? (
						<span className="text-xs text-emerald-700 dark:text-emerald-400">Set</span>
					) : (
						<span className="text-xs text-amber-600 dark:text-amber-500">Missing</span>
					))}
				{admin && !orphan && configured && (
					<Button variant="outline" size="sm" onClick={() => setSetting(true)}>
						{stored ? "Replace" : "Set"}
					</Button>
				)}
				{admin && stored && (
					<Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
						Remove
					</Button>
				)}
			</div>
			{setting && (
				<SecretDialog
					setName={set.asset.name}
					name={name}
					replacing={stored !== null}
					onSave={async (value) => {
						await setEnvSecret({ data: { slug, secret: { assetId, name, value } } });
						toast.success(`${name} was saved`);
						await router.invalidate();
					}}
					onClose={() => setSetting(false)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title={`Remove the value of ${name}?`}
					confirmLabel="Remove"
					onConfirm={async () => {
						try {
							await removeEnvSecret({ data: { slug, assetId, name } });
						} catch (failure) {
							toast.error(message(failure));
							return;
						}
						toast.success(`The value of ${name} was removed`);
						await router.invalidate();
					}}
					onClose={() => setRemoving(false)}
				>
					{orphan
						? "Nothing declares this name any more, so nothing reads the value."
						: `Agents that run with ${set.asset.name} lose ${name} until someone sets it again.`}
				</ConfirmDialog>
			)}
		</li>
	);
}
