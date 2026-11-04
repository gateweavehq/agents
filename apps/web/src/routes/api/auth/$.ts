import { createFileRoute } from "@tanstack/react-router";
import { getAuth, postToAuth } from "#/server/auth";

export const Route = createFileRoute("/api/auth/$")({
	server: {
		handlers: {
			GET: ({ request }) => getAuth().handler(request),
			POST: ({ request }) => postToAuth(request),
		},
	},
});
