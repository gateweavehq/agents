import { useAgentChat } from "@cloudflare/ai-chat/react";
import { SESSION_ENDED, type TeamEdgeKind } from "@gateweave/agents-model";
import { Link } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import {
	ArrowUp,
	CircleAlert,
	Forward,
	GitPullRequestArrow,
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
import { useWorkspace } from "#/components/workspace/context";
import {
	type CallState,
	describeEdgeCall,
	describePullRequestCall,
	describeToolCall,
	type ToolCallPart,
	toolCallsOf,
} from "#/lib/tool-calls";
import { cn } from "#/lib/utils";
import { Markdown } from "./markdown";

interface ConversationProps {
	slug: string;
	conversationId: string;
	agentName: string;
	members: readonly string[] | null;
	disabled: boolean;
	onTurnEnd: () => void;
	onBusyChange?: (busy: boolean) => void;
}

/** A new socket closed sooner than this after the last one would close the next one too. */
const REOPEN_AT_MOST_EVERY_MS = 5_000;

/** Why this conversation cannot go on in this page. */
type Ended = "signed-out" | "no-access";

/**
 * Asks the gateway whether a socket for this conversation would open now, which a failed handshake
 * does not say. Null means it could not tell, which usually means the network.
 */
async function endedForNow(path: string): Promise<Ended | "open" | null> {
	const response = await fetch(path, { method: "HEAD", cache: "no-store" }).catch(() => null);
	if (response?.ok) return "open";
	if (response?.status === 401) return "signed-out";
	if (response?.status === 404) return "no-access";
	return null;
}

/**
 * A live conversation. A socket keeps the session it opened with and closes for good at the first
 * message after that session ends or its person leaves the workspace, with that message refused.
 * This browser may hold a newer session by then, as it does after changing a password, so going on
 * takes a new socket, which a new key gives. What was being written outlasts the socket here.
 */
export function ConversationView(props: ConversationProps) {
	const [socket, setSocket] = useState(0);
	// True for the one render between two sockets. The chat hook keeps what it read for a conversation
	// until the component that read it has gone, so a new one mounted in its place would get the
	// messages from when the page opened.
	const [betweenSockets, setBetweenSockets] = useState(false);
	const [draft, setDraft] = useState("");
	const [notSent, setNotSent] = useState(false);
	const [ended, setEnded] = useState<Ended | null>(null);
	const reopenedAt = useRef(0);
	const path = `/api/chat/${encodeURIComponent(props.slug)}/${props.conversationId}`;

	useEffect(() => {
		if (!betweenSockets) return;
		setBetweenSockets(false);
		setSocket((current) => current + 1);
	}, [betweenSockets]);

	function giveBack(unsent: string) {
		if (unsent) setDraft((typed) => (typed ? `${unsent}\n\n${typed}` : unsent));
	}

	// The server closed the socket for good. Without a network to ask, a new socket waits for one.
	async function onSessionClosed(unsent: string) {
		giveBack(unsent);
		const now = await endedForNow(path);
		if (now === "signed-out" || now === "no-access") {
			setEnded(now);
		} else if (Date.now() - reopenedAt.current < REOPEN_AT_MOST_EVERY_MS) {
			setEnded("signed-out");
		} else {
			reopenedAt.current = Date.now();
			setNotSent(Boolean(unsent));
			setBetweenSockets(true);
		}
	}

	// The socket dropped and is trying again, which goes on for ever if the gateway refuses it.
	function onSocketRefused(reason: Ended, unsent: string) {
		giveBack(unsent);
		setEnded(reason);
	}

	if (betweenSockets) return null;

	return (
		<LiveConversation
			key={socket}
			{...props}
			draft={draft}
			onDraftChange={setDraft}
			notSent={notSent}
			onSend={() => setNotSent(false)}
			ended={ended}
			onSessionClosed={onSessionClosed}
			onSocketRefused={onSocketRefused}
			probePath={path}
		/>
	);
}

/**
 * One socket's conversation: its messages, the reply as it streams in, and the box to write the
 * next message. It connects through the app's chat gateway, which checks that the conversation is
 * the caller's, and reads the messages so far before it shows (so it suspends until then). In a
 * conversation with a team, `members` are the names of the team's members, to show each call over
 * an edge by the member it went to.
 */
function LiveConversation({
	slug,
	conversationId,
	agentName,
	members,
	disabled,
	onTurnEnd,
	onBusyChange,
	draft,
	onDraftChange,
	notSent,
	onSend,
	ended,
	onSessionClosed,
	onSocketRefused,
	probePath,
}: ConversationProps & {
	draft: string;
	onDraftChange: (draft: string) => void;
	notSent: boolean;
	onSend: () => void;
	ended: Ended | null;
	onSessionClosed: (unsent: string) => Promise<void>;
	onSocketRefused: (reason: Ended, unsent: string) => void;
	probePath: string;
}) {
	const { demo } = useWorkspace();
	// The words last sent, until a reply starts: a socket closing over them means they were refused.
	const sending = useRef("");
	// Read by callbacks that run before the state below reaches a render.
	const closing = useRef(false);
	const [closed, setClosed] = useState<{ refused: boolean } | null>(null);
	const box = useRef<HTMLTextAreaElement>(null);
	const asking = useRef(false);
	const agent = useAgent({
		agent: "ConversationAgent",
		basePath: `api/chat/${encodeURIComponent(slug)}/${conversationId}`,
		onConnectionError: (failure) => {
			if (failure.code !== SESSION_ENDED) return;
			closing.current = true;
			setClosed({ refused: Boolean(sending.current) });
			void onSessionClosed(sending.current);
		},
		onClose: () => void askWhyItDropped(),
	});

	// One question per close, with the library's own wait between tries, while someone's away too: a
	// laptop that slept through its session's end should say so before they write to it.
	async function askWhyItDropped() {
		if (closing.current || asking.current) return;
		asking.current = true;
		const now = await endedForNow(probePath);
		asking.current = false;
		if (closing.current || (now !== "signed-out" && now !== "no-access")) return;
		closing.current = true;
		agent.close();
		setClosed({ refused: Boolean(sending.current) });
		onSocketRefused(now, sending.current);
	}

	// Both run for a turn the socket cut off too. That turn is not over but refused, or still waiting
	// to be, and refreshing the page for it would take someone whose session ended to the sign-in page
	// without what they wrote.
	const turnEnded = () => {
		if (closing.current || agent.readyState !== WebSocket.OPEN) return;
		sending.current = "";
		onTurnEnd();
	};
	const { messages, sendMessage, stop, status, error, clearError, isStreaming, isRecovering } =
		useAgentChat({ agent, onFinish: turnEnded, onError: turnEnded });
	const busy = !closed && (status === "submitted" || isStreaming || isRecovering);
	const end = useRef<HTMLDivElement>(null);
	// The refused words went into the list as soon as they were sent, and are back in the box now.
	const shown =
		closed?.refused && messages.at(-1)?.role === "user" ? messages.slice(0, -1) : messages;

	useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

	useEffect(() => {
		if (status === "streaming") sending.current = "";
	}, [status]);

	// The box is a new one now, and the words that came back are one key press from going.
	useEffect(() => {
		if (notSent) box.current?.focus();
	}, [notSent]);

	// Follow the reply as it grows.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls whenever the messages change.
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [messages]);

	async function send(event?: FormEvent) {
		event?.preventDefault();
		const text = draft.trim();
		if (!text || busy || disabled || closed) return;
		clearError();
		onDraftChange("");
		onSend();
		sending.current = text;
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
				<section aria-label="Messages" className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
					{shown.length === 0 && (
						<p className="py-10 text-center text-sm text-muted-foreground">
							Write to {agentName} below.
						</p>
					)}
					{shown.map((message) => (
						<Message key={message.id} message={message} agentName={agentName} members={members} />
					))}
					{status === "submitted" && !closed && (
						<p className="text-sm text-muted-foreground" aria-live="polite">
							{agentName} is thinking…
						</p>
					)}
					{isRecovering && (
						<p className="text-sm text-muted-foreground" aria-live="polite">
							Picking the reply back up…
						</p>
					)}
					{error && !closed && (
						<p
							role="alert"
							className="whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
						>
							{error.message}
						</p>
					)}
					{notSent && (
						<p role="status" className="text-sm text-muted-foreground">
							Your sign-in changed, so that message was not sent. It is back in the box below.
						</p>
					)}
					{ended === "signed-out" && (
						<p
							role="alert"
							className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
						>
							Your session has ended{closed?.refused ? ", so that message was not sent" : ""}.{" "}
							<Link
								to="/login"
								search={{ redirect: window.location.pathname }}
								className="font-medium underline underline-offset-2"
							>
								Sign in again
							</Link>{" "}
							to go on.
						</p>
					)}
					{ended === "no-access" && (
						<p
							role="alert"
							className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
						>
							You can no longer use this conversation
							{closed?.refused ? ", so that message was not sent" : ""}.{" "}
							<Link to="/" className="font-medium underline underline-offset-2">
								Go to your workspaces
							</Link>
						</p>
					)}
					<div ref={end} />
				</section>
			</div>
			<form onSubmit={send} className="shrink-0 border-t p-3 sm:p-4">
				<div className="mx-auto flex max-w-3xl items-end gap-2">
					<Textarea
						ref={box}
						aria-label={`Message ${agentName}`}
						value={draft}
						onChange={(event) => onDraftChange(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={disabled ? "This conversation cannot go on" : `Message ${agentName}`}
						disabled={disabled}
						// Still there to copy, with nowhere to send it.
						readOnly={ended !== null}
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
							disabled={disabled || Boolean(closed) || !draft.trim()}
							aria-label="Send"
						>
							<ArrowUp />
						</Button>
					)}
				</div>
				{demo && (
					<p className="mx-auto mt-2 max-w-3xl text-xs text-muted-foreground">
						This is the demo: agents answer from a script, and nothing you write reaches a model.
					</p>
				)}
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
							if (edge) return <EdgeCall key={part.toolCallId} {...edge} />;
							const pull = describePullRequestCall(part);
							if (pull) return <PullRequestCall key={part.toolCallId} {...pull} />;
							return <ToolCall key={part.toolCallId} part={part} />;
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

/**
 * A call of `open_pull_request`: the pull request it opened or pushed to, linked, or why there is
 * none, which shows on hover and which the model says too.
 */
function PullRequestCall({
	state,
	pullRequest,
	error,
}: NonNullable<ReturnType<typeof describePullRequestCall>>) {
	const Icon = { running: LoaderCircle, done: GitPullRequestArrow, failed: CircleAlert }[state];
	const label =
		state === "running"
			? "Opening a pull request"
			: state === "failed" || !pullRequest
				? "Could not open a pull request"
				: `${pullRequest.opened ? "Opened" : "Pushed to"} pull request #${pullRequest.number}`;
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
					state === "done" && "text-emerald-700 dark:text-emerald-400",
				)}
			/>
			{pullRequest ? (
				<a
					href={pullRequest.url}
					target="_blank"
					rel="noreferrer"
					className="truncate font-medium text-foreground underline-offset-4 hover:underline"
				>
					{label}
				</a>
			) : (
				<span className="truncate">{label}</span>
			)}
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
