import type { TrackSourceDestination } from "@gateweave/agents-model";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { GATEWEAVE_TRACK } from "#/components/registry/track-connect-step";
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
import { beginTrackSource, disconnectTrackSource, getTrackSources } from "#/lib/track-sources";

export const trackSourceSearch = z.enum(["connected", "denied", "failed", "duplicate"]);

const messages: Record<z.infer<typeof trackSourceSearch>, string> = {
	connected: "Track run reporting destination connected.",
	denied: "Track approval was canceled.",
	failed: "Agents could not connect this Track source. Try again from Track run reporting.",
	duplicate:
		"This Track workspace and team are already connected. The existing destination was kept.",
};

export function TrackSources({
	slug,
	notice,
}: {
	slug: string;
	notice: z.infer<typeof trackSourceSearch> | undefined;
}) {
	const navigate = useNavigate();
	const [destinations, setDestinations] = useState<TrackSourceDestination[]>([]);
	const [listStatus, setListStatus] = useState<"loading" | "failed" | "ready">("loading");
	const [connect, setConnect] = useState(false);
	const [disconnect, setDisconnect] = useState<TrackSourceDestination | null>(null);

	useEffect(() => {
		let live = true;
		getTrackSources({ data: { slug } }).then(
			(found) => {
				if (!live) return;
				setDestinations(found);
				setListStatus("ready");
			},
			() => live && setListStatus("failed"),
		);
		return () => {
			live = false;
		};
	}, [slug]);

	useEffect(() => {
		if (!notice) return;
		if (notice === "connected") toast.success(messages[notice]);
		else toast.message(messages[notice]);
		void navigate({ to: ".", search: {}, replace: true });
	}, [notice, navigate]);

	return (
		<section aria-labelledby="track-sources-title" className="space-y-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h2 id="track-sources-title" className="text-sm font-medium">
						Track run reporting
					</h2>
					<p className="text-sm text-muted-foreground">
						Approve a Track workspace and team as a destination for future run status reports.
					</p>
				</div>
				<Button size="sm" variant="outline" onClick={() => setConnect(true)}>
					Connect Track source
				</Button>
			</div>
			{listStatus === "loading" && (
				<p className="text-sm text-muted-foreground">Loading Track destinations…</p>
			)}
			{listStatus === "failed" && (
				<p role="alert" className="text-sm text-destructive">
					Track destinations could not be loaded.
				</p>
			)}
			{destinations.length > 0 && (
				<ul className="divide-y rounded-lg border">
					{destinations.map((destination) => (
						<li
							key={destination.id}
							className="flex flex-wrap items-center justify-between gap-3 p-4"
						>
							<div className="min-w-0 space-y-1 break-words">
								<p className="text-sm font-medium">
									{destination.workspaceName} / {destination.teamName}
								</p>
								<p className="text-xs text-muted-foreground">
									{destination.trackOrigin} · {destination.workspaceSlug} / {destination.teamKey}
								</p>
							</div>
							<Button size="sm" variant="outline" onClick={() => setDisconnect(destination)}>
								Disconnect
							</Button>
						</li>
					))}
				</ul>
			)}
			{connect && <ConnectSourceDialog slug={slug} onClose={() => setConnect(false)} />}
			{disconnect && (
				<ConfirmDialog
					title={`Disconnect ${disconnect.workspaceName} / ${disconnect.teamName}?`}
					confirmLabel="Disconnect"
					onConfirm={async () => {
						try {
							await disconnectTrackSource({ data: { slug, connectionId: disconnect.id } });
							setDestinations((current) => current.filter(({ id }) => id !== disconnect.id));
							toast.success("Track destination disconnected.");
						} catch {
							toast.error("The Track destination could not be disconnected.");
						}
					}}
					onClose={() => setDisconnect(null)}
				>
					This removes the destination and its credential from Agents. To revoke the source in
					Track, open Settings &gt; Sources in that Track workspace.
				</ConfirmDialog>
			)}
		</section>
	);
}

function ConnectSourceDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
	const [trackUrl, setTrackUrl] = useState(GATEWEAVE_TRACK);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const open = useRef(true);

	useEffect(() => {
		open.current = true;
		const reset = (event: PageTransitionEvent) => {
			if (event.persisted) setPending(false);
		};
		window.addEventListener("pageshow", reset);
		return () => {
			open.current = false;
			window.removeEventListener("pageshow", reset);
		};
	}, []);

	async function submit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			const address = await beginTrackSource({ data: { slug, trackUrl } });
			if (open.current) window.location.assign(address);
		} catch (failure) {
			if (!open.current) return;
			setError(failure instanceof Error ? failure.message : "Could not start Track approval.");
			setPending(false);
		}
	}

	return (
		<Dialog open onOpenChange={(shown) => !shown && onClose()}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Connect Track source</DialogTitle>
					<DialogDescription>
						Choose the reporting workspace and team in Track and approve the source there.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="track-source-url">Track URL</Label>
						<Input
							id="track-source-url"
							type="url"
							value={trackUrl}
							onChange={(event) => setTrackUrl(event.target.value)}
							maxLength={2000}
							required
						/>
					</div>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending}>
							{pending ? "Going to Track…" : "Continue to Track"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
