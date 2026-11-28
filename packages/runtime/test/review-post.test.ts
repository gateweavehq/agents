import { type GitHubApp, GitHubError } from "@gateweave/agents-github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitHubReviewPost, postReviewOnce } from "../src/review-post";

afterEach(() => vi.unstubAllGlobals());

const input = {
	key: "run-1",
	number: 12,
	commitId: "a".repeat(40),
	summary: "Summary with every finding",
	comments: [{ path: "a.ts", line: 1, side: "RIGHT" as const, body: "Finding" }],
};
const memory = () => {
	const kept = new Set<string>();
	return {
		kept,
		recall: async (key: string) => kept.has(key),
		remember: async (key: string) => {
			kept.add(key);
		},
	};
};

describe("postReviewOnce", () => {
	it("posts the line comments and remembers the post", async () => {
		const calls: unknown[] = [];
		const post = async (posted: unknown) => {
			calls.push(posted);
		};
		const kept = memory();
		await expect(postReviewOnce(post, input, kept)).resolves.toEqual({
			posted: true,
			alreadyPosted: false,
			summaryOnly: false,
		});
		expect(calls).toHaveLength(1);
		expect((calls[0] as { comments: unknown }).comments).toEqual(input.comments);
		expect(kept.kept.has(input.key)).toBe(true);
	});

	it("posts once more without line comments after a 422, and only once", async () => {
		const calls: unknown[] = [];
		let refused = false;
		const post = async (posted: unknown) => {
			calls.push(posted);
			if (!refused) {
				refused = true;
				throw new GitHubError(422, "Validation Failed");
			}
		};
		const kept = memory();
		await expect(postReviewOnce(post, input, kept)).resolves.toMatchObject({
			posted: true,
			summaryOnly: true,
		});
		expect(calls).toHaveLength(2);
		expect((calls[1] as { comments: unknown }).comments).toEqual([]);
		await expect(postReviewOnce(post, input, kept)).resolves.toEqual({
			posted: false,
			alreadyPosted: true,
			summaryOnly: false,
		});
		expect(calls).toHaveLength(2);
	});

	it("reconciles a review GitHub accepted before its response was lost", async () => {
		const kept = memory();
		const failing = vi.fn(async () => {
			throw new GitHubError(0, "response lost");
		});
		await expect(postReviewOnce(failing, input, kept)).rejects.toMatchObject({ status: 0 });
		const posts = vi.fn(async () => {});
		const reconcile = vi.fn(async () => true);
		await expect(postReviewOnce(posts, input, kept, reconcile)).resolves.toMatchObject({
			alreadyPosted: true,
		});
		expect(reconcile).toHaveBeenCalledOnce();
		expect(posts).not.toHaveBeenCalled();
	});

	it("does not remember a refused fallback or another failure", async () => {
		const kept = memory();
		const refused = vi
			.fn(async () => {})
			.mockRejectedValue(new GitHubError(422, "Validation Failed"));
		await expect(postReviewOnce(refused, input, kept)).rejects.toMatchObject({ status: 422 });
		expect(kept.kept.has(input.key)).toBe(false);
		const unavailable = vi.fn(async () => {
			throw new GitHubError(500, "GitHub unavailable");
		});
		await expect(postReviewOnce(unavailable, input, kept)).rejects.toMatchObject({ status: 500 });
		expect(kept.kept.has(input.key)).toBe(false);
	});

	it("uses a repository token scoped to pull request comments and contents", async () => {
		const repositoryToken = vi.fn(async () => "installation-token");
		const app = { repositoryToken } as unknown as GitHubApp;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ id: 1 }, { status: 201 })),
		);
		await gitHubReviewPost(app, {
			owner: "acme",
			name: "site",
			externalId: "77",
			installationId: "99",
			defaultBranch: "main",
		})({
			number: input.number,
			commitId: input.commitId,
			summary: input.summary,
			comments: input.comments,
		});
		expect(repositoryToken).toHaveBeenCalledWith("99", "77", {
			contents: "read",
			pull_requests: "write",
		});
		const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
			event: string;
		};
		expect(body.event).toBe("COMMENT");
	});
});
