import { expect, test } from "./fixtures";
import { startWorkspace, waitForHydration } from "./helpers";

test("copies prompt and Markdown asset text for use outside the app", async ({ page, context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const { slug } = await startWorkspace(page);

	for (const { kind, name, content, button } of [
		{
			kind: "prompt",
			name: "Review prompt",
			content: "Review carefully.\n",
			button: /Copy prompt from/,
		},
		{
			kind: "instructions",
			name: "Team rules",
			content: "Be brief.\n",
			button: /Copy Markdown from/,
		},
	]) {
		await page.goto(`/${slug}/library`);
		await waitForHydration(page);
		await page.getByRole("button", { name: "New", exact: true }).click();
		const writing = page.getByRole("dialog");
		await writing.getByRole("radio", { name: new RegExp(`^${kind}`, "i") }).check();
		await writing.getByLabel("Name").fill(name);
		await writing.getByLabel("Text").fill(content);
		await writing.getByRole("button", { name: "Create", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/${slug}/assets/[^/]+`));
		const shownText = await page.locator("figure pre code").textContent();
		expect(shownText?.replaceAll("\r\n", "\n")).toBe(content);
		await page.getByRole("button", { name: button }).click();
		await expect
			.poll(async () =>
				(await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"),
			)
			.toBe(content);
	}
});
