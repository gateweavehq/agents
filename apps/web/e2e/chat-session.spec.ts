import { expect, newBrowserContext, test } from "./fixtures";
import {
	addAgent,
	messages,
	openChat,
	startWorkspace,
	waitForHydration,
	waitForTurnEnd,
} from "./helpers";

// A chat socket keeps the session it opened with, and the agent takes nothing more from it once
// that session ends. What the Worker refuses is in test/chat.test.ts; these show what someone sees.

const NEW_PASSWORD = "a-new-correct-horse";

async function changePassword(
	page: import("@playwright/test").Page,
	current: string,
): Promise<void> {
	await page.goto("/settings/account");
	await waitForHydration(page);
	await page.getByRole("button", { name: "Change password" }).click();
	await page.getByLabel("Current password").fill(current);
	await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
	await page.getByLabel("New password again").fill(NEW_PASSWORD);
	await page.getByRole("button", { name: "Save password" }).click();
	await expect(page.getByText("Your password is changed")).toBeVisible();
}

test("a chat left open gives the words back and goes on, in the browser that changed the password", async ({
	page,
	context,
}) => {
	const { person, slug } = await startWorkspace(page);
	await addAgent(page, slug);
	const box = await openChat(page, slug);
	const before = "Written before the change";
	await box.fill(before);
	await page.getByRole("button", { name: "Send" }).click();
	await expect(messages(page).getByText(before)).toBeVisible();
	await waitForTurnEnd(page);

	const account = await context.newPage();
	await changePassword(account, person.password);
	await account.close();

	const after = "Written after the change";
	await box.fill(after);
	await page.getByRole("button", { name: "Send" }).click();

	// It did not reach the agent, and this says so rather than losing it.
	const again = page.getByLabel("Message Check agent");
	await expect(again).toHaveValue(after);
	await expect(page.getByRole("status").filter({ hasText: "was not sent" })).toBeVisible();
	await expect(page.getByText("WebSocket closed")).toHaveCount(0);
	await expect(messages(page).getByText(after)).toHaveCount(0);
	await expect(messages(page).getByText(before)).toBeVisible();

	// The new socket takes it, from the keyboard since the box has the focus again.
	await expect(again).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(messages(page).getByText(after)).toBeVisible();
	await expect(page.getByRole("status").filter({ hasText: "was not sent" })).toHaveCount(0);
	await waitForTurnEnd(page);
	await page.reload();
	await expect(messages(page).getByText(after)).toBeVisible();
	await expect(messages(page).getByText(before)).toBeVisible();
});

test("a chat whose session ended elsewhere says so, keeps the words and offers to sign in", async ({
	page,
	browser,
}) => {
	const { person, slug } = await startWorkspace(page);
	await addAgent(page, slug);
	const box = await openChat(page, slug);
	const before = "Written before the change";
	await box.fill(before);
	await page.getByRole("button", { name: "Send" }).click();
	await expect(messages(page).getByText(before)).toBeVisible();
	await waitForTurnEnd(page);
	const chat = page.url();

	const elsewhereContext = await newBrowserContext(browser);
	try {
		const elsewhere = await elsewhereContext.newPage();
		await elsewhere.goto("/login");
		await waitForHydration(elsewhere);
		await elsewhere.getByLabel("Email").fill(person.email);
		await elsewhere.getByLabel("Password").fill(person.password);
		await elsewhere.getByRole("button", { name: "Sign in", exact: true }).click();
		await expect(elsewhere).not.toHaveURL(/\/login/);
		await changePassword(elsewhere, person.password);
	} finally {
		await elsewhereContext.close();
	}

	const after = "Written after the session ended";
	await box.fill(after);
	await page.getByRole("button", { name: "Send" }).click();

	await expect(page.getByRole("alert").filter({ hasText: "Your session has ended" })).toBeVisible();
	await expect(page.getByText("WebSocket closed")).toHaveCount(0);
	await expect(box).toHaveValue(after);
	await expect(messages(page).getByText(after)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

	await page.getByRole("link", { name: "Sign in again" }).click();
	await expect(page).toHaveURL(/\/login/);
	await waitForHydration(page);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(NEW_PASSWORD);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).toHaveURL(chat);
	await expect(messages(page).getByText(before)).toBeVisible();
});
