import { createFileRoute } from "@tanstack/react-router";
import { finishVerify } from "#/server/github/flow";

// The app's "Callback URL" on GitHub.
export const Route = createFileRoute("/api/github/callback")({
	server: { handlers: { GET: ({ request }) => finishVerify(request) } },
});
