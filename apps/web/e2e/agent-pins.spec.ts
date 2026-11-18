import { expect, test } from "./fixtures";
import { startWorkspace, waitForHydration } from "./helpers";

const AGENT = "Pin agent";
const MODEL = "claude-sonnet-5-5";

test("moving an agent's pin to the newest version leaves its engine and memory as they were", async ({
	page,
}) => {
	const { slug } = await startWorkspace(page);

	// Instructions in the library, at version 1.
	await page.goto(`/${slug}/library`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "New", exact: true }).click();
	const writing = page.getByRole("dialog");
	await writing.getByRole("radio", { name: /^Instructions/ }).check();
	await writing.getByLabel("Name").fill("Rules");
	await writing.getByLabel("Text").fill("Be brief.\n");
	await writing.getByRole("button", { name: "Create", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/assets/[^/]+`));
	const rules = page.url();

	// An agent that pins them, with an engine and memory that are not the defaults.
	await page.goto(`/${slug}/agents`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "New agent" }).first().click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill(AGENT);
	await dialog.getByLabel("Provider").selectOption("anthropic");
	await dialog.getByLabel("Model", { exact: true }).fill(MODEL);
	await dialog.getByLabel("Instructions").selectOption({ label: "Rules (v1)" });
	// Claude Code runs in the sandbox, so choosing it turns the sandbox on.
	await dialog.getByLabel("Engine").selectOption("claude-code");
	await dialog.getByRole("checkbox", { name: /^Memory/ }).check();
	await dialog.getByRole("button", { name: "Create agent" }).click();
	// Creating it opens its page.
	await expect(page).toHaveURL(new RegExp(`/${slug}/agents/[^/]+`));
	await expect(dialog).toBeHidden();
	const agent = page.url();

	const model = page.getByRole("region", { name: "Model", exact: true });
	const memory = page.getByRole("region", { name: "Memory", exact: true });
	const instructions = page.getByRole("region", { name: "Instructions", exact: true });
	const unchanged = async () => {
		await expect(model).toContainText(`Claude Code · ${MODEL}`);
		await expect(memory).toContainText("Memory is on");
	};
	await unchanged();

	// The library moves on to version 2; the agent stays on 1 until someone moves its pin.
	await page.goto(rules);
	await waitForHydration(page);
	await page.getByRole("button", { name: "Edit", exact: true }).click();
	await page.locator("textarea").first().fill("Be brief, and kind.\n");
	await page.getByRole("button", { name: "Save as next version" }).click();
	await expect(page.getByText("Saved as version 2")).toBeVisible();

	await page.goto(agent);
	await waitForHydration(page);
	await expect(instructions).toContainText("v2 is out");
	await expect(instructions).toContainText("Be brief.");
	await instructions.getByRole("button", { name: "Use v2" }).click();
	await expect(page.getByText(`${AGENT} reads v2 of Rules`)).toBeVisible();
	await expect(instructions).toContainText("Be brief, and kind.");
	await expect(instructions).not.toContainText("is out");
	await unchanged();

	// And so it is stored, not only shown.
	await page.reload();
	await expect(instructions).toContainText("Be brief, and kind.");
	await unchanged();
});
