import { createHash, createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appJwt,
	branchCommit,
	branchHead,
	createBranch,
	createCommit,
	GitHubApp,
	importAppKey,
	moveBranch,
	openPullRequest,
	openPullRequestFrom,
	pkcePair,
	pullRequest,
	readTexts,
	readTree,
	updatePullRequest,
	verifyWebhook,
} from "../src";

const { privateKey: pkcs1, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs1", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const { privateKey: pkcs8 } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

function decode(part: string | undefined) {
	return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("appJwt", () => {
	it("signs with the PKCS#1 key GitHub hands out, as GitHub expects", async () => {
		const now = Date.UTC(2026, 9, 28, 12);
		const jwt = await appJwt("12345", await importAppKey(pkcs1), now);
		const [header, payload, signature] = jwt.split(".");

		expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
		// Issued a minute early against clock drift, and valid for less than ten minutes.
		expect(decode(payload)).toEqual({ iss: "12345", iat: now / 1000 - 60, exp: now / 1000 + 480 });
		const verify = createVerify("RSA-SHA256").update(`${header}.${payload}`);
		expect(verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
	});

	it("reads PKCS#8 keys, and keys whose newlines were escaped", async () => {
		await expect(importAppKey(pkcs8)).resolves.toBeDefined();
		await expect(importAppKey(pkcs1.replace(/\n/g, "\\n"))).resolves.toBeDefined();
	});
});

describe("verifyWebhook", () => {
	const body = JSON.stringify({ action: "added", installation: { id: 1 } });
	const sign = (secret: string, text: string) =>
		`sha256=${createHmac("sha256", secret).update(text).digest("hex")}`;

	it("accepts the body signed with the secret, and nothing else", async () => {
		expect(await verifyWebhook("s3cret", body, sign("s3cret", body))).toBe(true);
		expect(await verifyWebhook("s3cret", body, sign("other", body))).toBe(false);
		expect(await verifyWebhook("s3cret", `${body} `, sign("s3cret", body))).toBe(false);
		expect(await verifyWebhook("s3cret", body, null)).toBe(false);
		expect(await verifyWebhook("s3cret", body, "sha1=abc")).toBe(false);
	});
});

describe("pkcePair", () => {
	it("makes the S256 challenge of its verifier", async () => {
		const { verifier, challenge } = await pkcePair();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
	});
});

describe("repository contents", () => {
	const repository = { owner: "acme", name: "site" };
	const sha = (char: string) => char.repeat(40);

	it("reads a branch's head, branch names with slashes included", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (input: string) => {
			calls.push(input);
			return Response.json({ commit: { sha: sha("a"), commit: { tree: { sha: sha("b") } } } });
		});
		expect(await branchHead("ghs_x", repository, "release/2.0")).toEqual({
			commit: sha("a"),
			tree: sha("b"),
		});
		expect(calls).toEqual(["https://api.github.com/repos/acme/site/branches/release/2.0"]);
	});

	it("lists the files of a tree, marking symlinks and leaving out folders and submodules", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({
				sha: sha("b"),
				truncated: false,
				tree: [
					{ path: "docs", mode: "040000", type: "tree", sha: sha("c") },
					{ path: "AGENTS.md", mode: "100644", type: "blob", sha: sha("d"), size: 12 },
					{ path: "CLAUDE.md", mode: "120000", type: "blob", sha: sha("e"), size: 9 },
					{ path: "vendor/lib", mode: "160000", type: "commit", sha: sha("f") },
				],
			}),
		);
		expect(await readTree("ghs_x", repository, sha("b"))).toEqual({
			truncated: false,
			files: [
				{ path: "AGENTS.md", blob: sha("d"), size: 12, symlink: false },
				{ path: "CLAUDE.md", blob: sha("e"), size: 9, symlink: true },
			],
		});
	});

	it("reads texts fifty blobs per request, and none for binary or truncated blobs", async () => {
		const requests: { query: string; variables: unknown }[] = [];
		vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
			requests.push(body);
			const answer: Record<string, unknown> = {};
			for (const [, alias, id] of body.query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
				answer[alias ?? ""] =
					id === sha("0")
						? { text: null, isBinary: true, isTruncated: false }
						: id === sha("1")
							? { text: "partial", isBinary: false, isTruncated: true }
							: { text: `text of ${id?.slice(0, 4)}`, isBinary: false, isTruncated: false };
			}
			return Response.json({ data: { repository: answer } });
		});
		const ids = Array.from({ length: 60 }, (_, index) => index.toString(16).padStart(40, "a"));
		const texts = await readTexts("ghs_x", repository, [...ids, sha("0"), sha("1"), ids[0] ?? ""]);

		expect(requests).toHaveLength(2);
		expect(requests[0]?.variables).toEqual({ owner: "acme", name: "site" });
		expect(texts.size).toBe(62);
		expect(texts.get(ids[0] ?? "")).toBe("text of aaaa");
		expect(texts.get(sha("0"))).toBeNull();
		expect(texts.get(sha("1"))).toBeNull();
	});

	it("fails when GitHub answers without the repository", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({ data: { repository: null }, errors: [{ message: "Could not resolve" }] }),
		);
		await expect(readTexts("ghs_x", repository, [sha("2")])).rejects.toThrow("Could not resolve");
	});
});

