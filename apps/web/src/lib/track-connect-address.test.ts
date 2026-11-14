import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { challengeOf, trackConnectAddress } from "./track-connect-address";

const options = {
	trackUrl: "https://track.example.com",
	purpose: "work" as const,
	name: "Coder",
	origin: "https://agents.example.com",
	workspaceId: "ws1",
	triggerId: "tr1",
	state: "ws1.abc",
	verifier: "v".repeat(64),
};

describe("the address Track is sent to", () => {
	it("puts the webhook and the return address on one origin, the app's", async () => {
		const url = new URL(await trackConnectAddress(options));
		expect(url.origin).toBe("https://track.example.com");
		expect(url.pathname).toBe("/connect/agent");
		const webhook = new URL(url.searchParams.get("webhook") ?? "");
		const back = new URL(url.searchParams.get("return") ?? "");
		expect(webhook.origin).toBe("https://agents.example.com");
		expect(back.origin).toBe(webhook.origin);
		expect(webhook.pathname).toBe("/api/triggers/ws1/tr1");
		expect(back.pathname).toBe("/api/track/connected");
		expect(url.searchParams.get("state")).toBe("ws1.abc");
		expect(url.searchParams.get("name")).toBe("Coder");
		expect(url.searchParams.get("purpose")).toBe("work");
	});

	it("sends the SHA-256 of the verifier, never the verifier", async () => {
		const address = await trackConnectAddress(options);
		const challenge = new URL(address).searchParams.get("challenge");
		expect(challenge).toBe(createHash("sha256").update(options.verifier).digest("base64url"));
		expect(address).not.toContain(options.verifier);
		expect(await challengeOf(options.verifier)).toBe(challenge);
	});

	it("asks for the events of what is connected", async () => {
		const events = async (purpose: "work" | "triage") =>
			new URL(await trackConnectAddress({ ...options, purpose })).searchParams.get("events");
		expect(await events("work")).toBe("issue.created,issue.updated,comment.created");
		expect(await events("triage")).toBe("issue.created");
	});

	it("keeps a Track at a path to its origin, and escapes what is in the query", async () => {
		const url = new URL(
			await trackConnectAddress({
				...options,
				trackUrl: "https://track.example.com",
				name: "A&B=c",
			}),
		);
		expect(url.searchParams.get("name")).toBe("A&B=c");
	});
});
