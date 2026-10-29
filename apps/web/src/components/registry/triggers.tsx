import {
	TRIGGER_LIMITS,
	type TriggerDelivery,
	type TriggerDeliveryStatus,
	type TriggerTarget,
} from "@gateweave/agents-model";
import { Link, useRouter } from "@tanstack/react-router";
import { Copy, Ellipsis, Plus, Webhook } from "lucide-react";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import { useWorkspace } from "#/components/workspace/context";
import { formatDateTime, formatRelative } from "#/lib/dates";
import {
	createTrigger,
	deleteTrigger,
	replaceTriggerSecret,
	type TriggerSecretShown,
	type TriggerView,
	updateTrigger,
} from "#/lib/triggers";
import { cn } from "#/lib/utils";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

async function copy(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${what} copied`);
	} catch {
		toast.error("Could not copy; select it and copy it yourself");
	}
}

/**
 * An agent's or a team's triggers, for owners and admins: each is a URL another service posts its
 * webhooks to, and every event it signs starts a run with the trigger's prompt. Its secret is shown
 * once, when it is made or replaced.
 */
export function Triggers({
	target,
	targetName,
	triggers,
}: {
	target: TriggerTarget;
	targetName: string;
	triggers: TriggerView[];
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [creating, setCreating] = useState(false);
	const [shown, setShown] = useState<TriggerSecretShown | null>(null);

	return (
		<section aria-labelledby="triggers-heading" className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 id="triggers-heading" className="text-sm font-medium">
					{triggers.length === 0 ? "Triggers" : `Triggers · ${triggers.length}`}
				</h2>
				<Button variant="outline" size="sm" onClick={() => setCreating(true)}>
					<Plus />
					New trigger
				</Button>
			</div>
			{triggers.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-muted-foreground">
					No triggers: {targetName} answers only people in Chat. A trigger gives another service a
					URL to post its webhooks to, and each event it signs starts a run of {targetName}.
				</p>
			) : (
				<ul className="divide-y rounded-lg border text-sm">
					{triggers.map((trigger) => (
						<TriggerRow key={trigger.id} trigger={trigger} onSecret={setShown} />
					))}
				</ul>
			)}
			<p className="text-xs text-muted-foreground">
				Only owners and admins see triggers and the runs they start.
			</p>
			{creating && (
				<TriggerDialog
					targetName={targetName}
					onSave={async (input) => {
						const made = await createTrigger({ data: { slug, trigger: { ...input, target } } });
						setShown(made);
						await router.invalidate();
					}}
					onClose={() => setCreating(false)}
				/>
			)}
			{shown && <SecretShownDialog shown={shown} onClose={() => setShown(null)} />}
		</section>
	);
}

function TriggerRow({
	trigger,
	onSecret,
}: {
	trigger: TriggerView;
	onSecret: (shown: TriggerSecretShown) => void;
}) {
	const { slug } = useWorkspace();
	const router = useRouter();
	const [open, setOpen] = useState<"edit" | "rotate" | "paste" | "delete" | null>(null);
	const close = () => setOpen(null);

	async function setActive(active: boolean) {
		try {
			await updateTrigger({ data: { slug, triggerId: trigger.id, patch: { active } } });
			toast.success(active ? `${trigger.name} is on again` : `${trigger.name} is paused`);
			await router.invalidate();
		} catch (error) {
			toast.error(message(error));
		}
	}

	async function replace(secret?: string) {
		const replaced = await replaceTriggerSecret({
			data: { slug, triggerId: trigger.id, secret },
		});
		await router.invalidate();
		return replaced;
	}

	return (
		<li className="space-y-2 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<p className="flex flex-wrap items-center gap-2 font-medium">
						<Webhook aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
						{trigger.name}
						{!trigger.active && (
							<span className="rounded-md border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
								Paused
							</span>
						)}
					</p>
					<p className="text-xs text-muted-foreground">
						Up to {trigger.perDay} {trigger.perDay === 1 ? "run" : "runs"} a day · signed with{" "}
						<code>{trigger.secretStart}…</code>
					</p>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" className="size-8" aria-label="Trigger actions">
							<Ellipsis />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={() => setOpen("edit")}>Edit</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setActive(!trigger.active)}>
							{trigger.active ? "Pause" : "Turn on"}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => setOpen("rotate")}>New secret</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => setOpen("paste")}>
							Use the sender's secret
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => setOpen("delete")}
						>
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="flex items-center gap-2">
				<code className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1 text-xs">
					{trigger.url}
				</code>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label="Copy the URL"
					onClick={() => copy(trigger.url, "URL")}
				>
					<Copy />
				</Button>
			</div>
			<Deliveries deliveries={trigger.deliveries} />
			{open === "edit" && (
				<TriggerDialog
					trigger={trigger}
					targetName={trigger.targetName ?? "it"}
					onSave={async (input) => {
						await updateTrigger({ data: { slug, triggerId: trigger.id, patch: input } });
						await router.invalidate();
					}}
					onClose={close}
				/>
			)}
			{open === "rotate" && (
				<ConfirmDialog
					title={`Give ${trigger.name} a new secret?`}
					confirmLabel="Make a new secret"
					onConfirm={async () => {
						try {
							onSecret(await replace());
						} catch (error) {
							toast.error(message(error));
						}
					}}
					onClose={close}
				>
					Deliveries signed with the secret it has now are refused from then on, until the sender
					has the new one.
				</ConfirmDialog>
			)}
			{open === "paste" && (
				<PasteSecretDialog
					name={trigger.name}
					onSave={async (secret) => {
						await replace(secret);
						toast.success(`${trigger.name} now checks the sender's secret`);
					}}
					onClose={close}
				/>
			)}
			{open === "delete" && (
				<ConfirmDialog
					title={`Delete ${trigger.name}?`}
					confirmLabel="Delete"
					onConfirm={async () => {
						try {
							await deleteTrigger({ data: { slug, triggerId: trigger.id } });
							toast.success(`${trigger.name} was deleted`);
							await router.invalidate();
						} catch (error) {
							toast.error(message(error));
						}
					}}
					onClose={close}
				>
					Its URL stops starting runs. The runs it started stay.
				</ConfirmDialog>
			)}
		</li>
	);
}

