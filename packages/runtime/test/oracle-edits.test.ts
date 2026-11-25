/**
 * An agent's edits to the files that decide whether its own checks pass. The pull
 * request stays a draft and its section lists the paths; adding a test is not flagged.
 */
import type { GitHubApp } from "@gateweave/agents-github";
import type { PullRequestOutcome } from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChangedFile, oracleKind, reviewOracles } from "../src/oracles";
import { gitHubPullRequests, pullRequestTools } from "../src/pull-requests";
import type { RunRecorder } from "../src/trace";
import { MemorySandbox } from "./fake-sandbox";

const repository = {
	owner: "acme",
	name: "site",
	externalId: "7",
	installationId: "99",
	defaultBranch: "main",
};

/** `scripts` of a package.json as the base and the branch have them. */
const manifest = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

/**
 * `open_pull_request` over a branch that changes `files`; with `checks`, the repository has
 * those commands and they pass.
 */
function setup(
	files: ChangedFile[],
	texts: Record<string, string> = {},
	unreadable = false,
	checks: string[] = [],
) {
	const sandbox = new MemorySandbox();
	const proposed: { body: string; draft?: boolean; convert?: boolean }[] = [];
	const tools = pullRequestTools({
		sandbox,
		...(checks.length > 0
			? { checks: { commands: async () => checks, sandbox, now: () => sandbox.clock } }
			: {}),
		ready: async () => null,
		github: {
			async propose(input) {
				proposed.push(input);
				return {
					number: 5,
					url: "https://github.com/acme/site/pull/5",
					opened: true,
					title: input.title,
					state: "open",
					head: "2".repeat(40),
					headRef: input.branch,
					additions: 1,
					deletions: 1,
					changedFiles: files.length,
				};
			},
			async review() {
				if (unreadable) return { unverified: "GitHub's comparison could not be read" };
				return reviewOracles(files, async (path, side) => texts[`${side}:${path}`] ?? null);
			},
		},
		repository,
		branch: "gateweave/c-1",
		runId: "run-1",
		agentName: "Builder",
		model: "model-1",
		author: async () => ({ name: "Builder", email: "noreply@gateweave.com" }),
		record: async () => {},
		run: {
			targets: { tainted: false, trusted: new Set() },
			toolStarted: () => "0",
			toolEnded: () => {},
		} as unknown as RunRecorder,
	});
	const execute = tools.open_pull_request?.execute as unknown as (
		input: object,
		options: { toolCallId: string; messages: [] },
	) => Promise<PullRequestOutcome>;
	return {
		proposed,
		call: () => execute({ title: "Fix", body: "Done." }, { toolCallId: "c", messages: [] }),
	};
}

describe("which paths are oracles", () => {
	it.each([
		["apps/web/test/cart.test.ts", "test"],
		["packages/x/src/cart.spec.tsx", "test"],
		["tests/helpers.ts", "test"],
		["pkg/cart_test.go", "test"],
		[".github/workflows/ci.yml", "CI"],
		["package.json", "package script"],
		["apps/web/package.json", "package script"],
		["biome.json", "lint or type config"],
		["eslint.config.mjs", "lint or type config"],
		["packages/a/tsconfig.json", "lint or type config"],
		["vitest.config.ts", "test"],
		["vite.config.ts", "test"],
		["apps/web/vite.config.mts", "test"],
		["scripts/check-one-agents.mjs", "check script"],
		["packages/a/test/__snapshots__/cart.test.ts.snap", "test"],
		["src/cart.snap", "test"],
		["apps/web/fixtures/cart.json", "test"],
		["pytest.ini", "test"],
		[".pytest.ini", "test"],
		["conftest.py", "test"],
		["services/api/pytest.ini", "test"],
		["services/api/.pytest.ini", "test"],
		["services/api/conftest.py", "test"],
		["pyproject.toml", "lint or type config"],
		["services/api/setup.cfg", "lint or type config"],
	])("%s is a %s", (path, kind) => {
		expect(oracleKind(path)).toBe(kind);
	});
	it.each([
		"src/cart.ts",
		"README.md",
		"docs/testing.md",
		"src/latest.ts",
		"packages/a/scripts/x.ts",
		"src/conftest.pyc",
		"src/my-pytest.ini.md",
	])("%s is not one", (path) => {
		expect(oracleKind(path)).toBeNull();
	});
});

