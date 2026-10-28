import { createFileRoute } from "@tanstack/react-router";
import { startInstall } from "#/server/github/flow";

export const Route = createFileRoute("/api/github/install")({
	server: { handlers: { GET: ({ request }) => startInstall(request) } },
});
