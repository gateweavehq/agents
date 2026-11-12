import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/members/member-avatar";
import { Button } from "#/components/ui/button";
import { getAuditLog, type WorkspaceAudit } from "#/lib/audit";
import type { AuditEvent, AuditPage, AuditPerson } from "#/lib/audit-events";
import { auditActor, auditSentence } from "#/lib/audit-text";
import { formatDateTime, formatRelative } from "#/lib/dates";

export function AuditSettings({ slug, data }: { slug: string; data: WorkspaceAudit }) {
	// Pages are added as they are asked for; the loader's is the first.
	const [pages, setPages] = useState<AuditPage[]>([data.page]);
	const [loading, setLoading] = useState(false);
	const next = pages.at(-1)?.next ?? null;
	const events = pages.flatMap((page) => page.events);
	const people: Record<string, AuditPerson> = Object.assign({}, ...pages.map((p) => p.people));

	async function more() {
		if (next === null) return;
		setLoading(true);
		try {
			const result = await getAuditLog({ data: { slug, before: next } });
			if (!result?.admin) {
				toast.error("Could not load more", { description: "Only admins can read the audit log." });
				return;
			}
			setPages((loaded) => [...loaded, result.page]);
		} catch {
			toast.error("Could not load more", { description: "Try again in a moment." });
		} finally {
			setLoading(false);
		}
	}

	return (
		<section aria-labelledby="audit-heading" className="space-y-4">
			<div className="space-y-1">
				<h2 id="audit-heading" className="text-base font-semibold">
					Audit log
				</h2>
				<p className="text-sm text-muted-foreground">
					Who changed the workspace, and when: its people and invitations, its keys and secrets, its
					connections, its agents, teams and setups, and what was deleted. Never a key's or a
					secret's value. Kept for a year.
				</p>
			</div>
			{!data.admin ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					Only admins can read the audit log.
				</p>
			) : events.length === 0 ? (
				<p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
					Nothing yet. Changes appear here as they are made.
				</p>
			) : (
				<>
					<ol className="divide-y rounded-lg border" aria-label="Audit log">
						{events.map((event) => (
							<AuditRow key={event.id} event={event} people={people} />
						))}
					</ol>
					{next !== null && (
						<div className="flex justify-center">
							<Button variant="outline" onClick={more} disabled={loading}>
								{loading ? "Loading…" : "Load more"}
							</Button>
						</div>
					)}
				</>
			)}
		</section>
	);
}

function AuditRow({ event, people }: { event: AuditEvent; people: Record<string, AuditPerson> }) {
	const actor = event.actorId === null ? undefined : people[event.actorId];
	return (
		<li className="flex items-start gap-3 px-4 py-3 text-sm">
			<MemberAvatar className="mt-0.5" member={actor} />
			<p className="min-w-0 flex-1 break-words">
				<span className="font-medium">{auditActor(event, people)}</span>{" "}
				{auditSentence(event, people)}
			</p>
			<time
				className="shrink-0 text-xs text-muted-foreground"
				dateTime={new Date(event.at).toISOString()}
				title={formatDateTime(event.at)}
			>
				{formatRelative(event.at)}
			</time>
		</li>
	);
}
