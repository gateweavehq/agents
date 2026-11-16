import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { addAgent, messages, openChat, startWorkspace, waitForHydration } from "./helpers";

// A turn's reply can take a while to begin: the agent's MCP servers connect first, and a sandbox
// starts. Until then the chat has nothing of the reply to show, and still has to say that the turn
// runs and let someone stop it. What the conversation does with a stop is in the runtime's tests.

const SERVER = "Slow tools";

/**
 * An MCP server that takes requests and never answers, so a turn of an agent that has it waits
 * before its reply begins, for as long as the app waits for a server (ten seconds).
 */
async function silentServer() {
	let asked = 0;
	const server = createServer(() => {
		asked++;
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		asked: () => asked,
		close: () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

/** Opens a conversation with an agent whose only MCP server is the silent one. */
async function openSlowChat(page: Page, url: string) {
	const { slug } = await startWorkspace(page);
	await page.goto(`/${slug}/library`);
	await waitForHydration(page);
	await page.getByRole("button", { name: "New MCP server" }).click();
	const adding = page.getByRole("dialog");
	await adding.getByLabel("Name").fill(SERVER);
	await adding.getByLabel("URL").fill(url);
	await adding.getByRole("button", { name: "Add server" }).click();
	await expect(adding).toBeHidden();
	await addAgent(page, slug, [SERVER]);
	return { slug, box: await openChat(page, slug) };
}

/** The run of the one message sent is listed as stopped: it neither failed nor went on. */
async function expectStoppedRun(page: Page, slug: string) {
	await page.goto(`/${slug}/runs`);
	await expect(page.getByRole("main").getByText("Stopped", { exact: true })).toBeVisible();
	await expect(page.getByRole("main").getByText("Failed", { exact: true })).toHaveCount(0);
}

/**
 * Holds back what the conversation answers when a new socket asks whether a turn was left running,
 * until `release`: a conversation that is slow to wake answers after someone has already written.
 */
async function holdFirstAnswer(context: BrowserContext) {
	const held: (() => void)[] = [];
	let holding = true;
	await context.routeWebSocket(/\/api\/chat\//, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const pass = () => socket.send(message);
			if (holding && String(message).includes("cf_agent_stream_resume_none")) held.push(pass);
			else pass();
		});
	});
	return {
		held: () => held.length,
		release: () => {
			holding = false;
			for (const pass of held.splice(0)) pass();
		},
	};
}

test("a turn shows as running from the moment it is sent, and stops before its reply begins", async ({
	page,
	context,
}) => {
	const server = await silentServer();
	const answer = await holdFirstAnswer(context);
	try {
		const { slug, box } = await openSlowChat(page, server.url);
		await box.fill("Take your time");
		await page.getByRole("button", { name: "Send" }).click();

		const stop = page.getByRole("button", { name: "Stop" });
		await expect(stop).toBeVisible({ timeout: 2_000 });
		await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
		await expect(page.getByText("is thinking…")).toBeVisible();
		// The turn is waiting for its server, with nothing of its reply sent.
		await expect.poll(server.asked).toBeGreaterThan(0);

		// The socket now hears that no turn was running when it opened. That is about the time
		// before the message, and the turn it started still runs.
		expect(answer.held()).toBeGreaterThan(0);
		answer.release();
		await page.waitForTimeout(1_000);
		await expect(stop).toBeVisible();
		await expect(stop).toBeEnabled();
		await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
		await expect(page.getByText("is thinking…")).toBeVisible();

		await stop.click();
		await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 5_000 });
		await expect(messages(page).getByText("Take your time")).toBeVisible();
		await expectStoppedRun(page, slug);
	} finally {
		server.close();
	}
});

test("a page opened while a turn waits to begin shows it as running, and stops it", async ({
	page,
}) => {
	const server = await silentServer();
	try {
		const { slug, box } = await openSlowChat(page, server.url);
		await box.fill("Take your time");
		await page.getByRole("button", { name: "Send" }).click();
		await expect.poll(server.asked).toBeGreaterThan(0);

		// The page that sent it is gone; this one only hears that a turn is pending.
		await page.reload();
		const stop = page.getByRole("button", { name: "Stop" });
		await expect(stop).toBeVisible({ timeout: 5_000 });
		await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
		await expect(page.getByText("is thinking…")).toBeVisible();
		await expect(stop).toBeEnabled();

		await stop.click();
		await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 5_000 });
		await expectStoppedRun(page, slug);
	} finally {
		server.close();
	}
});
