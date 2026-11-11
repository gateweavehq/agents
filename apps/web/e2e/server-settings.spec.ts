import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "./fixtures";
import { signUp, unique, waitForHydration } from "./helpers";

// "This server" on the account page, which only whoever runs the server sees. What the endpoints
// refuse, and the rules for who may make an account, are in test/sign-up-allowlist.test.ts. These
// never close sign-up, because every other test here signs up on the same server.

const root = resolve(import.meta.dirname, "..");
const state = resolve(root, ".wrangler", "e2e-state");

/**
 * Makes this person the server's owner, as only a person with the database could. The running server
 * has the file open, so a write that meets it busy is tried again.
 */
function makeOwner(email: string) {
	const command = `UPDATE deployment SET owner_id = (SELECT id FROM user WHERE email = '${email}') WHERE id = 1`;
	let done: ReturnType<typeof spawnSync> | undefined;
	for (let attempt = 0; attempt < 10; attempt++) {
		done = spawnSync(
			process.execPath,
			[
				resolve(root, "node_modules/wrangler/bin/wrangler.js"),
				...["d1", "execute", "DB", "--local", "--persist-to", state, "--command", command],
			],
			{ cwd: root, encoding: "utf8" },
		);
		if (done.status === 0) return;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 + attempt * 300);
	}
	throw new Error(`Could not make ${email} the owner: ${done?.stderr}`);
}

test("someone who does not run the server is not shown its settings", async ({ page }) => {
	await signUp(page);
	await page.goto("/settings/account");
	await waitForHydration(page);
	await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "This server" })).toHaveCount(0);
});

// One server has one owner, so the tests that make themselves it take turns.
test.describe.configure({ mode: "serial" });

test("whoever runs the server keeps a list of who may make an account", async ({ page }) => {
	const person = await signUp(page);
	makeOwner(person.email);
	await page.goto("/settings/account");
	await waitForHydration(page);

	await expect(page.getByRole("heading", { name: "This server" })).toBeVisible();
	await expect(page.getByRole("radio", { name: /Open/ })).toBeChecked();
	await expect(page.getByRole("button", { name: "Save sign-up" })).toBeDisabled();
	// No provider is set up in these tests, so there is nothing to trust.
	await expect(page.getByLabel(/^Trust /)).toHaveCount(0);

	const ada = `${unique("ada")}@example.test`;
	const domain = `@${unique("corp")}.test`;
	await page.getByLabel("Address or @domain").fill(` ${ada.toUpperCase()} `);
	await page.getByLabel("Note (optional)").fill("from the waitlist");
	await page.getByRole("button", { name: "Add to the list" }).click();
	await expect(page.getByRole("status").filter({ hasText: "is on the list" })).toBeVisible();
	const row = page.getByRole("listitem").filter({ hasText: ada });
	await expect(row).toContainText("from the waitlist");
	await expect(row).toContainText("No account yet.");

	await page.getByLabel("Address or @domain").fill(domain);
	await page.getByRole("button", { name: "Add to the list" }).click();
	await expect(page.getByRole("listitem").filter({ hasText: domain })).toContainText(
		"Nobody at this domain has an account yet.",
	);

	// What is not an address or a domain is refused in words.
	await page.getByLabel("Address or @domain").fill("not an address");
	await page.getByRole("button", { name: "Add to the list" }).click();
	await expect(page.getByRole("alert")).toContainText("Enter an email address");

	// Search, and the count of what matches.
	await page.getByLabel("Search the list").fill("waitlist");
	await expect(page.getByRole("listitem").filter({ hasText: ada })).toBeVisible();
	await expect(page.getByRole("listitem").filter({ hasText: domain })).toHaveCount(0);
	await expect(page.getByText(/^1 of \d+ entries match\.$/)).toBeVisible();
	await page.getByLabel("Search the list").fill("");

	await page.getByRole("button", { name: `Remove ${ada} from the list` }).click();
	await expect(page.getByRole("listitem").filter({ hasText: ada })).toHaveCount(0);
	await page.getByRole("button", { name: `Remove ${domain} from the list` }).click();
	await expect(page.getByRole("listitem").filter({ hasText: domain })).toHaveCount(0);
});

test("the list is usable at the width of a phone", async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	const person = await signUp(page);
	makeOwner(person.email);
	await page.goto("/settings/account");
	await waitForHydration(page);
	await page
		.getByLabel("Address or @domain")
		.fill(`${"long".repeat(12)}@${"example".repeat(5)}.test`);
	await page.getByRole("button", { name: "Add to the list" }).click();
	await expect(page.getByRole("listitem")).toHaveCount(1);
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
	expect(overflow).toBeLessThanOrEqual(0);
});