const STATUSES: Record<TriggerDeliveryStatus, { label: string; className: string }> = {
	accepted: { label: "Starting", className: "text-sky-700 dark:text-sky-400" },
	started: { label: "Started", className: "text-emerald-700 dark:text-emerald-400" },
	skipped: { label: "Skipped", className: "text-muted-foreground" },
	limited: { label: "Over the limit", className: "text-amber-700 dark:text-amber-400" },
	failed: { label: "Failed", className: "text-destructive" },
};

/** What came to the trigger lately: whether each event started a run, and why not. */
function Deliveries({ deliveries }: { deliveries: TriggerDelivery[] }) {
	const { slug } = useWorkspace();
	if (deliveries.length === 0) {
		return <p className="text-xs text-muted-foreground">Nothing has come to it yet.</p>;
	}
	return (
		<details className="text-xs">
			<summary className="cursor-pointer text-muted-foreground">
				Latest deliveries · {formatRelative(deliveries[0]?.receivedAt ?? Date.now())}
			</summary>
			<ul className="mt-2 space-y-1">
				{deliveries.map((delivery) => {
					const { label, className } = STATUSES[delivery.status];
					return (
						<li key={delivery.id} className="flex flex-wrap items-baseline gap-x-2">
							<span className={cn("w-24 shrink-0", className)}>{label}</span>
							<span className="font-mono">{delivery.event ?? "event"}</span>
							<span className="text-muted-foreground" title={formatDateTime(delivery.receivedAt)}>
								{formatRelative(delivery.receivedAt)}
							</span>
							{delivery.runId ? (
								<Link
									to="/$workspace/runs/$runId"
									params={{ workspace: slug, runId: delivery.runId }}
									className="underline underline-offset-2"
								>
									Run
								</Link>
							) : (
								delivery.error && <span className="text-muted-foreground">{delivery.error}</span>
							)}
						</li>
					);
				})}
			</ul>
		</details>
	);
}

