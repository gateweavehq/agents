import { expect, test } from "@playwright/test";

// The public demo, end to end: a visitor's sandbox is made and filled, and one of its agents
// answers from the script over the chat socket. This is the whole path of a real workspace (D1,
// the registry, a conversation's Durable Object, the WebSocket), and the demo is the one
// deployment where a stranger may go through it. The sandbox is deleted after a day, like every
// visitor's.

test("a visitor opens a demo workspace and chats with one of its agents", async ({ page }) => {
	await page.goto("/login");
	const start = page.getByRole("button", { name: "Open the demo" });
	test.skip(!(await start.isVisible()), "Not the demo: it has no sandbox to open.");

	await expect(start).toBeEnabled();
	await start.click();
	await expect(page).toHaveURL(/\/acme-[a-z0-9]{6}$/);
	await expect(page.getByText("Acme is made up")).toBeVisible();

	await page.getByRole("link", { name: "Repositories" }).click();
	for (const name of ["storefront", "payments-api", "mobile-app"]) {
		await expect(page.getByText(name).first()).toBeVisible();
	}

	await page.getByRole("link", { name: "Chat" }).click();
	await page
		.getByRole("listitem")
		.filter({ hasText: "Code reviewer" })
		.getByRole("button", { name: "Chat" })
		.click();
	await expect(page).toHaveURL(/\/chat\/.+/);
	const box = page.getByLabel("Message Code reviewer");
	await expect(box).toBeEnabled();
	await box.fill("Anything to flag in the last release?");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(
		page.getByRole("region", { name: "Messages" }).getByText("Nothing else to flag."),
	).toBeVisible({ timeout: 30_000 });
});
