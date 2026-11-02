import type { TelemetrySettings } from "@gateweave/agents-model";
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
import { getTelemetry, removeTelemetry, setTelemetry } from "#/lib/telemetry";
import { useDocumentTitle } from "#/lib/title";

export const Route = createFileRoute("/$workspace/settings/telemetry")({
	loader: ({ params }) => getTelemetry({ data: params.workspace }),
	component: TelemetryPage,
});

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

function TelemetryPage() {
	const data = Route.useLoaderData();
	const { workspace: slug } = Route.useParams();
	const router = useRouter();
	const admin = isAdmin(useMyRole());
	const [editing, setEditing] = useState(false);
	const [removing, setRemoving] = useState(false);
	useDocumentTitle("Telemetry");

	if (!data.member) {
		return (
			<Notice title="Telemetry unavailable">You are no longer a member of this workspace.</Notice>
		);
	}
	const { settings } = data;
	return (
		<section aria-labelledby="telemetry-heading" className="space-y-6">
			<div className="space-y-1">
				<h2 id="telemetry-heading" className="text-base font-semibold">
					OpenTelemetry
				</h2>
				<p className="text-sm text-muted-foreground">
					Send each run's trace to your own observability tool, such as Honeycomb, Grafana or
					Datadog, over OTLP/HTTP: the agent's run, its model requests with their tokens and cost,
					its tool calls and its team's calls, with a team's turn as one trace. No message text and
					no tool input or output is sent.
				</p>
			</div>

			{settings ? (
				<div className="space-y-3 rounded-lg border p-4">
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
						<dt className="text-muted-foreground">Endpoint</dt>
						<dd className="break-all font-mono text-xs leading-5">{settings.endpoint}</dd>
						<dt className="text-muted-foreground">Headers</dt>
						<dd>
							{settings.headers.length === 0 ? (
								"None"
							) : (
								<span className="font-mono text-xs">{settings.headers.join(", ")}</span>
							)}
						</dd>
						<dt className="text-muted-foreground">Last export</dt>
						<dd>
							<LastExport settings={settings} />
						</dd>
					</dl>
					<p className="text-xs text-muted-foreground">
						Set by {settings.setBy}{" "}
						<span title={formatDateTime(settings.setAt)}>{formatRelative(settings.setAt)}</span>.
						Header values are encrypted, and nobody can read one back here.
					</p>
					{admin && (
						<div className="flex gap-2">
							<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
								Change
							</Button>
							<Button size="sm" variant="outline" onClick={() => setRemoving(true)}>
								Stop exporting
							</Button>
						</div>
					)}
				</div>
			) : (
				<div className="space-y-3 rounded-lg border border-dashed p-4">
					<p className="text-sm text-muted-foreground">This workspace does not export traces.</p>
					{admin && (
						<Button size="sm" onClick={() => setEditing(true)}>
							Set up export
						</Button>
					)}
				</div>
			)}
			{!admin && (
				<p className="text-sm text-muted-foreground">
					An owner or admin can change where traces go.
				</p>
			)}

			{editing && (
				<EndpointDialog
					current={settings}
					onSave={async (endpoint, headers) => {
						await setTelemetry({ data: { slug, settings: { endpoint, headers } } });
						toast.success("Traces of new runs go to the endpoint");
						await router.invalidate();
					}}
					onClose={() => setEditing(false)}
				/>
			)}
			{removing && (
				<ConfirmDialog
					title="Stop exporting traces?"
					confirmLabel="Stop"
					onConfirm={async () => {
						try {
							await removeTelemetry({ data: { slug } });
						} catch (failure) {
							toast.error(message(failure));
							return;
						}
						toast.success("Traces are no longer exported");
						await router.invalidate();
					}}
					onClose={() => setRemoving(false)}
				>
					Runs from now on are not sent, and the endpoint's headers are deleted here. Traces already
					sent stay where they are.
				</ConfirmDialog>
			)}
		</section>
	);
}

function LastExport({ settings }: { settings: TelemetrySettings }) {
	const last = settings.lastExport;
	if (!last) return <span className="text-muted-foreground">None yet</span>;
	const when = <span title={formatDateTime(last.at)}>{formatRelative(last.at)}</span>;
	return last.ok ? (
		<span className="text-emerald-700 dark:text-emerald-400">Sent {when}</span>
	) : (
		<span className="text-destructive">
			Failed {when}: {last.error}
		</span>
	);
}

interface HeaderRow {
	name: string;
	value: string;
}

function EndpointDialog({
	current,
	onSave,
	onClose,
}: {
	current: TelemetrySettings | null;
	onSave: (endpoint: string, headers: HeaderRow[]) => Promise<void>;
	onClose: () => void;
}) {
	const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
	// Values are never sent back, so changing the settings means entering them again.
	const [headers, setHeaders] = useState<HeaderRow[]>(
		current && current.headers.length > 0
			? current.headers.map((name) => ({ name, value: "" }))
			: [{ name: "", value: "" }],
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const update = (index: number, change: Partial<HeaderRow>) =>
		setHeaders((rows) => rows.map((row, at) => (at === index ? { ...row, ...change } : row)));

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setPending(true);
		setError(null);
		try {
			const filled = headers.filter((row) => row.name.trim() !== "" || row.value.trim() !== "");
			await onSave(endpoint, filled);
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
						<DialogTitle>Export traces</DialogTitle>
						<DialogDescription>
							The OTLP/HTTP endpoint your tool gives, such as https://api.honeycomb.io. Traces are
							posted to its /v1/traces. Put API keys in headers, not in the URL.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor="telemetry-endpoint">Endpoint</Label>
						<Input
							id="telemetry-endpoint"
							type="url"
							placeholder="https://"
							value={endpoint}
							onChange={(event) => setEndpoint(event.target.value)}
							maxLength={2000}
							autoFocus
							required
						/>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">Headers</legend>
						{current && current.headers.length > 0 && (
							<p className="text-xs text-muted-foreground">
								Enter the values again: they are encrypted, and cannot be shown.
							</p>
						)}
						{headers.map((row, index) => (
							// Rows have no identity but their place.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above
							<div key={index} className="flex gap-2">
								<Input
									aria-label={`Header ${index + 1} name`}
									placeholder="x-honeycomb-team"
									value={row.name}
									onChange={(event) => update(index, { name: event.target.value })}
									maxLength={100}
									className="font-mono text-xs"
								/>
								<Input
									aria-label={`Header ${index + 1} value`}
									type="password"
									autoComplete="off"
									spellCheck={false}
									placeholder="Value"
									value={row.value}
									onChange={(event) => update(index, { value: event.target.value })}
									maxLength={4000}
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-label={`Remove header ${index + 1}`}
									onClick={() => setHeaders((rows) => rows.filter((_, at) => at !== index))}
								>
									×
								</Button>
							</div>
						))}
						{headers.length < 10 && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setHeaders((rows) => [...rows, { name: "", value: "" }])}
							>
								Add a header
							</Button>
						)}
					</fieldset>
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
					<DialogFooter className="gap-2">
						<Button type="button" variant="outline" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={pending || endpoint.trim() === ""}>
							{pending ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
