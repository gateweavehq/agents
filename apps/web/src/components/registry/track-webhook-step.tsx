import { useNavigate } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { useWorkspace } from "#/components/workspace/context";
import { replaceTriggerSecret } from "#/lib/triggers";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * The webhook to add in Track, and the secret Track shows for it, which the trigger then checks:
 * the second step of each ready-made agent for Track. `children` says which events to choose.
 */
export function TrackWebhookStep({
	made,
	done,
	children,
	onClose,
}: {
	made: { agentId: string; agentName: string; triggerId: string; url: string };
	/** What the toast says once the secret is saved. */
	done: string;
	children: ReactNode;
	onClose: () => void;
}) {
	const { slug } = useWorkspace();
	const navigate = useNavigate();
	const [secret, setSecret] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function openAgent() {
		onClose();
		await navigate({
			to: "/$workspace/agents/$agentId",
			params: { workspace: slug, agentId: made.agentId },
		});
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			await replaceTriggerSecret({
				data: { slug, triggerId: made.triggerId, secret: secret.trim() },
			});
			toast.success(done);
			await openAgent();
		} catch (failure) {
			setError(message(failure));
			setPending(false);
		}
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(made.url);
			toast.success("URL copied");
		} catch {
			toast.error("Could not copy; select it and copy it yourself");
		}
	}

	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<DialogHeader>
				<DialogTitle>Now tell Track</DialogTitle>
				<DialogDescription>{children}</DialogDescription>
			</DialogHeader>
			<div className="space-y-2">
				<Label htmlFor="track-webhook-url">URL</Label>
				<div className="flex gap-2">
					<Input
						id="track-webhook-url"
						value={made.url}
						readOnly
						onFocus={(event) => event.target.select()}
						className="font-mono text-xs"
					/>
					<Button
						type="button"
						variant="outline"
						size="icon"
						aria-label="Copy the URL"
						onClick={copy}
					>
						<Copy />
					</Button>
				</div>
			</div>
			<div className="space-y-2">
				<Label htmlFor="track-webhook-secret">The webhook's secret</Label>
				<Input
					id="track-webhook-secret"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={secret}
					onChange={(event) => setSecret(event.target.value)}
					placeholder="whsec_…"
					maxLength={200}
					required
				/>
				<p className="text-xs text-muted-foreground">
					Track shows it once, when the webhook is added. Until it is here, deliveries are refused.
					You can also paste it later on the agent's page, under Triggers.
				</p>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<DialogFooter className="gap-2">
				<Button type="button" variant="outline" onClick={openAgent} disabled={pending}>
					Later
				</Button>
				<Button type="submit" disabled={pending || !secret.trim()}>
					{pending ? "Saving…" : "Save and finish"}
				</Button>
			</DialogFooter>
		</form>
	);
}
