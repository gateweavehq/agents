import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { ArrowUp, CircleAlert, LoaderCircle, Square, Wrench } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { describeToolCall } from "#/lib/tool-calls";
import { cn } from "#/lib/utils";
import { Markdown } from "./markdown";

/**
 * A live conversation: its messages, the reply as it streams in, and the box to write the next
 * message. It connects through the app's chat gateway, which checks that the conversation is the
 * caller's, and reads the messages so far before it shows (so it suspends until then).
 */
export function ConversationView({
	slug,
	conversationId,
	agentName,
	disabled,
	onTurnEnd,
}: {
	slug: string;
	conversationId: string;
	agentName: string;
	disabled: boolean;
	onTurnEnd: () => void;
}) {
	const agent = useAgent({
		agent: "ConversationAgent",
		basePath: `api/chat/${encodeURIComponent(slug)}/${conversationId}`,
	});
	const { messages, sendMessage, stop, status, error, clearError, isStreaming, isRecovering } =
		useAgentChat({ agent, onFinish: onTurnEnd, onError: onTurnEnd });
	const [draft, setDraft] = useState("");
	const busy = status === "submitted" || isStreaming || isRecovering;
	const end = useRef<HTMLDivElement>(null);

	// Follow the reply as it grows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls whenever the messages change.
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	async function send(event?: FormEvent) {
		event?.preventDefault();
		const text = draft.trim();
		if (!text || busy || disabled) return;
		clearError();
		setDraft("");
		await sendMessage({ text });
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void send();
		}
	}

	return (
		<>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
					{messages.length === 0 && (
						<p className="py-10 text-center text-sm text-muted-foreground">
							Write to {agentName} below.
						</p>
					)}
					{messages.map((message) => (
						<Message key={message.id} message={message} agentName={agentName} />
					))}
					{status === "submitted" && (
						<p className="text-sm text-muted-foreground" aria-live="polite">
							{agentName} is thinking…
						</p>
					)}
					{isRecovering && (
						<p className="text-sm text-muted-foreground" aria-live="polite">
							Picking the reply back up…
						</p>
					)}
					{error && (
						<p
							role="alert"
							className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
						>
							{error.message}
						</p>
					)}
					<div ref={end} />
				</div>
			</div>
			<form onSubmit={send} className="shrink-0 border-t p-3 sm:p-4">
				<div className="mx-auto flex max-w-3xl items-end gap-2">
					<Textarea
						aria-label={`Message ${agentName}`}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={disabled ? "This conversation cannot go on" : `Message ${agentName}`}
						disabled={disabled}
						rows={1}
						maxLength={100_000}
						className="max-h-48 min-h-10 resize-none"
					/>
					{busy ? (
						<Button type="button" size="icon" variant="outline" onClick={stop} aria-label="Stop">
							<Square />
						</Button>
					) : (
						<Button
							type="submit"
							size="icon"
							disabled={disabled || !draft.trim()}
							aria-label="Send"
						>
							<ArrowUp />
						</Button>
					)}
				</div>
			</form>
		</>
	);
}

function Message({ message, agentName }: { message: UIMessage; agentName: string }) {
	const mine = message.role === "user";
	const text = message.parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n");
	// The agent's MCP tools are known only when the turn runs, so the AI SDK calls them dynamic.
	const tools = message.parts.filter((part) => part.type === "dynamic-tool");
	if (!text && tools.length === 0) return null;
	return (
		<div className={cn("flex", mine && "justify-end")}>
			<div
				className={cn(
					"max-w-[85%] text-sm leading-relaxed",
					mine ? "rounded-2xl bg-muted px-4 py-2 whitespace-pre-wrap" : "w-full min-w-0",
				)}
			>
				{!mine && <p className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</p>}
				{tools.length > 0 && (
					<ul aria-label="Tools used" className="mb-2 flex flex-wrap gap-1.5">
						{tools.map((part) => (
							<ToolCall key={part.toolCallId} part={part} />
						))}
					</ul>
				)}
				{mine ? text : text && <Markdown>{text}</Markdown>}
			</div>
		</div>
	);
}

/** A tool the agent called. What it took and gave back stays out of view. */
function ToolCall({ part }: { part: DynamicToolUIPart }) {
	const { server, tool, state } = describeToolCall(part);
	const Icon = { running: LoaderCircle, done: Wrench, failed: CircleAlert }[state];

	return (
		<li
			className={cn(
				"inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted-foreground",
				state === "failed" && "border-destructive/40 text-destructive",
			)}
		>
			<Icon
				aria-hidden="true"
				className={cn("size-3 shrink-0", state === "running" && "animate-spin")}
			/>
			{server && (
				<>
					<span className="truncate">{server}</span>
					<span aria-hidden="true">·</span>
				</>
			)}
			<span className="truncate font-mono">{tool}</span>
			{state === "failed" && <span className="sr-only">(failed)</span>}
		</li>
	);
}
