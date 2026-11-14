import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";

/** How a connection to Track ended without making anything, as the callback names it. */
export const trackConnectSearch = z.object({
	trackConnect: z
		.enum(["denied", "failed", "unreadable", "expired", "busy", "unreachable"])
		.optional(),
});

/**
 * Track makes the agent member and its webhook when the person allows, before this server trades
 * the code. When the trade did not go through, they may still be there, and nothing here can
 * take them back: there is no undo token without an answer.
 */
const LEFT_IN_TRACK =
	"Nothing was made here, but Track may still hold the agent member and its webhook from this attempt: remove them in Track under Settings, Agents and Settings, Webhooks, then try again.";

const WORDS = {
	denied: "Nothing was made: you did not allow it in Track.",
	failed: "Track could not be connected. Nothing was made.",
	unreadable: `Track's answer could not be read. ${LEFT_IN_TRACK}`,
	expired: `Track did not accept the approval, perhaps because it took too long. ${LEFT_IN_TRACK}`,
	busy: `Track asked to wait a little. ${LEFT_IN_TRACK}`,
	unreachable: `Track could not be reached from this server. ${LEFT_IN_TRACK}`,
} as const;

/** Says once why a connection to Track made nothing, then takes the notice out of the address. */
export function useTrackConnectNotice(notice: keyof typeof WORDS | undefined) {
	const navigate = useNavigate();
	useEffect(() => {
		if (!notice) return;
		toast.message(WORDS[notice], { duration: 30_000 });
		void navigate({ to: ".", search: {}, replace: true });
	}, [notice, navigate]);
}

/** What the callback sends the agent's page: what was connected, and Track's names for it. */
export const trackConnectedSearch = z.object({
	trackConnected: z.enum(["work", "triage"]).optional(),
	workspaceName: z.string().max(200).optional(),
	workspaceSlug: z.string().max(100).optional(),
	agentName: z.string().max(200).optional(),
});

/**
 * Says once that Track is connected, with a link to the workspace there. The link goes to the
 * address of the Track the agent's own MCP server names, never to one the page's address gives:
 * an address anyone can write is not a place to send people from here.
 */
export function useTrackConnectedNotice(
	search: z.infer<typeof trackConnectedSearch>,
	trackUrl: string | null,
) {
	const navigate = useNavigate();
	const { trackConnected, workspaceName, workspaceSlug, agentName } = search;
	useEffect(() => {
		if (!trackConnected || !workspaceName) return;
		let host = "Track";
		let link: string | null = null;
		try {
			if (trackUrl) {
				const origin = new URL(trackUrl);
				host = origin.host;
				if (workspaceSlug) link = `${origin.origin}/${encodeURIComponent(workspaceSlug)}`;
			}
		} catch {}
		const next =
			trackConnected === "work"
				? `Assign an issue to ${agentName ?? "it"} in Track.`
				: `New issues in ${workspaceName} will be triaged.`;
		const open = link;
		toast.success(`Connected to ${workspaceName} on ${host}. ${next}`, {
			duration: 20_000,
			...(open
				? {
						action: { label: "Open Track", onClick: () => window.open(open, "_blank", "noopener") },
					}
				: {}),
		});
		void navigate({ to: ".", search: {}, replace: true });
	}, [trackConnected, workspaceName, workspaceSlug, agentName, trackUrl, navigate]);
}