describe("open_pull_request and an agent's edits to its checks", () => {
	it("opens a draft that lists a modified test", async () => {
		const { call, proposed } = setup([
			{ path: "src/cart.ts", status: "modified" },
			{ path: "test/cart.test.ts", status: "modified" },
		]);
		const outcome = await call();
		expect(outcome.draft).toBe(true);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain("## Checks run by Gateweave");
		expect(proposed[0]?.body).toContain("- `test/cart.test.ts`: modified (test)");
		expect(proposed[0]?.body).not.toContain("`src/cart.ts`");
		expect(outcome.note).toContain("test/cart.test.ts (modified)");
	});
	it("opens a draft that lists a deleted test, workflow and lint config", async () => {
		const { call, proposed } = setup([
			{ path: "test/cart.test.ts", status: "removed" },
			{ path: ".github/workflows/ci.yml", status: "modified" },
			{ path: "biome.json", status: "removed" },
		]);
		expect((await call()).draft).toBe(true);
		const body = proposed[0]?.body ?? "";
		expect(body).toContain("- `test/cart.test.ts`: deleted (test)");
		expect(body).toContain("- `.github/workflows/ci.yml`: modified (CI)");
		expect(body).toContain("- `biome.json`: deleted (lint or type config)");
		expect(proposed[0]?.draft).toBe(true);
	});
	it("lists a modified check script", async () => {
		const { call, proposed } = setup([
			{ path: "scripts/check-one-agents.mjs", status: "modified" },
		]);
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.body).toContain(
			"- `scripts/check-one-agents.mjs`: modified (check script)",
		);
	});
	it("lists the old path of a renamed test", async () => {
		const { call, proposed } = setup([
			{ path: "src/cart.ts", status: "renamed", previousPath: "test/cart.test.ts" },
		]);
		await call();
		expect(proposed[0]?.body).toContain("- `test/cart.test.ts`: renamed (test)");
	});
	it("flags a package.json whose scripts changed, not one whose dependencies did", async () => {
		const changed = setup([{ path: "package.json", status: "modified" }], {
			"base:package.json": manifest({ test: "vitest run" }),
			"head:package.json": manifest({ test: "true" }),
		});
		expect((await changed.call()).draft).toBe(true);
		expect(changed.proposed[0]?.body).toContain("- `package.json`: modified (package script)");
		const other = setup([{ path: "package.json", status: "modified" }], {
			"base:package.json": manifest({ test: "vitest run", lint: "biome check" }),
			"head:package.json": JSON.stringify({
				dependencies: { zod: "1.0.0" },
				scripts: { lint: "biome check", test: "vitest run" },
			}),
		});
		const outcome = await other.call();
		expect(outcome.draft).toBeUndefined();
		expect(other.proposed[0]?.draft).toBeUndefined();
	});
	it("does not flag added tests, an added workflow or ordinary changes", async () => {
		const { call, proposed } = setup([
			{ path: "test/new.test.ts", status: "added" },
			{ path: ".github/workflows/new.yml", status: "added" },
			{ path: "scripts/new.mjs", status: "added" },
			{ path: "src/cart.ts", status: "modified" },
		]);
		const outcome = await call();
		expect(outcome.draft).toBeUndefined();
		expect(proposed[0]?.draft).toBeUndefined();
		expect(proposed[0]?.body).not.toContain("Checks run by Gateweave");
	});
	it("lists the edits in the section of a repository whose checks pass, and keeps a draft", async () => {
		const { call, proposed } = setup(
			[{ path: "test/cart.test.ts", status: "modified" }],
			{},
			false,
			["pnpm test"],
		);
		const outcome = await call();
		expect(outcome).toMatchObject({ checks: "passed", draft: true });
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.convert).toBe(true);
		const body = proposed[0]?.body ?? "";
		expect(body).toContain("- `pnpm test`: passed");
		expect(body).toContain("- `test/cart.test.ts`: modified (test)");
		expect(body.indexOf("`pnpm test`")).toBeLessThan(body.indexOf("`test/cart.test.ts`"));
		expect(outcome.note).toContain("test/cart.test.ts (modified)");
	});
	it("keeps a pull request with passing checks and no edits a ready one", async () => {
		const { call, proposed } = setup([{ path: "src/cart.ts", status: "modified" }], {}, false, [
			"pnpm test",
		]);
		expect(await call()).toMatchObject({ checks: "passed", draft: false });
		expect(proposed[0]?.draft).toBeUndefined();
		expect(proposed[0]?.convert).toBeUndefined();
		expect(proposed[0]?.body).not.toContain("modifies or deletes");
	});
	it.each([
		["pytest.ini", "modified"],
		[".pytest.ini", "modified"],
		["conftest.py", "modified"],
		["pytest.ini", "removed"],
		[".pytest.ini", "removed"],
		["conftest.py", "removed"],
	])("opens a draft for a %s that is %s", async (path, status) => {
		const { call, proposed } = setup([{ path, status }]);
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain(
			`- \`${path}\`: ${status === "removed" ? "deleted" : "modified"} (test)`,
		);
	});
	it("opens a draft when it cannot tell what the branch changes", async () => {
		const { call, proposed } = setup([], {}, true);
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain("could not tell whether");
	});
});

