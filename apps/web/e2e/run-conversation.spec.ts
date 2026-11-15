import { createHmac, randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
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

interface Trigger {
	path: string;
	secret: string;
}

/** Gives the agent a trigger, and reads the address and the secret it shows once. */
async function addTrigger(page: Page, slug: string): Promise<Trigger> {
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
	return { path: url.pathname, secret };
}

/** Sends the event to a trigger, signed as a Standard Webhooks sender signs, which starts a run. */
async function deliver(request: APIRequestContext, trigger: Trigger): Promise<void> {
	const id = randomUUID();
	const timestamp = String(Math.floor(Date.now() / 1000));
	const key = Buffer.from(trigger.secret.slice("whsec_".length), "base64");
	const signature = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${EVENT}`)
		.digest("base64");
	const response = await request.post(trigger.path, {
		data: EVENT,
		headers: {
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${signature}`,
		},
	});
	expect(response.status()).toBeLessThan(300);
}

test("a trigger's run shows its event as a card, and nothing in it widens the page", async ({
	page,
	request,
}) => {
	await page.setViewportSize({ width: 360, height: 740 });
	const { slug } = await startWorkspace(page);
	await addAgent(page, slug);

	const trigger = await addTrigger(page, slug);
	await deliver(request, trigger);

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

// A run still going is timed by the clock, which the server and the browser read at different
// moments. When React took that for a broken page it rendered the page again, and a click on a run
// that landed meanwhile opened nothing.
test("the Runs page the server rendered of a run still going is the one the browser keeps", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const { slug } = await startWorkspace(page);
	await addAgent(page, slug);
	const trigger = await addTrigger(page, slug);

	// A run with a made-up key lasts as long as Anthropic takes to refuse it, which is most often
	// longer than the page takes to load. When it is not, the next delivery's run gets its turn.
	let going = false;
	for (let attempt = 0; attempt < 5 && !going; attempt++) {
		await deliver(request, trigger);
		const response = await page.goto(`/${slug}/runs`);
		going = /Running/.test((await response?.text()) ?? "");
	}
	expect(going, "no run was still going when the server rendered the page").toBe(true);
	await waitForHydration(page);

	// The page follows the run to its end, which also leaves time for an error to be reported.
	const runs = page.getByRole("link", { name: /Assigned issues/ });
	await expect(runs.filter({ hasText: "Running" })).toHaveCount(0);
	await expect(runs.filter({ hasText: "Failed" }).first()).toBeVisible();
	expect(errors).toEqual([]);
});
