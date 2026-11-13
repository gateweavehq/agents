import { defineConfig, devices } from "@playwright/test";

// Smoke tests: `AGENTS_SMOKE_URL=https://agents.example.com pnpm test:smoke`. They check a live
// deployment from outside, right after it is deployed, as a visitor's browser would. Unlike the
// e2e suite, they start no server and build nothing. Gateweave Cloud's deploys run them on the
// public demo (.github/workflows/deploy.yml).
const url = process.env.AGENTS_SMOKE_URL;
if (!url) {
	throw new Error(
		"Set AGENTS_SMOKE_URL to the deployment to check, such as https://agents.example.com",
	);
}

export default defineConfig({
	testDir: "smoke",
	timeout: 90_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	// A live deployment is reached over the internet, and a deploy takes a few seconds to reach
	// every location. A second try tells a blip from a broken release.
	retries: 1,
	reporter: "list",
	outputDir: "test-results-smoke",
	use: {
		baseURL: new URL(url).origin,
		trace: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
