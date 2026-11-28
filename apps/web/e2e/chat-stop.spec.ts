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
 * The line a turn shows while nothing of its reply has come: its progress label when it has one,
 * "is thinking…" when it has none. This agent's silent MCP server keeps it at "Connecting tools".
 */
const WAITING = /is thinking…|Connecting tools/;

/**
 * Holds back what the conversation answers when a new socket asks whether a turn was left running,
 * until `release`: a conversation that is slow to wake answers after someone has already written.
 */
async function holdFirstAnswer(context: BrowserContext) {
	const held: (() => void)[] = [];
	let holding = true;
	// The page counts the answers its sockets have handed to every listener, so a test can tell that
	// the chat has heard one. The count goes up in a task of its own, after the listeners have run.
	await context.addInitScript(() => {
		const counts = window as unknown as { answersHeard?: number };
		counts.answersHeard = 0;
		const Socket = window.WebSocket;
		window.WebSocket = class extends Socket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("message", (event) => {
					if (typeof event.data !== "string") return;
					if (!event.data.includes("cf_agent_stream_resume_none")) return;
					setTimeout(() => {
						counts.answersHeard = (counts.answersHeard ?? 0) + 1;
					}, 0);
				});
			}
		};
	});
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
		/** Lets the answers through, and waits until the page has heard them and drawn what follows. */
		release: async (page: Page) => {
			holding = false;
			const passed = held.splice(0);
			for (const pass of passed) pass();
			await page.waitForFunction(
				(count) => ((window as unknown as { answersHeard?: number }).answersHeard ?? 0) >= count,
				passed.length,
			);
			// Whatever the chat made of them is on the page once its hook has passed its state on,
			// which it holds back for 50 ms at most, and the page has drawn a frame after that.
			await page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						setTimeout(
							() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
							100,
						),
					),
			);
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
		await expect(page.getByText(WAITING)).toBeVisible();
		// The turn is waiting for its server, with nothing of its reply sent.
		await expect.poll(server.asked).toBeGreaterThan(0);

		// The socket now hears that no turn was running when it opened. That is about the time
		// before the message, and the turn it started still runs.
		expect(answer.held()).toBeGreaterThan(0);
		await answer.release(page);
		await expect(stop).toBeVisible();
		await expect(stop).toBeEnabled();
		await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
		await expect(page.getByText(WAITING)).toBeVisible();

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
		await expect(page.getByText(WAITING)).toBeVisible();
		await expect(stop).toBeEnabled();

		await stop.click();
		await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 5_000 });
		await expectStoppedRun(page, slug);
	} finally {
		server.close();
	}
});