describe("repository writes", () => {
	const repository = { owner: "acme", name: "site" };
	const sha = (char: string) => char.repeat(40);

	/** Answers each request with the next answer, and records what was asked. */
	function github(...answers: Response[]) {
		const calls: { route: string; body: unknown }[] = [];
		vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
			calls.push({
				route: `${init?.method ?? "GET"} ${input.replace("https://api.github.com", "")}`,
				body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
			});
			return answers.shift() ?? Response.json({ message: "Not Found" }, { status: 404 });
		});
		return calls;
	}

	it("commits files as content on top of the parent's tree, then nothing else", async () => {
		const calls = github(
			Response.json({ sha: sha("c"), truncated: false, tree: [] }, { status: 201 }),
			Response.json({ sha: sha("d") }, { status: 201 }),
		);
		const commit = await createCommit("ghs_x", repository, {
			parent: sha("a"),
			tree: sha("b"),
			files: [{ path: ".claude/skills/review/SKILL.md", content: "Review.\n" }],
			message: "Apply the Reviewers setup",
		});

		expect(commit).toBe(sha("d"));
		expect(calls).toEqual([
			{
				route: "POST /repos/acme/site/git/trees",
				body: {
					base_tree: sha("b"),
					tree: [
						{
							path: ".claude/skills/review/SKILL.md",
							mode: "100644",
							type: "blob",
							content: "Review.\n",
						},
					],
				},
			},
			{
				route: "POST /repos/acme/site/git/commits",
				body: { message: "Apply the Reviewers setup", tree: sha("c"), parents: [sha("a")] },
			},
		]);
	});

	it("creates, reads and moves branches whose names hold slashes", async () => {
		const calls = github(
			Response.json({ ref: "refs/heads/gateweave/setup-x" }, { status: 201 }),
			Response.json({ object: { sha: sha("d") } }),
			Response.json({ object: { sha: sha("e") } }),
		);
		await createBranch("ghs_x", repository, "gateweave/setup-x", sha("d"));
		expect(await branchCommit("ghs_x", repository, "gateweave/setup-x")).toBe(sha("d"));
		await moveBranch("ghs_x", repository, "gateweave/setup-x", sha("e"), true);
		expect(await branchCommit("ghs_x", repository, "gone")).toBeNull();

		expect(calls.map((call) => call.route)).toEqual([
			"POST /repos/acme/site/git/refs",
			"GET /repos/acme/site/git/ref/heads/gateweave/setup-x",
			"PATCH /repos/acme/site/git/refs/heads/gateweave/setup-x",
			"GET /repos/acme/site/git/ref/heads/gone",
		]);
		expect(calls[0]?.body).toEqual({ ref: "refs/heads/gateweave/setup-x", sha: sha("d") });
		expect(calls[2]?.body).toEqual({ sha: sha("e"), force: true });
	});

	it("opens, reads and updates pull requests, telling merged from closed", async () => {
		const pull = (state: string, merged: boolean | undefined, mergedAt: string | null) =>
			Response.json({
				number: 7,
				html_url: "https://github.com/acme/site/pull/7",
				state,
				...(merged === undefined ? {} : { merged }),
				merged_at: mergedAt,
				head: { ref: "gateweave/setup-x", sha: sha("d") },
			});
		const calls = github(
			pull("open", false, null),
			pull("closed", true, "2026-10-28T12:00:00Z"),
			pull("closed", undefined, null),
		);

		const opened = await openPullRequest("ghs_x", repository, {
			title: "Apply the Reviewers setup",
			body: "Pins",
			head: "gateweave/setup-x",
			base: "main",
		});
		expect(opened).toEqual({
			number: 7,
			url: "https://github.com/acme/site/pull/7",
			state: "open",
			head: sha("d"),
		});
		expect((await pullRequest("ghs_x", repository, 7))?.state).toBe("merged");
		const updated = await updatePullRequest("ghs_x", repository, 7, { title: "T", body: "B" });
		expect(updated.state).toBe("closed");
		expect(await pullRequest("ghs_x", repository, 8)).toBeNull();

		expect(calls.map((call) => call.route)).toEqual([
			"POST /repos/acme/site/pulls",
			"GET /repos/acme/site/pulls/7",
			"PATCH /repos/acme/site/pulls/7",
			"GET /repos/acme/site/pulls/8",
		]);
		expect(calls[0]?.body).toEqual({
			title: "Apply the Reviewers setup",
			body: "Pins",
			head: "gateweave/setup-x",
			base: "main",
		});
	});

	it("finds the open pull request from one of the repository's own branches", async () => {
		const calls = github(
			Response.json([
				{
					number: 12,
					html_url: "https://github.com/acme/site/pull/12",
					state: "open",
					merged_at: null,
					head: { ref: "gateweave/c-1", sha: sha("e") },
				},
			]),
			Response.json([]),
		);

		expect(await openPullRequestFrom("ghs_x", repository, "gateweave/c-1")).toEqual({
			number: 12,
			url: "https://github.com/acme/site/pull/12",
			state: "open",
			head: sha("e"),
		});
		expect(await openPullRequestFrom("ghs_x", repository, "gateweave/c-2")).toBeNull();
		expect(calls.map((call) => call.route)).toEqual([
			"GET /repos/acme/site/pulls?head=acme%3Agateweave%2Fc-1&state=open&per_page=1",
			"GET /repos/acme/site/pulls?head=acme%3Agateweave%2Fc-2&state=open&per_page=1",
		]);
	});

	it("passes on GitHub's refusals with their status", async () => {
		github(Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
		await expect(createBranch("ghs_x", repository, "x", sha("d"))).rejects.toMatchObject({
			status: 403,
		});
	});
});

