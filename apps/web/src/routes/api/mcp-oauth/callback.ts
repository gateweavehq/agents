import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/mcp-oauth/callback")({
	server: {
		handlers: {
			GET: async ({ request }) => (await import("#/server/mcp-oauth")).finishConnect(request),
		},
	},
});
