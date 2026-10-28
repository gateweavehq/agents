import { type McpServerInput, mcpServerInput } from "@gateweave/agents-model";
import { type FormEvent, useState } from "react";
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
import { Textarea } from "#/components/ui/textarea";
import { formatHeaders, parseHeaders } from "#/lib/mcp-text";

function message(error: unknown) {
	return error instanceof Error ? error.message : "Something went wrong";
}

const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

type Settings = Omit<McpServerInput, "name">;

/**
 * Adds a remote MCP server to the library, or edits the settings of `server`. Headers name
 * variables of the agent's environment set, so no secret is ever written into the server.
 */
export function McpServerDialog({
	server,
	onSave,
	onClose,
}: {
	server?: { name: string; settings: Settings };
	onSave: (input: McpServerInput) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(server?.name ?? "");
	const [transport, setTransport] = useState<Settings["transport"]>(
		server?.settings.transport ?? "http",
	);
	const [url, setUrl] = useState(server?.settings.url ?? "");
	const [headers, setHeaders] = useState(formatHeaders(server?.settings.headers ?? []));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const parsed = parseHeaders(headers);
		if (!parsed.ok) {
			setError(parsed.error);
			return;
		}
		const input = { name: name.trim(), transport, url: url.trim(), headers: parsed.headers };
		// The registry checks the same, but its refusal would arrive as a list of issues.
		const checked = mcpServerInput.safeParse(input);
		if (!checked.success) {
			const [issue] = checked.error.issues;
			const header =
				issue?.path[0] === "headers" ? input.headers[Number(issue.path[1])] : undefined;
			const reason = issue?.message ?? "Check the server's settings";
			setError(header ? `${header.name}: ${reason}` : reason);
			return;
		}
		setPending(true);
		setError(null);
		try {
			await onSave(input);
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
						<DialogTitle>{server ? `Edit ${server.name}` : "New MCP server"}</DialogTitle>
						<DialogDescription>
							A server agents run by Gateweave reach over the network. Its tools become the agent's
							tools, and setups write it for coding agents too.
						</DialogDescription>
					</DialogHeader>
					{!server && (
						<div className="space-y-2">
							<Label htmlFor="mcp-name">Name</Label>
							<Input
								id="mcp-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={200}
								spellCheck={false}
								autoFocus
								required
							/>
						</div>
					)}
					<div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
						<div className="space-y-2">
							<Label htmlFor="mcp-transport">Transport</Label>
							<select
								id="mcp-transport"
								value={transport}
								onChange={(event) => setTransport(event.target.value as Settings["transport"])}
								className={SELECT}
							>
								<option value="http">Streamable HTTP</option>
								<option value="sse">SSE</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="mcp-url">URL</Label>
							<Input
								id="mcp-url"
								type="url"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								maxLength={2000}
								spellCheck={false}
								placeholder="https://mcp.example.com/mcp"
								required
							/>
						</div>
					</div>
					<div className="space-y-2">
						<Label htmlFor="mcp-headers">Headers</Label>
						<Textarea
							id="mcp-headers"
							value={headers}
							onChange={(event) => setHeaders(event.target.value)}
							rows={4}
							spellCheck={false}
							placeholder="Authorization: Bearer ${API_TOKEN}"
							className="font-mono text-xs"
						/>
						<p className="text-xs text-muted-foreground">
							One Name: value per line. Each value names a variable, as in{" "}
							<code>Bearer ${"{API_TOKEN}"}</code>, which the agent's environment set fills in. Keep
							tokens as secrets there, never here.
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
						<Button type="submit" disabled={pending || (!server && !name.trim()) || !url.trim()}>
							{server ? "Save" : "Add server"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
