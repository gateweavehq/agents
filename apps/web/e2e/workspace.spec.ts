import { expect, newBrowserContext, test } from "./fixtures";
import {
	addAgent,
	messages,
	newPerson,
	openChat,
	signUp,
	startWorkspace,
	waitForHydration,
} from "./helpers";

// What every page's policy could break without any other suite noticing: `nothingRefused` in
// fixtures.ts fails any of these if a page was refused something.

test("someone starts a workspace, adds an agent and talks to it", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await addAgent(page, slug);

	const box = await openChat(page, slug);
	const words = "These words go over the socket";
	await box.fill(words);
	await page.getByRole("button", { name: "Send" }).click();
	await expect(messages(page).getByText(words)).toBeVisible();
	// However the made-up key's turn ended, it ended, and the box takes words again.
	await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

	await page.reload();
	await expect(messages(page).getByText(words)).toBeVisible();
});

test("the other pages of a workspace load", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	const pages: [string, string][] = [
		["agents", "Agents"],
		["teams", "Teams"],
		["chat", "Chat"],
		["settings/models", "Workers AI"],
		["settings/members", "Members"],
	];
	for (const [path, heading] of pages) {
		await page.goto(`/${slug}/${path}`);
		await waitForHydration(page);
		await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
	}
});

test("someone joins by an invitation", async ({ page, browser }) => {
	const { name, slug } = await startWorkspace(page);
	await page.goto(`/${slug}/settings/members`);
	await waitForHydration(page);
	const guest = newPerson("guest");
	await page.getByLabel("Email address").fill(guest.email);
	await page.getByRole("button", { name: "Create invite link" }).click();
	const link = await page
		.locator('div[aria-live="polite"]')
		.filter({ hasText: guest.email })
		.locator("input, a, code")
		.first();
	const shown = (await link.getAttribute("value")) ?? (await link.getAttribute("href")) ?? "";
	const invitation = shown || ((await link.textContent()) ?? "");
	expect(invitation).toContain("/invite/");

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		await signUp(guestPage, guest);
		await guestPage.goto(invitation);
		await guestPage.getByRole("button", { name: `Join ${name}` }).click();
		await expect(guestPage).toHaveURL(new RegExp(`/${slug}(/|$)`));
	} finally {
		await guestContext.close();
	}
});
