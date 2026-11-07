import type { BrowserContext, Page, WebSocketRoute } from "@playwright/test";
import { expect, newBrowserContext, test } from "./fixtures";
import {
	addAgent,
	messages,
	newPerson,
	openChat,
	signUp,
	startWorkspace,
	waitForHydration,
	waitForTurnEnd,
} from "./helpers";

// A chat socket keeps the session it opened with, and the agent takes nothing more from it once
// that session ends. What the Worker refuses is in test/chat.test.ts; these show what someone sees.

const NEW_PASSWORD = "a-new-correct-horse";

async function changePassword(page: Page, current: string): Promise<void> {
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
	// A new socket first asks whether a turn was left running, and until it hears Enter does nothing,
	// as it does while a turn runs. Pressing again sends nothing twice: the box is empty by then.
	await expect(async () => {
		await page.keyboard.press("Enter");
		await expect(messages(page).getByText(after)).toBeVisible({ timeout: 500 });
	}).toPass({ timeout: 10_000 });
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

test("a chat left open after its person is removed says so and keeps the words", async ({
	page,
	browser,
}) => {
	const { name, slug } = await startWorkspace(page);
	await addAgent(page, slug);
	await page.goto(`/${slug}/settings/members`);
	await waitForHydration(page);
	const guest = newPerson("guest");
	await page.getByLabel("Email address").fill(guest.email);
	await page.getByRole("button", { name: "Create invite link" }).click();
	const invitation = await page.getByLabel("Invite link").first().inputValue();
	expect(invitation).toContain("/invite/");

	const guestContext = await newBrowserContext(browser);
	try {
		const guestPage = await guestContext.newPage();
		await signUp(guestPage, guest);
		await guestPage.goto(invitation);
		await guestPage.getByRole("button", { name: `Join ${name}` }).click();
		await expect(guestPage).toHaveURL(new RegExp(`/${slug}(/|$)`));
		const box = await openChat(guestPage, slug);
		await box.fill("Written while a member");
		await guestPage.getByRole("button", { name: "Send" }).click();
		await expect(messages(guestPage).getByText("Written while a member")).toBeVisible();
		await waitForTurnEnd(guestPage);

		await page.reload();
		await waitForHydration(page);
		await page.getByRole("button", { name: `More for ${guest.name}` }).click();
		await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
		await page.getByRole("button", { name: "Remove", exact: true }).click();
		await expect(page.getByText(`${guest.name} was removed`)).toBeVisible();

		const after = "Written after being removed";
		await box.fill(after);
		await guestPage.getByRole("button", { name: "Send" }).click();

		await expect(
			guestPage.getByRole("alert").filter({ hasText: "You can no longer use this conversation" }),
		).toBeVisible();
		await expect(guestPage.getByText("WebSocket closed")).toHaveCount(0);
		await expect(box).toHaveValue(after);
		await expect(messages(guestPage).getByText(after)).toHaveCount(0);
		await expect(guestPage.getByRole("button", { name: "Send" })).toBeDisabled();
		await expect(guestPage.getByRole("link", { name: "Go to your workspaces" })).toBeVisible();
	} finally {
		await guestContext.close();
	}
});

/** Lets a test drop this browser's chat sockets, as a lost connection or a sleeping laptop would. */
async function droppableSockets(context: BrowserContext): Promise<Set<WebSocketRoute>> {
	const sockets = new Set<WebSocketRoute>();
	await context.routeWebSocket(/\/api\/chat\//, (socket) => {
		sockets.add(socket);
		socket.connectToServer();
		socket.onClose(() => sockets.delete(socket));
	});
	return sockets;
}

test("a chat whose socket dropped while its session ended says so, without being asked", async ({
	page,
	context,
	browser,
}) => {
	const sockets = await droppableSockets(context);
	const { person, slug } = await startWorkspace(page);
	await addAgent(page, slug);
	const box = await openChat(page, slug);
	await box.fill("Written before the change");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(messages(page).getByText("Written before the change")).toBeVisible();
	await waitForTurnEnd(page);

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

	await Promise.all([...sockets].map((socket) => socket.close()));

	await expect(page.getByRole("alert").filter({ hasText: "Your session has ended" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();
	await expect(messages(page).getByText("Written before the change")).toBeVisible();
});

test("a chat whose socket dropped with nothing wrong goes on by itself", async ({
	page,
	context,
}) => {
	const sockets = await droppableSockets(context);
	const { slug } = await startWorkspace(page);
	await addAgent(page, slug);
	const box = await openChat(page, slug);
	await box.fill("Written before the drop");
	await page.getByRole("button", { name: "Send" }).click();
	await expect(messages(page).getByText("Written before the drop")).toBeVisible();
	await waitForTurnEnd(page);

	await Promise.all([...sockets].map((socket) => socket.close()));
	await expect.poll(() => sockets.size).toBeGreaterThan(0);

	const after = "Written after the drop";
	await box.fill(after);
	await page.getByRole("button", { name: "Send" }).click();
	await expect(messages(page).getByText(after)).toBeVisible();
	await waitForTurnEnd(page);
	await expect(page.getByRole("alert").filter({ hasText: "no longer" })).toHaveCount(0);
	await expect(page.getByRole("alert").filter({ hasText: "session has ended" })).toHaveCount(0);
	await page.reload();
	await expect(messages(page).getByText(after)).toBeVisible();
});
