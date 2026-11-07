import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";

/** Short and unique per call, so tests never share users or workspaces. */
export function unique(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Person {
	name: string;
	email: string;
	password: string;
}

export function newPerson(label = "user"): Person {
	const id = unique(label);
	return { name: `Test ${id}`, email: `${id}@example.test`, password: "correct-horse-battery" };
}

/**
 * Waits until React has taken over a server-rendered page. Before that, a click on a submit
 * button is a plain form submission that reloads the page and throws away what was typed.
 */
export async function waitForHydration(page: Page): Promise<void> {
	await page.waitForFunction(() => {
		const main = document.querySelector("main");
		return Boolean(main && Object.keys(main).some((key) => key.startsWith("__reactProps")));
	});
}

/**
 * Signs up on the sign-up form of `/login`. Email is off in the test setup, so there is nothing
 * to verify, and the app lands on `/`.
 */
export async function signUp(page: Page, person: Person = newPerson()): Promise<Person> {
	await page.goto("/login?mode=sign-up");
	await waitForHydration(page);
	await page.getByLabel("Name").fill(person.name);
	await page.getByLabel("Email").fill(person.email);
	await page.getByLabel("Password").fill(person.password);
	await page.getByRole("button", { name: "Create account" }).click();
	await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
	return person;
}

/** Creates a workspace from `/` and waits for its first page. */
export async function createWorkspace(page: Page): Promise<{ name: string; slug: string }> {
	const slug = unique("ws");
	const name = `Workspace ${slug}`;
	await page.getByLabel("Name").fill(name);
	await page.getByLabel("URL").fill(slug);
	await page.getByRole("button", { name: "Create workspace" }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}(/|$)`));
	return { name, slug };
}

/** Signs up and creates a workspace: the start of most tests. */
export async function startWorkspace(page: Page) {
	const person = await signUp(page);
	const workspace = await createWorkspace(page);
	return { person, ...workspace };
}

export const AGENT = "Check agent";

/**
 * Saves an Anthropic key and makes an agent that uses it. The key is made up, so a turn gets as far
 * as Anthropic refusing it: what someone wrote is stored by then, which is what these tests read.
 */
export async function addAgent(page: Page, slug: string): Promise<void> {
	await page.goto(`/${slug}/settings/models`);
	await waitForHydration(page);
	const row = page.getByRole("listitem").filter({ hasText: "Anthropic" }).first();
	await row.getByRole("button", { name: "Add key" }).click();
	await page
		.getByLabel("Key", { exact: true })
		.fill(`sk-ant-made-up-${randomBytes(12).toString("hex")}`);
	await page.getByRole("button", { name: "Save key" }).click();
	await expect(row.getByRole("button", { name: "Replace" })).toBeVisible();

	await page.goto(`/${slug}/agents`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "New agent" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill(AGENT);
	await dialog.getByLabel("Provider").selectOption("anthropic");
	await dialog.getByLabel("Model", { exact: true }).fill("claude-sonnet-5-5");
	await dialog.getByRole("button", { name: "Create agent" }).click();
	await expect(dialog).toBeHidden();
}

/** A conversation's messages. A first message is also its title, so the words show elsewhere too. */
export function messages(page: Page) {
	return page.getByRole("region", { name: "Messages" });
}

/** Opens a new conversation with the agent `addAgent` made, and waits until its box takes words. */
export async function openChat(page: Page, slug: string) {
	await page.goto(`/${slug}/chat`);
	await waitForHydration(page);
	await page
		.getByRole("listitem")
		.filter({ hasText: AGENT })
		.getByRole("button", { name: "Chat" })
		.click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/chat/.+`));
	const box = page.getByLabel(`Message ${AGENT}`);
	await expect(box).toBeEnabled();
	return box;
}

/** Waits until a turn has ended, however it ended: the box's button is Stop until then. */
export async function waitForTurnEnd(page: Page): Promise<void> {
	await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
}