/** Makes a trigger, or edits `trigger`: its name, its prompt and how many runs it may start. */
function TriggerDialog({
	trigger,
	targetName,
	onSave,
	onClose,
}: {
	trigger?: TriggerView;
	targetName: string;
	onSave: (input: { name: string; prompt: string; perDay: number }) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(trigger?.name ?? "");
	const [prompt, setPrompt] = useState(trigger?.prompt ?? "");
	const [perDay, setPerDay] = useState(String(trigger?.perDay ?? TRIGGER_LIMITS.defaultPerDay));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave({ name: name.trim(), prompt: prompt.trim(), perDay: Number(perDay) });
			onClose();
		} catch (failure) {
			setError(message(failure));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent className="max-w-lg">
				<form onSubmit={onSubmit} className="space-y-4">
					<DialogHeader>
						<DialogTitle>{trigger ? `Edit ${trigger.name}` : "New trigger"}</DialogTitle>
						<DialogDescription>
							Each event the sender signs starts a run of {targetName}, with this prompt and the
							event after it. Runs spend the workspace's model keys.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="trigger-name">Name</Label>
						<Input
							id="trigger-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={80}
							placeholder="New issues"
							autoFocus
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="trigger-prompt">Prompt</Label>
						<Textarea
							id="trigger-prompt"
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							rows={6}
							maxLength={10_000}
							placeholder="Triage this issue: {{data.title}}"
							required
						/>
						<p className="text-xs text-muted-foreground">
							Write <code>{"{{path}}"}</code> to put in a value from the event, such as{" "}
							<code>{"{{data.title}}"}</code>.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="trigger-per-day">Runs a day</Label>
						<Input
							id="trigger-per-day"
							type="number"
							inputMode="numeric"
							min={1}
							max={TRIGGER_LIMITS.maxPerDay}
							value={perDay}
							onChange={(event) => setPerDay(event.target.value)}
							className="w-32"
							required
						/>
						<p className="text-xs text-muted-foreground">
							Events past this, or past {TRIGGER_LIMITS.perMinute} a minute, are turned away for the
							sender to retry later.
						</p>
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
						<Button type="submit" disabled={pending || !name.trim() || !prompt.trim()}>
							{trigger ? "Save" : "Create trigger"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** The URL and the secret for the sender, shown once. */
function SecretShownDialog({ shown, onClose }: { shown: TriggerSecretShown; onClose: () => void }) {
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Copy the secret now</DialogTitle>
					<DialogDescription>
						Give the sender this URL and secret, which it signs each event with, as Standard
						Webhooks do. The secret is not shown again; you can always make a new one.
					</DialogDescription>
				</DialogHeader>
				<CopyField id="trigger-url" label="URL" value={shown.trigger.url} />
				<CopyField id="trigger-secret" label="Secret" value={shown.secret} />
				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
	return (
		<div className="space-y-2">
			<Label htmlFor={id}>{label}</Label>
			<div className="flex gap-2">
				<Input
					id={id}
					value={value}
					readOnly
					onFocus={(event) => event.target.select()}
					className="font-mono text-xs"
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					aria-label={`Copy the ${label.toLowerCase()}`}
					onClick={() => copy(value, label)}
				>
					<Copy />
				</Button>
			</div>
		</div>
	);
}

/** Takes a secret the sender made, for senders that sign with their own, as Gateweave Track does. */
function PasteSecretDialog({
	name,
	onSave,
	onClose,
}: {
	name: string;
	onSave: (secret: string) => Promise<void>;
	onClose: () => void;
}) {
	const [value, setValue] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await onSave(value.trim());
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
						<DialogTitle>Use the sender's secret</DialogTitle>
						<DialogDescription>
							Some senders make the secret themselves and show it once, as Gateweave Track does for
							a webhook. {name} checks deliveries with it from then on, instead of the secret it has
							now.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="trigger-sender-secret">Secret</Label>
						<Input
							id="trigger-sender-secret"
							type="password"
							autoComplete="off"
							spellCheck={false}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							placeholder="whsec_…"
							maxLength={200}
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
						<Button type="submit" disabled={pending || !value.trim()}>
							{pending ? "Saving…" : "Use this secret"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
