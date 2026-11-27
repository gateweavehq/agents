import { afterEach, describe, expect, it, vi } from "vitest";
import { pullRequest, pullRequestDiff } from "../src";

afterEach(() => {
	vi.unstubAllGlobals();
});

const repository = { owner: "acme", name: "site" };

/** Answers a pull request's request with its diff, or with the status the test gives. */
function github(answer: (accept: string | null) => Response) {
	const asked: { path: string; accept: string | null }[] = [];
	vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
		const accept = new Headers(init.headers).get("accept");
		asked.push({ path: new URL(input).pathname, accept });
		return answer(accept);
	});
	return asked;
}

describe("a pull request's diff", () => {
	it("is read in GitHub's diff media type", async () => {
		const asked = github(() => new Response("diff --git a/x b/x\n+one\n"));
		expect(await pullRequestDiff("ghs_x", repository, 12, 1000)).toEqual({
			diff: "diff --git a/x b/x\n+one\n",
		});
		expect(asked).toEqual([
			{ path: "/repos/acme/site/pulls/12", accept: "application/vnd.github.v3.diff" },
		]);
	});

	it("is too large past the limit in bytes, and not at it", async () => {
		github(() => new Response("é".repeat(5)));
		expect(await pullRequestDiff("ghs_x", repository, 10, 10)).toEqual({ diff: "é".repeat(5) });
		expect(await pullRequestDiff("ghs_x", repository, 10, 9)).toEqual({ tooLarge: true });
	});

	it("is too large when GitHub will not make one, and absent when there is no pull request", async () => {
		github(() => Response.json({ message: "diff exceeded" }, { status: 406 }));
		expect(await pullRequestDiff("ghs_x", repository, 12, 1000)).toEqual({ tooLarge: true });
		github(() => Response.json({ message: "Not Found" }, { status: 404 }));
		expect(await pullRequestDiff("ghs_x", repository, 12, 1000)).toBeNull();
	});

	it("leaves a server's failure to the caller", async () => {
		github(() => Response.json({ message: "down" }, { status: 503 }));
		await expect(pullRequestDiff("ghs_x", repository, 12, 1000)).rejects.toMatchObject({
			status: 503,
		});
	});
});

describe("a pull request's description", () => {
	it("is kept, empty when GitHub says null, and left out when the answer has none", async () => {
		const pull = {
			number: 12,
			html_url: "https://github.com/acme/site/pull/12",
			title: "Fix",
			state: "open",
			head: { sha: "a".repeat(40), ref: "b" },
		};
		github(() => Response.json({ ...pull, body: "Why." }));
		expect((await pullRequest("ghs_x", repository, 12))?.body).toBe("Why.");
		github(() => Response.json({ ...pull, body: null }));
		expect((await pullRequest("ghs_x", repository, 12))?.body).toBe("");
		github(() => Response.json(pull));
		expect(await pullRequest("ghs_x", repository, 12)).not.toHaveProperty("body");
	});
});

describe("a pull request's base", () => {
	it("is the branch it is to be merged into, and left out when the answer does not name it", async () => {
		const pull = {
			number: 12,
			html_url: "https://github.com/acme/site/pull/12",
			title: "Fix",
			state: "open",
			head: { sha: "a".repeat(40), ref: "b" },
		};
		github(() => Response.json({ ...pull, base: { ref: "release/1.x" } }));
		expect((await pullRequest("ghs_x", repository, 12))?.baseRef).toBe("release/1.x");
		github(() => Response.json(pull));
		expect(await pullRequest("ghs_x", repository, 12)).not.toHaveProperty("baseRef");
	});
});
