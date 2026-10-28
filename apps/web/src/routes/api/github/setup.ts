import { createFileRoute } from "@tanstack/react-router";
import { finishInstall } from "#/server/github/flow";

// The app's "Setup URL" on GitHub.
export const Route = createFileRoute("/api/github/setup")({
	server: { handlers: { GET: ({ request }) => finishInstall(request) } },
});
