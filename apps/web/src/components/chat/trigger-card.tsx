import { CalendarClock, ChevronRight, Webhook } from "lucide-react";
import { useMemo } from "react";
import { formatDateTime } from "#/lib/dates";
import { describeEvent, prettyEvent, type TriggerMessage } from "#/lib/trigger-message";
import { Markdown } from "./markdown";

/**
 * A trigger's message as the event it is: where it came from and what happened in words, the
 * issue it is about as a link, who did it and when. The event as it was sent waits in a closed
 * disclosure. The model got the prompt and the event as text; this is how people read them.
 */
export function TriggerCard({
	message,
	triggerName,
}: {
	message: TriggerMessage;
	triggerName: string | null;
}) {
	const view = useMemo(() => describeEvent(message.body, triggerName), [message.body, triggerName]);
	const json = useMemo(() => prettyEvent(message.body), [message.body]);
	const Icon = view.source === "schedule" ? CalendarClock : Webhook;
	const issueText = view.issue ? [view.issue.key, view.issue.title].filter(Boolean).join(" ") : "";

	return (
		<div className="w-full min-w-0 max-w-full rounded-lg border bg-muted/30 p-3 text-sm">
			<p className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
				<Icon aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="min-w-0 [overflow-wrap:anywhere]">{view.title}</span>
				{view.source === "other" && view.type && (
					<span className="min-w-0 font-mono font-normal [overflow-wrap:anywhere]">
						{view.type}
					</span>
				)}
			</p>
			{issueText &&
				(view.issue?.url ? (
					<a
						href={view.issue.url}
						target="_blank"
						rel="noreferrer noopener"
						className="mt-1.5 block font-medium [overflow-wrap:anywhere] underline underline-offset-2 hover:opacity-80"
					>
						{issueText}
					</a>
				) : (
					<p className="mt-1.5 font-medium [overflow-wrap:anywhere]">{issueText}</p>
				))}
			{(view.actor || view.at !== null) && (
				<p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
					{view.actor && `By ${view.actor}`}
					{view.actor && view.at !== null && " · "}
					{view.at !== null && (
						<time dateTime={new Date(view.at).toISOString()} suppressHydrationWarning>
							{formatDateTime(view.at)}
						</time>
					)}
				</p>
			)}
			{view.source !== "track" && message.prompt.trim() && (
				// A prompt of the owner's own words is all that says what this run is for.
				<div className="mt-2 text-sm leading-relaxed">
					<Markdown>{message.prompt.trim()}</Markdown>
				</div>
			)}
			<details className="group/event mt-2">
				<summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
					<ChevronRight aria-hidden="true" className="size-3.5 group-open/event:rotate-90" />
					The event as sent
				</summary>
				<pre className="mt-2 max-h-96 max-w-full overflow-auto rounded-lg border bg-background p-3 font-mono text-xs leading-normal">
					<code>{json}</code>
				</pre>
			</details>
		</div>
	);
}

/**
 * A trigger's message that is not in the usual shape, such as a prompt with no event after it: read
 * as Markdown, so a fence is a code block and nothing runs past its container.
 */
export function TriggerText({ text }: { text: string }) {
	return (
		<div className="w-full min-w-0 max-w-full rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">
			<Markdown>{text}</Markdown>
		</div>
	);
}
