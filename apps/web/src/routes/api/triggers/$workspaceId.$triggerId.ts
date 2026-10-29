import { createFileRoute } from "@tanstack/react-router";
import { receiveTrigger } from "#/server/triggers";

// A trigger's URL, which a sender posts its signed webhooks to.
export const Route = createFileRoute("/api/triggers/$workspaceId/$triggerId")({
	server: {
		handlers: {
			POST: ({ request, params }) => receiveTrigger(request, params.workspaceId, params.triggerId),
		},
	},
});