describe("the files a package.json script names", () => {
	const root = JSON.stringify({
		scripts: { lint: "node tools/lint.mjs --strict", pack: "tsc -b" },
	});
	const web = JSON.stringify({ scripts: { check: "bash ./ci/check.sh" } });
	const texts = async (path: string) =>
		path === "package.json" ? root : path === "apps/web/package.json" ? web : null;

	it("flags a modified or deleted script that a package.json at the base runs", async () => {
		const edits = await reviewOracles(
			[
				{ path: "tools/lint.mjs", status: "modified" },
				{ path: "apps/web/ci/check.sh", status: "removed" },
			],
			texts,
		);
		expect(edits).toEqual({
			edits: [
				{ path: "apps/web/ci/check.sh", change: "deleted", kind: "check script" },
				{ path: "tools/lint.mjs", change: "modified", kind: "check script" },
			],
		});
	});
	it("leaves a script no package.json runs, and a script that is added", async () => {
		expect(
			await reviewOracles(
				[
					{ path: "tools/other.mjs", status: "modified" },
					{ path: "apps/web/tools/lint.mjs", status: "modified" },
					{ path: "tools/new.mjs", status: "added" },
					{ path: "tools/lint.mjs", status: "added" },
				],
				texts,
			),
		).toEqual({ edits: [] });
	});
});

