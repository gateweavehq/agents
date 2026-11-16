import { afterEach, describe, expect, it, vi } from "vitest";
import {
	commitChanges,
	GitHubError,
	isRateLimit,
	readCommit,
	readTexts,
	readTreeEntries,
} from "../src";
import { FakeGit } from "./fake-git";

afterEach(() => {
	vi.unstubAllGlobals();
});

const repository = { owner: "acme", name: "site" };
const sha = (char: string) => char.repeat(40);

/** What `readTexts` throws for this answer of GraphQL's. */
async function refusal(answer: unknown): Promise<GitHubError> {
	vi.stubGlobal("fetch", async () => Response.json(answer));
	const thrown = await readTexts("ghs_x", repository, [sha("2")]).then(
		() => null,
		(error: unknown) => error,
	);
	if (!(thrown instanceof GitHubError)) throw new Error("readTexts did not refuse");
	return thrown;
}

describe("texts GitHub gives no repository for", () => {
	it("are a repository that is not there, as 404", async () => {
		const thrown = await refusal({
			data: { repository: null },
			errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
		});
		expect(thrown.status).toBe(404);
		expect(thrown.message).toContain("Could not resolve");
	});

	it("are a caller over its rate limit, as 429, by the error's type or its words", async () => {
		const typed = await refusal({
			errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation." }],
		});
		expect(typed.status).toBe(429);
		const worded = await refusal({
			data: null,
			errors: [{ message: "You have exceeded a secondary rate limit. Please wait." }],
		});
		expect(worded.status).toBe(429);
		expect(worded.message).toContain("secondary rate limit");
	});

	it("tell a rate limit by GitHub's words for it", () => {
		expect(
			isRateLimit('GitHub answered 403: {"message":"API rate limit exceeded for 1.2.3.4"}'),
		).toBe(true);
		expect(isRateLimit("You have exceeded a secondary rate limit.")).toBe(true);
		expect(
			isRateLimit('GitHub answered 403: {"message":"Resource not accessible by integration"}'),
		).toBe(false);
	});
});

describe("a commit read by its id", () => {
	it("gives its tree and the commits it follows", async () => {
		const fake = new FakeGit();
		const first = await fake.seed({ "README.md": "# Site\n" });
		const second = await fake.push("main", "README.md", "# Changed\n");
		vi.stubGlobal("fetch", fake.fetch);

		const root = await readCommit(fake.readToken, fake.repository, first);
		expect(root).toEqual({ tree: fake.commits.get(first)?.tree, parents: [] });
		expect(await readCommit(fake.readToken, fake.repository, second)).toEqual({
			tree: fake.commits.get(second)?.tree,
			parents: [first],
		});
		await expect(readCommit(fake.readToken, fake.repository, sha("9"))).rejects.toMatchObject({
			status: 404,
		});
		await expect(readCommit(fake.readToken, fake.repository, "main")).rejects.toThrow();
	});
});

describe("a name that changes only in case, in one change", () => {
	const files = { "README.md": "# Site\n", "docs/guide.md": "# Guide\n", "src/a.ts": "a\n" };

	async function change(written: string[], deleted: string[]) {
		const fake = new FakeGit();
		const commit = await fake.seed(files);
		vi.stubGlobal("fetch", fake.fetch);
		const tree = fake.commits.get(commit)?.tree ?? "";
		const base = await readTreeEntries(fake.readToken, fake.repository, tree);
		const outcome = await commitChanges(fake.token, fake.repository, {
			branch: "work",
			defaultBranch: "main",
			expected: null,
			base: { commit, tree, ...base },
			files: written.map((path) => ({ path, content: "renamed\n" })),
			deleted,
			message: "Rename",
		});
		return { outcome, fake };
	}

	it("is refused while the other name stands in the tree", async () => {
		expect((await change(["Readme.md"], [])).outcome).toEqual({
			committed: false,
			reason: "path",
			path: "Readme.md",
			message: "differs only in case from README.md",
		});
		// A folder stands while any file in it does.
		expect((await change(["Docs/guide.md"], [])).outcome).toMatchObject({
			reason: "path",
			message: "differs only in case from docs",
		});
	});

	it("is taken when the change deletes the other, a folder's last file included", async () => {
		const { outcome, fake } = await change(
			["Readme.md", "Docs/guide.md"],
			["README.md", "docs/guide.md"],
		);
		expect(outcome).toMatchObject({ committed: true });
		expect(Object.keys(fake.filesAt("work")).sort()).toEqual([
			"Docs/guide.md",
			"Readme.md",
			"src/a.ts",
		]);
	});
});
