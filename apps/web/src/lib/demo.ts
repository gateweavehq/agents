import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * Opens a private sandbox for the visitor and signs them in, on the public demo only: anywhere
 * else it fails before creating anything. Returns the workspace slug.
 */
export const startDemo = createServerFn({ method: "POST" }).handler(async () => {
	const { DemoError } = await import("#/server/demo/mode");
	const { startDemoSandbox } = await import("#/server/demo/start");
	try {
		return await startDemoSandbox(getRequestHeaders());
	} catch (error) {
		// Anyone can press the button, so they read only what was written for them, not a query or a
		// stack's worth of how the server works.
		if (error instanceof DemoError) throw error;
		console.error("demo: could not open a sandbox", error);
		throw new Error("Could not open the demo. Try again in a moment.");
	}
});

/**
 * On the public demo, the slug of the signed-in visitor's sandbox, which is their home page, or null
 * once they have deleted it. Null anywhere else.
 */
export const getDemoHome = createServerFn({ method: "GET" }).handler(async () => {
	const { demoEnabled } = await import("#/server/demo/mode");
	if (!demoEnabled()) return null;
	const { demoHome } = await import("#/server/demo/home");
	return { slug: await demoHome(getRequestHeaders()) };
});
