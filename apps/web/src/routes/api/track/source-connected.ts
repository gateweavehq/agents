import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/track/source-connected")({
	server: {
		handlers: {
			GET: async ({ request }) =>
				(await import("#/server/track-connect")).finishConnect(request, "source"),
		},
	},
});
