import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "./fixtures";
import { AGENT, addAgent, startWorkspace, waitForHydration } from "./helpers";

// A trigger's run is read on its page, since no person had its conversation. Its first message is
// the delivery's event, which can carry words that no line break lets go of.

const LONG_TOKEN = "x".repeat(5_000);

const EVENT = JSON.stringify({
	type: "issue.created",
	timestamp: new Date().toISOString(),
	data: {
		workspace: { id: "w1", slug: "gateweave" },
		actor: { id: "u1", name: "Maya", type: "person" },
		issue: {
			id: "i1",
			key: "TRK-137",
			title: "Roadmap: list feature flags",
			url: "https://track.example.com/gateweave/issue/TRK-137",
			description: `A \`code\` span and ${LONG_TOKEN}`,
		},
	},
});

test("a trigger's run shows its event as a card, and nothing in it widens the page", async ({
	page,
	request,
}) => {
	await page.setViewportSize({ width: 360, height: 740 });
	const { slug } = await startWorkspace(page);
	await addAgent(page, slug);

	await page.goto(`/${slug}/agents`);
	await waitForHydration(page);
	await page.getByRole("link", { name: AGENT }).first().click();
	await waitForHydration(page);
	await page.getByRole("button", { name: "New trigger" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name").fill("Assigned issues");
	await dialog
		.getByLabel("Prompt")
		.fill('Track sent {{type}} for the issue {{data.issue.key}}, "{{data.issue.title}}".');
	await dialog.getByRole("button", { name: "Create trigger" }).click();
	const url = new URL(await page.getByLabel("URL", { exact: true }).inputValue());
	const secret = await page.getByLabel("Secret", { exact: true }).inputValue();
	await page.getByRole("button", { name: "Done" }).click();

	// Signed as a Standard Webhooks sender signs.
	const id = randomUUID();
	const timestamp = String(Math.floor(Date.now() / 1000));
	const key = Buffer.from(secret.slice("whsec_".length), "base64");
	const signature = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${EVENT}`)
		.digest("base64");
	const response = await request.post(url.pathname, {
		data: EVENT,
		headers: {
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${signature}`,
		},
	});
	expect(response.status()).toBeLessThan(300);

	await expect(async () => {
		await page.goto(`/${slug}/runs`);
		await page
			.getByRole("link", { name: /Assigned issues/ })
			.first()
			.click({ timeout: 1_000 });
	}).toPass({ timeout: 20_000 });
	await waitForHydration(page);

	const conversation = page.getByRole("region", { name: "Conversation" });
	await expect(conversation.getByText("Track: issue created")).toBeVisible();
	await expect(
		conversation.getByRole("link", { name: "TRK-137 Roadmap: list feature flags" }),
	).toHaveAttribute("href", "https://track.example.com/gateweave/issue/TRK-137");
	await expect(conversation.getByText("By Maya")).toBeVisible();

	// The event waits closed, and opens as pretty-printed code that scrolls inside its own box.
	const disclosure = conversation.locator("details");
	await expect(disclosure).not.toHaveAttribute("open", "");
	await disclosure.getByText("The event as sent").click();
	const code = disclosure.locator("pre");
	await expect(code).toContainText('"type": "issue.created"');
	const scrolls = await code.evaluate((pre) => pre.scrollWidth > pre.clientWidth);
	expect(scrolls).toBe(true);

	// The app's shell may hide what runs past the edge, so the page's own width is not enough: the
	// conversation, whose parents let it grow, must not be wider than the room it was given.
	const widths = await conversation.evaluate((section) => ({
		section: [section.scrollWidth, section.clientWidth],
		page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
	}));
	expect(widths.section[0]).toBeLessThanOrEqual(widths.section[1] ?? 0);
	expect(widths.page[0]).toBeLessThanOrEqual(widths.page[1] ?? 0);
});
