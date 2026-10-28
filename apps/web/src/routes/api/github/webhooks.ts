import { createFileRoute } from "@tanstack/react-router";
import { receiveWebhook } from "#/server/github/flow";

// The app's "Webhook URL" on GitHub.
export const Route = createFileRoute("/api/github/webhooks")({
	server: { handlers: { POST: ({ request }) => receiveWebhook(request) } },
});