describe("the directory a script runs its file in", () => {
	/** The review of a branch that modifies `paths`, when the base's root package.json has `script`. */
	const review = (script: string, ...paths: string[]) =>
		reviewOracles(
			paths.map((path) => ({ path, status: "modified" })),
			async (path) =>
				path === "package.json" ? JSON.stringify({ scripts: { check: script } }) : null,
		);
	const edit = (path: string) => ({
		edits: [{ path, change: "modified", kind: "check script" }],
	});
	const unverified = expect.objectContaining({ unverified: expect.any(String) });

	it("looks for the file where a cd has gone", async () => {
		expect(await review("cd tools && node lint.mjs", "tools/lint.mjs")).toEqual(
			edit("tools/lint.mjs"),
		);
		expect(await review("cd tools; node lint.mjs", "tools/lint.mjs")).toEqual(
			edit("tools/lint.mjs"),
		);
		expect(await review('cd "tools/x" && node ../lint.mjs', "tools/lint.mjs")).toEqual(
			edit("tools/lint.mjs"),
		);
		expect(await review("cd tools && cd .. && node lint.mjs", "lint.mjs")).toEqual(
			edit("lint.mjs"),
		);
		expect(
			await review("cd a && node x.mjs && cd ../b && node y.mjs", "b/y.mjs", "a/x.mjs"),
		).toEqual({
			edits: [
				{ path: "a/x.mjs", change: "modified", kind: "check script" },
				{ path: "b/y.mjs", change: "modified", kind: "check script" },
			],
		});
	});
	it("does not take the package's own file for the one in the directory it went to", async () => {
		expect(await review("cd tools && node lint.mjs", "lint.mjs")).toEqual({ edits: [] });
	});
	it("is unverified when the directory a script runs in cannot be told", async () => {
		for (const script of [
			'cd "$DIR" && node lint.mjs',
			"cd ~/x && node lint.mjs",
			"cd /opt/x && node lint.mjs",
			"cd - && node lint.mjs",
			"(cd tools && node lint.mjs)",
			"cd tools | node lint.mjs",
			"pnpm --dir tools exec node lint.mjs",
			"npm --prefix tools exec -- node lint.mjs",
			"env -C tools node lint.mjs",
			"node $TOOLS/lint.mjs",
			"node tools/*.mjs",
			"node tools/{lint,fmt}.mjs",
			"node /abs/lint.mjs",
		]) {
			expect(await review(script, "tools/lint.mjs"), script).toEqual(unverified);
		}
	});
	it("leaves a file of another name when the place of a script's file cannot be told", async () => {
		expect(await review('cd "$DIR" && node lint.mjs', "tools/other.mjs", "src/cart.ts")).toEqual({
			edits: [],
		});
	});
});

describe("a base package.json that cannot be read", () => {
	const files = [{ path: "tools/lint.mjs", status: "modified" }];
	const manifest = JSON.stringify({ scripts: { lint: "node tools/lint.mjs" } });

	it("is unverified, where an absent one names nothing", async () => {
		expect(
			await reviewOracles(files, async () => {
				throw new Error("403");
			}),
		).toEqual({ unverified: "the base's tools/package.json could not be read" });
		expect(await reviewOracles(files, async () => null)).toEqual({ edits: [] });
		expect(
			await reviewOracles(files, async (path) => (path === "package.json" ? manifest : null)),
		).toEqual({
			edits: [{ path: "tools/lint.mjs", change: "modified", kind: "check script" }],
		});
	});
	it("is unverified for a package.json in a directory above the file", async () => {
		expect(
			await reviewOracles(files, async (path) => {
				if (path === "tools/package.json") throw new Error("403");
				return null;
			}),
		).toEqual({ unverified: "the base's tools/package.json could not be read" });
	});
	it("takes a package.json that cannot be read, at the base or the branch, as changed", async () => {
		expect(
			await reviewOracles([{ path: "package.json", status: "modified" }], async (_path, side) => {
				if (side === "head") throw new Error("403");
				return JSON.stringify({ scripts: { test: "vitest" } });
			}),
		).toEqual({ edits: [{ path: "package.json", change: "modified", kind: "package script" }] });
	});
});

