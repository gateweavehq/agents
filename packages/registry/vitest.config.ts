import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
	test: {
		// The first test to reach the Durable Object waits while Vite loads its code, which takes
		// about five seconds on a cold start.
		testTimeout: 20_000,
	},
});
