import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A GitHub App key made for each run of the tests, so that the runtime can sign the requests that
// open pull requests. GitHub itself is a spy on fetch.
const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./test/wrangler.jsonc" },
			miniflare: { bindings: { GITHUB_APP_PRIVATE_KEY: privateKey } },
		}),
	],
	test: {
		// The first test to reach a Durable Object waits while Vite loads its code, which takes
		// several seconds on a cold start.
		testTimeout: 20_000,
		// With the file system cache, Vitest hands each test file's worker every module it has
		// cached in one message, and the Cloudflare pool inlines their code into it, once per
		// alias. For this package's graph that came to over 32 MiB in CI, more than workerd
		// accepts in one WebSocket message, and the worker died. Without it, modules arrive one
		// at a time, the largest about 3 MB.
		fsModuleCache: false,
	},
});