describe("the review of a branch on GitHub", () => {
	afterEach(() => vi.unstubAllGlobals());

	/** GitHub as a spy on fetch: `answer` gets each request's route and the routes are returned. */
	const github = (answer: (route: string) => Response | Promise<Response>) => {
		const routes: string[] = [];
		vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
			const route = `${init?.method ?? "GET"} ${String(input).replace("https://api.github.com", "")}`;
			routes.push(route);
			return answer(route);
		});
		return routes;
	};
	const app = { repositoryToken: async () => "ghs_x" } as unknown as GitHubApp;
	const port = () => gitHubPullRequests(app, repository);

	it("is unverified when the comparison is at GitHub's limit of files", async () => {
		const files = Array.from({ length: 300 }, (_, index) => ({
			filename: `src/f${index}.ts`,
			status: "modified",
		}));
		const routes = github(() =>
			Response.json({ merge_base_commit: { sha: "e".repeat(40) }, files }),
		);
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the branch changes more files than GitHub's comparison lists",
		});
		// One request: the files come with the first page, and the other pages hold commits.
		expect(routes).toEqual([
			"GET /repos/acme/site/compare/main...gateweave%2Fc-1?per_page=1&page=1",
		]);
	});
	it("is unverified when GitHub cannot be asked", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		github(() => Response.json({ message: "Server Error" }, { status: 500 }));
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "GitHub's comparison could not be read",
		});
		error.mockRestore();
	});
	it("reads a package.json at the merge base and at the branch", async () => {
		const routes = github((route) =>
			route.includes("/compare/")
				? Response.json({
						merge_base_commit: { sha: "e".repeat(40) },
						files: [{ filename: "package.json", status: "modified" }],
					})
				: new Response(
						JSON.stringify({
							scripts: { test: route.includes("ref=gateweave") ? "true" : "vitest" },
						}),
					),
		);
		expect(await port().review?.("gateweave/c-1")).toEqual({
			edits: [{ path: "package.json", change: "modified", kind: "package script" }],
		});
		expect(routes).toContain(`GET /repos/acme/site/contents/package.json?ref=${"e".repeat(40)}`);
		expect(routes).toContain("GET /repos/acme/site/contents/package.json?ref=gateweave%2Fc-1");
	});

	const pull = (draft: boolean) => ({
		number: 5,
		node_id: "PR_node",
		draft,
		html_url: "https://github.com/acme/site/pull/5",
		title: "Fix",
		state: "open",
		merged_at: null,
		head: { sha: "1".repeat(40), ref: "gateweave/c-1" },
	});
	/** A repository that has this pull request open from the branch already. */
	const open = (draft: boolean) => (route: string) =>
		route.startsWith("POST /graphql")
			? Response.json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } })
			: route.startsWith("GET /repos/acme/site/pulls?")
				? Response.json([pull(draft)])
				: Response.json(pull(draft));
	const input = { branch: "gateweave/c-1", title: "Fix", body: "b" };

	it("is unverified when the base's package.json is denied, and clean when it is not there", async () => {
		const answer = (status: number) => (route: string) =>
			route.includes("/compare/")
				? Response.json({
						merge_base_commit: { sha: "e".repeat(40) },
						files: [{ filename: "tools/lint.mjs", status: "modified" }],
					})
				: Response.json({ message: "no" }, { status });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		github(answer(403));
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the base's tools/package.json could not be read",
		});
		github(answer(404));
		expect(await port().review?.("gateweave/c-1")).toEqual({ edits: [] });
		error.mockRestore();
	});
	it("reads `cd tools && node lint.mjs` from the base's package.json", async () => {
		github((route) =>
			route.includes("/compare/")
				? Response.json({
						merge_base_commit: { sha: "e".repeat(40) },
						files: [{ filename: "tools/lint.mjs", status: "modified" }],
					})
				: route.includes("contents/package.json")
					? new Response(JSON.stringify({ scripts: { check: "cd tools && node lint.mjs" } }))
					: Response.json({ message: "Not Found" }, { status: 404 }),
		);
		expect(await port().review?.("gateweave/c-1")).toEqual({
			edits: [{ path: "tools/lint.mjs", change: "modified", kind: "check script" }],
		});
	});

	it("makes a pull request that is open and ready a draft when it edits a check", async () => {
		const routes = github(open(false));
		const made = await port().propose({ ...input, draft: true, convert: true });
		expect(made).toMatchObject({ opened: false, draft: true });
		expect(routes.filter((route) => route.includes("graphql"))).toEqual(["POST /graphql"]);
	});
	it("does not convert a draft, or a pull request that edits nothing", async () => {
		const drafts = github(open(true));
		await port().propose({ ...input, draft: true, convert: true });
		expect(drafts.some((route) => route.includes("graphql"))).toBe(false);
		const ready = github(open(false));
		await port().propose(input);
		await port().propose({ ...input, draft: true });
		expect(ready.some((route) => route.includes("graphql"))).toBe(false);
	});
	it("fails the call when GitHub does not convert the pull request", async () => {
		github((route) =>
			route.startsWith("POST /graphql")
				? Response.json({ data: null, errors: [{ message: "Resource not accessible" }] })
				: open(false)(route),
		);
		await expect(port().propose({ ...input, draft: true, convert: true })).rejects.toThrow(
			"could not make the pull request a draft",
		);
	});
});
