import { expect, test } from "./fixtures";
import { startWorkspace, waitForHydration } from "./helpers";

test("a new library asset requires an explicit kind and explains each choice", async ({ page }) => {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/library`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "New", exact: true }).click();
	const dialog = page.getByRole("dialog");
	const create = dialog.getByRole("button", { name: "Create", exact: true });

	await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
	await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);
	await expect(dialog.getByRole("textbox", { name: "Text", exact: true })).toHaveCount(0);
	await expect(create).toBeDisabled();
	await expect(
		dialog.getByText("What an agent always reads, such as AGENTS.md, CLAUDE.md or rules."),
	).toBeVisible();
	await expect(dialog.getByText("A prompt or slash command an agent can use.")).toBeVisible();
	await expect(
		dialog.getByText("Steps for a specific task. Cannot be pinned as agent instructions."),
	).toBeVisible();

	for (const kind of ["Instructions", "Prompt", "Skill"]) {
		await dialog.getByRole("radio", { name: new RegExp(`^${kind}`) }).check();
		await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
		await expect(dialog.getByRole("textbox", { name: "Text", exact: true })).toBeVisible();
	}
	await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Sample skill");
	await dialog.getByRole("textbox", { name: "Text", exact: true }).fill("# Sample\n");
	await expect(create).toBeEnabled();
	await create.click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/assets/[^/]+`));
});
