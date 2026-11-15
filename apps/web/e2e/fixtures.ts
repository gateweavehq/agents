import { type Browser, type BrowserContext, test as base, expect } from "@playwright/test";

/**
 * Better Auth limits sign-ups and sign-ins to a few per 10 seconds per client address, and
 * identifies the client by Cloudflare's `cf-connecting-ip` header. Every request in a local run
 * comes from one address, so tests that sign up in parallel would be throttled (429). Each
 * browser context therefore presents itself as a different client, as real people would.
 */
function clientHeaders(): Record<string, string> {
	const octet = () => Math.floor(Math.random() * 256);
	return { "cf-connecting-ip": `10.${octet()}.${octet()}.${1 + (octet() % 254)}` };
}

/**
 * What React throws when the browser's first render does not match the server's HTML: the errors
 * 418 to 425 of a production build, which names them only by number, or their words in another.
 */
const HYDRATION_ERROR = /Minified React error #(418|419|421|422|423|425)\b|hydrat/i;

export const test = base.extend<{ nothingRefused: undefined; everyPageHydrated: undefined }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the pattern to see that no fixture is used
	extraHTTPHeaders: async ({}, use) => {
		await use(clientHeaders());
	},
	// A script a page's policy blocks leaves a page that can look right and do nothing, and the Worker
	// tests see the same HTML either way. So in every test here, a refusal is a failure.
	nothingRefused: [
		async ({ context }, use) => {
			const refused: string[] = [];
			context.on("console", (message) => {
				if (message.text().includes("Content Security Policy")) refused.push(message.text());
			});
			await use(undefined);
			expect(refused).toEqual([]);
		},
		{ auto: true },
	],
	// A page whose first render in the browser differs from the server's is thrown away and rendered
	// again. It looks the same afterwards, but a click that lands meanwhile goes to an element that is
	// gone and does nothing, so whether a test passes is left to timing. A mismatch is a failure
	// itself, in every test here.
	everyPageHydrated: [
		async ({ context }, use) => {
			const mismatches: string[] = [];
			context.on("weberror", (webError) => {
				const { message } = webError.error();
				if (HYDRATION_ERROR.test(message)) mismatches.push(`${webError.page()?.url()}: ${message}`);
			});
			await use(undefined);
			expect(mismatches).toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

/** A second, separate browser: its own storage, cookies and client address. */
export function newBrowserContext(browser: Browser): Promise<BrowserContext> {
	return browser.newContext({ extraHTTPHeaders: clientHeaders() });
}
