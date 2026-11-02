import { createFileRoute } from "@tanstack/react-router";
import { receiveGitLabWebhook } from "#/server/gitlab";

// A GitLab connection's push webhook, which an admin adds in GitLab with its secret token.
export const Route = createFileRoute("/api/gitlab/webhooks/$workspaceId/$connectionId")({
	server: {
		handlers: {
			POST: ({ request, params }) =>
				receiveGitLabWebhook(request, params.workspaceId, params.connectionId),
		},
	},
});
