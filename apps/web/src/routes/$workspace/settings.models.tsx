import {
	KEYED_PROVIDERS,
	type KeyedProvider,
	MODEL_PROVIDER_NAMES,
	type ProviderKey,
	type ProviderModel,
} from "@gateweave/agents-model";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { isAdmin, useMyRole } from "#/components/workspace/context";
import { Notice } from "#/components/workspace/notice";
import { formatDateTime, formatRelative } from "#/lib/dates";
import {
	checkProviderKey,
	getProviderKeys,
	getWorkersAiModels,
	removeProviderKey,
	saveProviderKey,
} from "#/lib/providers";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/models")({
	loader: async ({ params }) => {
		const [keys, workersAiModels] = await Promise.all([
			getProviderKeys({ data: params.workspace }),
			getWorkersAiModels({ data: params.workspace }),
		]);
		return keys && { ...keys, workersAiModels };
	},
	component: ModelsPage,
});

/** Where each provider hands out keys. */
const KEY_PAGES: Record<KeyedProvider, string> = {
	anthropic: "https://platform.claude.com/settings/keys",
	openai: "https://platform.openai.com/api-keys",
	google: "https://aistudio.google.com/apikey",
};

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

function ModelsPage() {
	const data = Route.useLoaderData();
	const admin = isAdmin(useMyRole());
	useDocumentTitle("Models");

	if (!data) {
		return (
			<Notice title="Models unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	return (
		<div className="space-y-10">
			{data.configured ? (
				<KeyedProviders keys={data.keys} admin={admin} />
			) : (
				<Notice title="Model keys are not set up on this server">
					Whoever runs this server can turn them on by setting the SECRETS_KEY secret; see the
					README in the repository.
				</Notice>
			)}
			<WorkersAi offered={data.workersAi} models={data.workersAiModels} />
		</div>
	);
}

function KeyedProviders({ keys, admin }: { keys: ProviderKey[]; admin: boolean }) {
	return (
		<section aria-labelledby="models-heading" className="space-y-6">
			<div className="space-y-1">
				<h2 id="models-heading" className="text-base font-semibold">
					Model providers
				</h2>
				<p className="text-sm text-muted-foreground">
					Agents in this workspace use models with the workspace's own keys, so usage is billed to
					your account with each provider. Keys are encrypted, and nobody can read one back here,
					not even an admin.
				</p>
			</div>
			<ul className="divide-y rounded-lg border">
				{KEYED_PROVIDERS.map((provider) => (
					<ProviderRow
						key={provider}
						provider={provider}
						saved={keys.find((key) => key.provider === provider)}
						admin={admin}
					/>
				))}
			</ul>
			{!admin && (
				<p className="text-sm text-muted-foreground">An owner or admin can add or change keys.</p>
			)}
		</section>
	);
}

/**
 * Workers AI has no key to add: this server's operator turns it on, and pays for the runs through
 * their own Cloudflare account. So the page only says whether it is on, and which models it has.
 */
function WorkersAi({
	offered,
	models,
}: {
	offered: boolean;
	/** The models, or why they could not be listed; null when the server does not offer it. */
	models: ProviderModel[] | string | null;
}) {
	const name = MODEL_PROVIDER_NAMES["workers-ai"];

	return (
		<section aria-labelledby="workers-ai-heading" className="space-y-3">
			<div className="space-y-1">
				<h2 id="workers-ai-heading" className="text-base font-semibold">
					{name}
				</h2>
				<p className="text-sm text-muted-foreground">
					{offered
						? "This server offers Workers AI models to every workspace. They need no key: whoever runs the server pays for their runs."
						: "This server does not offer Workers AI. Whoever runs it can turn it on by setting WORKERS_AI_TOKEN, and CLOUDFLARE_ACCOUNT_ID unless AI_GATEWAY_URL names the account; see the README in the repository."}
				</p>
			</div>
			{offered && models !== null && (
				<div className="rounded-lg border p-3 text-sm">
					{typeof models === "string" ? (
						<p role="alert" className="text-destructive">
							{models}
						</p>
					) : (
						<details>
							<summary className="cursor-pointer">
								{models.length === 1 ? "1 model" : `${models.length} models`} that can use tools
							</summary>
							<ul className="mt-2 space-y-0.5 font-mono text-xs text-muted-foreground">
								{models.map((model) => (
									<li key={model.id}>{model.id}</li>
								))}
							</ul>
						</details>
					)}
				</div>
			)}
		</section>
	);
}

function ProviderRow({
	provider,
	saved,
	admin,
}: {
	provider: KeyedProvider;
	saved: ProviderKey | undefined;
	admin: boolean;
}) {
	const router = useRouter();
	const { workspace: slug } = Route.useParams();
	const [editing, setEditing] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [checking, setChecking] = useState(false);
	const name = MODEL_PROVIDER_NAMES[provider];

	async function check() {
		setChecking(true);
		try {
			const checked = await checkProviderKey({ data: { slug, provider } });
			if (checked.check?.ok) toast.success(`The ${name} key works`);
			else toast.error(checked.check?.message ?? `The ${name} key did not work`);
			await router.invalidate();
		} catch (failure) {
			toast.error(message(failure));
		} finally {
			setChecking(false);
		}
	}

	async function remove() {
		try {
			await removeProviderKey({ data: { slug, provider } });
		} catch (failure) {
			toast.error(message(failure));
			return;
		}
		toast.success(`The ${name} key was removed`);
		await router.invalidate();
	}

	return (
		<li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3">
			<div className="min-w-0 space-y-0.5">
				<p className="text-sm font-medium">{name}</p>
				{saved ? (
					<>
						<p className="text-xs text-muted-foreground">
							<span className="font-mono">{`••••${saved.hint}`}</span>, added by {saved.addedBy}{" "}
							<span title={formatDateTime(saved.addedAt)}>{formatRelative(saved.addedAt)}</span>
						</p>
						<CheckResult saved={saved} />
					</>
				) : (
					<p className="text-xs text-muted-foreground">No key</p>
				)}
			</div>
			{admin && (
				<div className="flex shrink-0 gap-2">
					{saved && (
						<Button variant="outline" size="sm" onClick={check} disabled={checking}>
							{checking ? "Checking…" : "Check"}
						</Button>
					)}
					<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
						{saved ? "Replace" : "Add key"}
					</Button>
					{saved && (
						<Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
							Remove
						</Button>
					)}
				</div>
			)}
			{editing && (
				<KeyDialog
					provider={provider}
					onSave={async (key) => {
						const added = await saveProviderKey({ data: { slug, key: { provider, key } } });
						toast.success(`The ${name} key ending in ${added.hint} was saved`);
						await router.invalidate();
					}}
					onClose={() => setEditing(false)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title={`Remove the ${name} key?`}
					confirmLabel="Remove"
					onConfirm={remove}
					onClose={() => setRemoving(false)}
				>
					Agents in this workspace stop using {name} models until someone adds a key again. The key
					itself stays valid with {name}; revoke it there if it should no longer work.
				</ConfirmDialog>
			)}
		</li>
	);
}

function CheckResult({ saved }: { saved: ProviderKey }) {
	const { check } = saved;
	if (!check) return <p className="text-xs text-muted-foreground">Not checked yet</p>;
	const when = (
		<span title={formatDateTime(check.checkedAt)}>{formatRelative(check.checkedAt)}</span>
	);
	return check.ok ? (
		<p className="text-xs text-emerald-700 dark:text-emerald-400">
			Worked {when}: {check.models === 1 ? "1 model" : `${check.models} models`} available
		</p>
	) : (
		<p className="text-xs text-destructive">
			Failed {when}: {check.message}
		</p>
	);
}

function KeyDialog({
	provider,
	onSave,
	onClose,
}: {
	provider: KeyedProvider;
	onSave: (key: string) => Promise<void>;
	onClose: () => void;
}) {
	const [key, setKey] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = MODEL_PROVIDER_NAMES[provider];

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave(key);
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-md">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{name} key</DialogTitle>
						<DialogDescription>
							Create a key in{" "}
							<a
								href={KEY_PAGES[provider]}
								target="_blank"
								rel="noreferrer"
								className="underline underline-offset-2"
							>
								{name}'s console
							</a>{" "}
							and paste it here. It replaces the workspace's current {name} key, if there is one.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="provider-key">Key</Label>
						<Input
							id="provider-key"
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={key}
							onChange={(event) => setKey(event.target.value)}
							maxLength={1000}
							autoFocus
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || key.trim() === ""}>
							{pending ? "Saving…" : "Save key"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