describe("GitHubApp", () => {
	it("reuses an installation token until shortly before it expires", async () => {
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${input}`);
			const auth = new Headers(init?.headers).get("authorization") ?? "";
			if (input.endsWith("/access_tokens")) {
				expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
				return Response.json({ token: "ghs_installation", expires_at: expiresAt });
			}
			expect(auth).toBe("Bearer ghs_installation");
			return Response.json({
				total_count: 1,
				repositories: [
					{
						id: 7,
						name: "site",
						owner: { login: "acme" },
						default_branch: "main",
						private: true,
					},
				],
			});
		});
		const app = new GitHubApp({ appId: "1", privateKey: pkcs1 });

		expect(await app.repositories("99")).toEqual([
			{
				provider: "github",
				externalId: "7",
				installationId: "99",
				owner: "acme",
				name: "site",
				defaultBranch: "main",
				private: true,
			},
		]);
		await app.repositories("99");
		expect(calls).toEqual([
			"POST https://api.github.com/app/installations/99/access_tokens",
			"GET https://api.github.com/installation/repositories?per_page=100&page=1",
			"GET https://api.github.com/installation/repositories?per_page=100&page=1",
		]);
	});

	it("scopes a repository token to one repository and the permissions asked for", async () => {
		const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const bodies: unknown[] = [];
		vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
			const body = init?.body === undefined ? null : JSON.parse(String(init.body));
			bodies.push(body);
			return Response.json({ token: `ghs_${bodies.length}`, expires_at: expiresAt });
		});
		const app = new GitHubApp({ appId: "1", privateKey: pkcs1 });

		expect(await app.repositoryToken("99", "7", { contents: "read" })).toBe("ghs_1");
		expect(await app.repositoryToken("99", "7", { contents: "read" })).toBe("ghs_1");
		// Another repository, other permissions or the whole installation each get a token of
		// their own.
		expect(await app.repositoryToken("99", "8", { contents: "read" })).toBe("ghs_2");
		expect(await app.repositoryToken("99", "7", { contents: "write" })).toBe("ghs_3");
		expect(await app.installationToken("99")).toBe("ghs_4");
		expect(bodies).toEqual([
			{ repository_ids: [7], permissions: { contents: "read" } },
			{ repository_ids: [8], permissions: { contents: "read" } },
			{ repository_ids: [7], permissions: { contents: "write" } },
			null,
		]);
	});
});
