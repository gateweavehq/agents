import { describe, expect, it } from "vitest";
import { exchangeCode, readCapped, undoConnection } from "./track-exchange";

const ANSWER = {
	agentKey: `gwt_${"k".repeat(43)}`,
	webhookSecret: `whsec_${btoa("s".repeat(24))}`,
	agent: { id: "u_1", memberId: "m_1", name: "Coder" },
	workspace: { id: "w_1", slug: "acme", name: "Acme" },
	webhook: { id: "h_1" },
	undo: "undo.token",
};

const answering =
	(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
	async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("reading an answer with a cap", () => {
	it("reads what fits and refuses what does not, without reading on", async () => {
		expect(await readCapped(new Response("abc"), 10)).toBe("abc");
		expect(await readCapped(new Response("x".repeat(11)), 10)).toBeNull();
		// A declared length over the cap is refused before a byte is read.
		const declared = new Response("small", { headers: { "content-length": "999999" } });
		expect(await readCapped(declared, 100)).toBeNull();
		// A body that goes on, whatever it declares.
		let pulled = 0;
		const endless = new Response(
			new ReadableStream({
				pull(controller) {
					pulled++;
					controller.enqueue(new Uint8Array(1024));
				},
			}),
		);
		expect(await readCapped(endless, 4096)).toBeNull();
		expect(pulled).toBeLessThan(20);
	});
});

describe("the exchange", () => {
	it("returns Track's answer once it checks out", async () => {
		const result = await exchangeCode(
			"https://track.test",
			"c".repeat(43),
			"v".repeat(64),
			answering(200, ANSWER),
		);
		expect(result).toMatchObject({
			ok: true,
			answer: { agent: { id: "u_1" }, undo: "undo.token" },
		});
	});

	it("sends the code and the verifier to Track's exchange alone, following no redirect", async () => {
		const seen: { url: string; init?: RequestInit }[] = [];
		const fetcher: typeof fetch = async (url, init) => {
			seen.push({ url: String(url), init });
			return new Response(JSON.stringify(ANSWER));
		};
		await exchangeCode("https://track.test", "code", "verifier", fetcher);
		expect(seen[0]?.url).toBe("https://track.test/api/connect/exchange");
		expect(seen[0]?.init?.redirect).toBe("manual");
		expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ code: "code", verifier: "verifier" });
	});

	it.each([
		["a wrong code", 400, { error: "invalid_code" }, "refused"],
		["too many tries", 429, { error: "too_many_requests" }, "busy"],
		["a redirect", 302, "", "unexpected"],
		["a server error", 500, { error: "oops" }, "unexpected"],
		["an answer that is not JSON", 200, "<html>", "unexpected"],
	])("names %s", async (_name, status, body, why) => {
		expect(
			await exchangeCode("https://track.test", "c", "v", answering(status, body)),
		).toMatchObject({
			ok: false,
			why,
		});
	});

	it("does not use an answer in the wrong shape, and keeps its undo token", async () => {
		const bad = { ...ANSWER, agentKey: "sk-ant-api03-wrong" };
		expect(await exchangeCode("https://track.test", "c", "v", answering(200, bad))).toEqual({
			ok: false,
			why: "unexpected",
			undo: "undo.token",
		});
		const { undo: _gone, ...without } = ANSWER;
		expect(await exchangeCode("https://track.test", "c", "v", answering(200, without))).toEqual({
			ok: false,
			why: "unexpected",
		});
	});

	it("does not read an oversized answer, nor reveal it", async () => {
		const huge = JSON.stringify({ ...ANSWER, padding: "x".repeat(40_000) });
		const result = await exchangeCode("https://track.test", "c", "v", answering(200, huge));
		expect(result).toEqual({ ok: false, why: "unexpected" });
		expect(JSON.stringify(result)).not.toContain(ANSWER.agentKey);
	});

	it("says unreachable when Track does not answer", async () => {
		const fetcher: typeof fetch = async () => {
			throw new Error("down");
		};
		expect(await exchangeCode("https://track.test", "c", "v", fetcher)).toEqual({
			ok: false,
			why: "unreachable",
		});
	});
});

describe("the undo", () => {
	const noWait = async () => {};

	it("is done on Track's word", async () => {
		expect(
			await undoConnection("https://track.test", "u", {
				fetcher: answering(200, { ok: true }),
				wait: noWait,
			}),
		).toBe(true);
	});

	it("is tried again, three times in all, while Track says to try again", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			return calls < 3
				? new Response('{"error":"try_again"}', { status: 500 })
				: new Response('{"ok":true}');
		};
		expect(await undoConnection("https://track.test", "u", { fetcher, wait: noWait })).toBe(true);
		expect(calls).toBe(3);

		calls = -10;
		expect(await undoConnection("https://track.test", "u", { fetcher, wait: noWait })).toBe(false);
		expect(calls).toBe(-7);
	});

	it("is not asked twice for a token Track refuses", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			return new Response('{"error":"invalid_undo"}', { status: 400 });
		};
		expect(await undoConnection("https://track.test", "u", { fetcher, wait: noWait })).toBe(false);
		expect(calls).toBe(1);
	});

	it("is tried again when Track cannot be reached", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			throw new Error("down");
		};
		expect(await undoConnection("https://track.test", "u", { fetcher, wait: noWait })).toBe(false);
		expect(calls).toBe(3);
	});
});
