import { createFileRoute } from "@tanstack/react-router";

// Where Gateweave Track sends the browser back to once the person has approved or refused.
export const Route = createFileRoute("/api/track/connected")({
	server: {
		handlers: {
			GET: async ({ request }) => (await import("#/server/track-connect")).finishConnect(request),
		},
	},
});
