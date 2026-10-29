import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { TeamEdgeKind } from "@gateweave/agents-model";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import {
	ArrowUp,
	CircleAlert,
	Forward,
	LoaderCircle,
	MessageCircleQuestionMark,
	Send,
	Square,
	Wrench,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { EDGE_STYLES } from "#/components/registry/team-graph";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import {
	type CallState,
	describeEdgeCall,
	describeToolCall,
	type ToolCallPart,
	toolCallsOf,
} from "#/lib/tool-calls";
import { cn } from "#/lib/utils";
import { Markdown } from "./markdown";

/**
 * A live conversation: its messages, the reply as it streams in, and the box to write the next
 * message. It connects through the app's chat gateway, which checks that the conversation is the
 * caller's, and reads the messages so far before it shows (so it suspends until then). In a
 * conversation with a team, `members` are the names of the team's members, to show each call over
 * an edge by the member it went to.
 */
export function ConversationView({
	slug,
	conversationId,
	agentName,
	members,
	disabled,
	onTurnEnd,
	onBusyChange,
}: {
	slug: string;
	conversationId: string;
	agentName: string;
	members: readonly string[] | null;
	disabled: boolean;
	onTurnEnd: () => void;
	onBusyChange?: (busy: boolean) => void;
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

	useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

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
						<Message key={message.id} message={message} agentName={agentName} members={members} />
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

/**
 * A conversation's messages as it stored them, with nothing to write: a trigger's run is read on
 * its page, since no person had its conversation.
 */
export function Transcript({
	messages,
	agentName,
	members,
}: {
	messages: readonly UIMessage[];
	agentName: string;
	members: readonly string[] | null;
}) {
	return (
		<div className="space-y-6">
			{messages.map((message) => (
				<Message key={message.id} message={message} agentName={agentName} members={members} />
			))}
		</div>
	);
}

function Message({
	message,
	agentName,
	members,
}: {
	message: UIMessage;
	agentName: string;
	members: readonly string[] | null;
}) {
	const mine = message.role === "user";
	const text = message.parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n");
	const calls = toolCallsOf(message);
	if (!text && calls.length === 0) return null;
	return (
		<div className={cn("flex", mine && "justify-end")}>
			<div
				className={cn(
					"max-w-[85%] text-sm leading-relaxed",
					mine ? "rounded-2xl bg-muted px-4 py-2 whitespace-pre-wrap" : "w-full min-w-0",
				)}
			>
				{!mine && <p className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</p>}
				{calls.length > 0 && (
					<ul aria-label="Tools used" className="mb-2 flex flex-wrap gap-1.5">
						{calls.map((part) => {
							const edge = members && describeEdgeCall(part, members);
							return edge ? (
								<EdgeCall key={part.toolCallId} {...edge} />
							) : (
								<ToolCall key={part.toolCallId} part={part} />
							);
						})}
					</ul>
				)}
				{mine ? text : text && <Markdown>{text}</Markdown>}
			</div>
		</div>
	);
}

const CHIP =
	"inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs text-muted-foreground";

/** A tool the agent called. What it took and gave back stays out of view. */
function ToolCall({ part }: { part: ToolCallPart }) {
	const { server, tool, state } = describeToolCall(part);
	const Icon = { running: LoaderCircle, done: Wrench, failed: CircleAlert }[state];

	return (
		<li className={cn(CHIP, state === "failed" && "border-destructive/40 text-destructive")}>
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

/** What a call over a team's edge did, before the member it went to, as it went. */
const EDGE_CALLS: Record<TeamEdgeKind, Record<CallState, string>> = {
	delegate: { running: "Delegating to", done: "Delegated to", failed: "Could not delegate to" },
	ask: { running: "Asking", done: "Asked", failed: "Could not ask" },
	report: { running: "Reporting to", done: "Reported to", failed: "Could not report to" },
};

const EDGE_ICONS = { delegate: Forward, ask: MessageCircleQuestionMark, report: Send };

/**
 * A call over one of the team's edges: its kind and the member it went to. The words it carried
 * stay out of view, as a tool's do; why it failed shows on hover, and the model says it too.
 */
function EdgeCall({
	edge,
	member,
	state,
	error,
}: {
	edge: TeamEdgeKind;
	member: string;
	state: CallState;
	error: string | null;
}) {
	const Icon =
		state === "running" ? LoaderCircle : state === "failed" ? CircleAlert : EDGE_ICONS[edge];
	return (
		<li
			className={cn(CHIP, state === "failed" && "border-destructive/40 text-destructive")}
			title={error ?? undefined}
		>
			<Icon
				aria-hidden="true"
				className={cn(
					"size-3 shrink-0",
					state === "running" && "animate-spin",
					state === "done" && EDGE_STYLES[edge].className,
				)}
			/>
			<span className="truncate">
				{EDGE_CALLS[edge][state]}{" "}
				<span className={cn("font-medium", state !== "failed" && "text-foreground")}>{member}</span>
			</span>
		</li>
	);
}
