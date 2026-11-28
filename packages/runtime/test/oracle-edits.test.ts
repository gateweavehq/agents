/**
 * An agent's edits to the files that decide whether its own checks pass. The pull
 * request stays a draft and its section lists the paths; adding a test is not flagged.
 */
import type { GitHubApp } from "@gateweave/agents-github";
import type { PullRequestOutcome } from "@gateweave/agents-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ChangedFile,
	MANIFESTS_LIMIT,
	namesFile,
	oracleKind,
	reviewOracles,
} from "../src/oracles";
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
	afterReview: () => void = () => {},
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
				const review = await reviewOracles(
					files,
					async (path, side) => texts[`${side}:${path}`] ?? null,
					async () => ({
						paths: Object.keys(texts)
							.filter((key) => key.startsWith("base:") && key.endsWith("package.json"))
							.map((key) => key.slice("base:".length)),
						complete: true,
					}),
				);
				afterReview();
				return review;
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
		call: (abortSignal?: AbortSignal) =>
			execute({ title: "Fix", body: "Done." }, {
				toolCallId: "c",
				messages: [],
				...(abortSignal ? { abortSignal } : {}),
			} as {
				toolCallId: string;
				messages: [];
			}),
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
		["Makefile", "check script"],
		["services/api/Makefile", "check script"],
		["justfile", "check script"],
		["tools/justfile", "check script"],
		["Taskfile.yml", "check script"],
		["apps/web/Taskfile.yml", "check script"],
		["noxfile.py", "check script"],
		["makefile", "check script"],
		["services/api/makefile", "check script"],
		["GNUmakefile", "check script"],
		["services/api/GNUmakefile", "check script"],
		["Justfile", "check script"],
		["tools/Justfile", "check script"],
		["Taskfile.yaml", "check script"],
		["apps/web/Taskfile.yaml", "check script"],
		["services/api/noxfile.py", "check script"],
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
		"docs/Makefile.md",
		"src/justfile.ts",
		"src/Taskfile.yaml.ts",
		"src/mynoxfile.py",
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
	it.each([
		[
			"a jest key changed",
			{ jest: { testPathIgnorePatterns: [] } },
			{ jest: { testPathIgnorePatterns: ["cart"] } },
		],
		[
			"eslintConfig changed",
			{ eslintConfig: { rules: { "no-undef": "error" } } },
			{ eslintConfig: { rules: { "no-undef": "off" } } },
		],
		["an unknown key added", {}, { checkMagic: { skip: true } }],
		["a prettier key removed", { prettier: { semi: false } }, {}],
	])("flags a package.json when %s", async (_name, before, after) => {
		const { call, proposed } = setup([{ path: "package.json", status: "modified" }], {
			"base:package.json": JSON.stringify({ name: "x", scripts: { test: "jest" }, ...before }),
			"head:package.json": JSON.stringify({ name: "x", scripts: { test: "jest" }, ...after }),
		});
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.body).toContain("- `package.json`: modified (package script)");
	});
	it("does not flag a package.json whose dependency version, other listed keys or key order changed", async () => {
		const { call, proposed } = setup([{ path: "package.json", status: "modified" }], {
			"base:package.json": JSON.stringify({
				name: "x",
				version: "1.0.0",
				dependencies: { zod: "1.0.0" },
				jest: { a: 1, b: 2 },
			}),
			"head:package.json": JSON.stringify({
				jest: { b: 2, a: 1 },
				dependencies: { zod: "1.1.0" },
				version: "1.0.1",
				name: "x",
				engines: { node: ">=22" },
			}),
		});
		const outcome = await call();
		expect(outcome.draft).toBeUndefined();
		expect(proposed[0]?.draft).toBeUndefined();
	});
	it("does not create, update or convert a pull request once the turn is stopped during the review", async () => {
		const stopped = new AbortController();
		const { call, proposed } = setup(
			[{ path: "test/cart.test.ts", status: "modified" }],
			{},
			false,
			[],
			() => stopped.abort(new Error("stopped")),
		);
		await expect(call(stopped.signal)).rejects.toThrow("stopped");
		expect(proposed).toEqual([]);
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
	it.each([
		["Makefile", "modified"],
		["justfile", "modified"],
		["Taskfile.yml", "modified"],
		["noxfile.py", "modified"],
		["makefile", "modified"],
		["GNUmakefile", "modified"],
		["Justfile", "modified"],
		["Taskfile.yaml", "modified"],
		["Makefile", "removed"],
		["justfile", "removed"],
		["Taskfile.yml", "removed"],
		["noxfile.py", "removed"],
	])("opens a draft for a %s that is %s", async (path, status) => {
		const { call, proposed } = setup([{ path, status }]);
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain(
			`- \`${path}\`: ${status === "removed" ? "deleted" : "modified"} (check script)`,
		);
	});
	it("opens a draft for a script a package.json at the base names, and not for a glob's file", async () => {
		const texts = {
			"base:package.json": manifest({
				lint: "sh -c 'cd tools && node lint.mjs'",
				t: "eslint 'src/**/*.ts'",
			}),
		};
		const named = setup([{ path: "tools/lint.mjs", status: "modified" }], texts);
		expect((await named.call()).draft).toBe(true);
		expect(named.proposed[0]?.body).toContain("- `tools/lint.mjs`: modified (check script)");
		const source = setup([{ path: "src/cart.ts", status: "modified" }], texts);
		expect((await source.call()).draft).toBeUndefined();
		expect(source.proposed[0]?.draft).toBeUndefined();
	});
	it("opens a draft when it cannot tell what the branch changes", async () => {
		const { call, proposed } = setup([], {}, true);
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain("could not tell whether");
	});
});

/** A `package.json` text whose scripts are these commands. */
const scriptsOf = (...scripts: string[]) =>
	JSON.stringify({ scripts: Object.fromEntries(scripts.map((script, i) => [`s${i}`, script])) });

/** The tree of a base that holds these `package.json` files (path to text), as the review lists it. */
const treeOf = (manifests: Record<string, string>) => async () => ({
	paths: Object.keys(manifests),
	complete: true,
});

/**
 * The review of a branch that modifies `paths` (or has them in `status`), when the base holds
 * these `package.json` files.
 */
function review(
	paths: string[],
	manifests: Record<string, string>,
	status: ChangedFile["status"] = "modified",
) {
	const read = vi.fn(async (path: string) => manifests[path] ?? null);
	const list = vi.fn(treeOf(manifests));
	return {
		list,
		read,
		result: reviewOracles(
			paths.map((path) => ({ path, status })),
			read,
			list,
		),
	};
}
const checkScripts = (...paths: string[]) => ({
	edits: paths.map((path) => ({ path, change: "modified", kind: "check script" })),
});
const unverified = expect.objectContaining({ unverified: expect.any(String) });

describe("the files a package.json script names", () => {
	it("flags a modified or deleted file that a package.json at the base names", async () => {
		const manifests = {
			"package.json": scriptsOf("node tools/lint.mjs --strict", "tsc -b"),
			"apps/web/package.json": scriptsOf("bash ./ci/check.sh"),
		};
		expect(
			await reviewOracles(
				[
					{ path: "tools/lint.mjs", status: "modified" },
					{ path: "apps/web/ci/check.sh", status: "removed" },
				],
				async (path) => manifests[path as keyof typeof manifests] ?? null,
				treeOf(manifests),
			),
		).toEqual({
			edits: [
				{ path: "apps/web/ci/check.sh", change: "deleted", kind: "check script" },
				{ path: "tools/lint.mjs", change: "modified", kind: "check script" },
			],
		});
	});
	it("flags the old path of a renamed file that a script names", async () => {
		expect(
			await reviewOracles(
				[{ path: "tools/check.mjs", status: "renamed", previousPath: "tools/lint.mjs" }],
				async () => scriptsOf("node tools/lint.mjs"),
				treeOf({ "package.json": "" }),
			),
		).toEqual({ edits: [{ path: "tools/lint.mjs", change: "renamed", kind: "check script" }] });
	});
	it("names a file by the end of its path, at a path boundary", async () => {
		const manifests = {
			"package.json": scriptsOf("node tools/lint.mjs && node ./x.mjs && ../y.mjs"),
		};
		const flagged = ["packages/a/tools/lint.mjs", "src/x.mjs", "tools/lint.mjs", "x.mjs", "y.mjs"];
		const left = [
			"xtools/lint.mjs",
			"lint.mjs",
			"src/mylint.mjs",
			"tools/lint.mjs.bak",
			"src/z.mjs",
		];
		expect(await review([...left, ...flagged], manifests).result).toEqual(checkScripts(...flagged));
	});
	it("leaves a file no package.json names, and a file that is added", async () => {
		const manifests = { "package.json": scriptsOf("node tools/lint.mjs") };
		expect(await review(["tools/other.mjs", "src/cart.ts"], manifests).result).toEqual({
			edits: [],
		});
		expect(await review(["tools/lint.mjs"], manifests, "added").result).toEqual({ edits: [] });
	});
	it("does not look at the directory a script runs in", async () => {
		const manifests = { "package.json": scriptsOf("cd tools && node lint.mjs") };
		// `lint.mjs` names every `lint.mjs`, wherever the `cd` went.
		expect(await review(["tools/lint.mjs", "lint.mjs"], manifests).result).toEqual(
			checkScripts("lint.mjs", "tools/lint.mjs"),
		);
	});
	it.each([
		"sh -c 'cd tools && node lint.mjs'",
		'bash -c "cd tools && node lint.mjs"',
		"pnpm --dir tools exec node lint.mjs",
		"(cd tools && node lint.mjs)",
	])("names the file in `%s`", async (script) => {
		expect(await review(["tools/lint.mjs"], { "package.json": scriptsOf(script) }).result).toEqual(
			checkScripts("tools/lint.mjs"),
		);
	});
	it("takes a manifest outside the folders of the changed file", async () => {
		const manifests = {
			"package.json": scriptsOf("tsc -b"),
			"apps/web/package.json": scriptsOf("cd ../../tools && node lint.mjs"),
		};
		expect(await review(["tools/lint.mjs"], manifests).result).toEqual(
			checkScripts("tools/lint.mjs"),
		);
	});
	it("does not take a glob over source files for a check script", async () => {
		const manifests = {
			"package.json": scriptsOf("eslint 'src/**/*.ts'", "node tools/{a,b}.mjs"),
		};
		const { result } = review(["src/cart.ts", "src/deep/cart.ts", "tools/a.mjs"], manifests);
		expect(await result).toEqual({ edits: [] });
	});
	it.each([
		"node $TOOLS/lint.mjs",
		"node $NAME.mjs",
		`node \${DIR}/lint.mjs`,
		"node tools/l?nt.mjs",
		"node tools/[l]int.mjs",
		"node tools/*.mjs",
	])("names nothing with `%s`, and does not make the review unverified", async (script) => {
		expect(
			await review(["tools/lint.mjs", "lint.mjs"], { "package.json": scriptsOf(script) }).result,
		).toEqual({ edits: [] });
	});
	it("reads the tree once, and not at all when no file needs it", async () => {
		const manifests = { "package.json": scriptsOf("node tools/lint.mjs") };
		const some = review(["tools/lint.mjs", "src/a.ts", "src/b.ts"], manifests);
		await some.result;
		expect(some.list).toHaveBeenCalledTimes(1);
		expect(some.read).toHaveBeenCalledTimes(1);
		const none = review(["test/a.test.ts", ".github/workflows/ci.yml", "package.json"], manifests);
		await none.result;
		expect(none.list).not.toHaveBeenCalled();
	});
});

describe("a base tree and its package.json files that cannot be read", () => {
	const manifest = scriptsOf("node tools/lint.mjs");
	const files: ChangedFile[] = [{ path: "tools/lint.mjs", status: "modified" }];

	it("is unverified when the tree cannot be read", async () => {
		expect(
			await reviewOracles(
				files,
				async () => manifest,
				async () => {
					throw new Error("403");
				},
			),
		).toEqual({ unverified: "the base's file tree could not be read" });
	});
	it("is unverified when the tree is cut short", async () => {
		expect(
			await reviewOracles(
				files,
				async () => manifest,
				async () => ({ paths: ["package.json"], complete: false }),
			),
		).toEqual({ unverified: "the base's file tree is too large to be listed in full" });
	});
	it("is unverified when a package.json the tree lists cannot be read, and clean when it is gone", async () => {
		expect(
			await reviewOracles(
				files,
				async () => {
					throw new Error("403");
				},
				async () => ({ paths: ["apps/web/package.json"], complete: true }),
			),
		).toEqual({ unverified: "the base's apps/web/package.json could not be read" });
		expect(
			await reviewOracles(
				files,
				async () => null,
				async () => ({ paths: ["package.json"], complete: true }),
			),
		).toEqual({ edits: [] });
	});
	it("reads up to 40 package.json files and is unverified for more", async () => {
		const many = (count: number) =>
			Object.fromEntries(
				Array.from({ length: count }, (_, index) => [
					`packages/p${index}/package.json`,
					index === 0 ? manifest : scriptsOf("tsc -b"),
				]),
			);
		expect(await review(["tools/lint.mjs"], many(MANIFESTS_LIMIT)).result).toEqual(
			checkScripts("tools/lint.mjs"),
		);
		const over = review(["tools/lint.mjs"], many(MANIFESTS_LIMIT + 1));
		expect(await over.result).toEqual({
			unverified: "the base has 41 package.json files, and more than 40 are not read",
		});
		expect(over.read).not.toHaveBeenCalled();
	});
	it("is unverified for a file that no script names too, since that was not shown", async () => {
		expect(
			await reviewOracles(
				[{ path: "src/cart.ts", status: "modified" }],
				async () => null,
				async () => {
					throw new Error("500");
				},
			),
		).toEqual(unverified);
	});
	it.each([
		["base", "{ not json", JSON.stringify({ scripts: {} })],
		["branch", JSON.stringify({ scripts: {} }), "[1]"],
	])(
		"is unverified when a modified package.json cannot be parsed at the %s",
		async (side, before, after) => {
			expect(
				await reviewOracles(
					[{ path: "apps/web/package.json", status: "modified" }],
					async (_path, from) => (from === "base" ? before : after),
					async () => ({ paths: [], complete: true }),
				),
			).toEqual({ unverified: `apps/web/package.json could not be parsed at the ${side}` });
		},
	);
	it("takes a package.json that cannot be read, at the base or the branch, as changed", async () => {
		expect(
			await reviewOracles(
				[{ path: "package.json", status: "modified" }],
				async (_path, side) => {
					if (side === "head") throw new Error("403");
					return JSON.stringify({ scripts: { test: "vitest" } });
				},
				async () => ({ paths: [], complete: true }),
			),
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

	const sha = (character: string) => character.repeat(40);
	/**
	 * A repository whose branch is at `head()` (read at each request), that differs from the
	 * default branch by `files`, whose base commit has a tree that holds `tree` (a number for the
	 * answer's status when it fails), and where `contents` answers a read by its path and ref.
	 */
	const branch = (
		files: object[],
		options: {
			head?: () => string;
			tree?: string[] | number;
			truncated?: boolean;
			contents?: (path: string, ref: string) => Response;
		} = {},
	) => {
		const { head = () => sha("a"), tree = [], truncated = false, contents } = options;
		return github((route) => {
			if (route.includes("/git/ref/heads/")) return Response.json({ object: { sha: head() } });
			if (route.includes("/compare/")) {
				return Response.json({ merge_base_commit: { sha: sha("e") }, files });
			}
			if (route.includes("/git/commits/")) {
				return Response.json({ tree: { sha: sha("f") }, parents: [] });
			}
			if (route.includes("/git/trees/")) {
				return typeof tree === "number"
					? Response.json({ message: "no" }, { status: tree })
					: Response.json({
							truncated,
							tree: tree.map((path) => ({
								path,
								mode: "100644",
								type: "blob",
								sha: sha("1"),
								size: 10,
							})),
						});
			}
			const read = /\/contents\/(.+)\?ref=(.+)$/.exec(route);
			if (read !== null && contents !== undefined) {
				return contents(decodeURIComponent(read[1] ?? ""), decodeURIComponent(read[2] ?? ""));
			}
			return Response.json({ message: "Not Found" }, { status: 404 });
		});
	};
	const scripts = (...commands: string[]) =>
		new Response(
			JSON.stringify({ scripts: Object.fromEntries(commands.map((c, index) => [`s${index}`, c])) }),
		);

	it("is unverified when the comparison is at GitHub's limit of files", async () => {
		const files = Array.from({ length: 300 }, (_, index) => ({
			filename: `src/f${index}.ts`,
			status: "modified",
		}));
		const routes = branch(files);
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the branch changes more files than GitHub's comparison lists",
		});
		// The files come with the first page of the comparison, and the other pages hold commits.
		expect(routes).toEqual([
			"GET /repos/acme/site/git/ref/heads/gateweave/c-1",
			`GET /repos/acme/site/compare/main...${sha("a")}?per_page=1&page=1`,
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
	it("is unverified when the branch is not on GitHub", async () => {
		github(() => Response.json({ message: "Not Found" }, { status: 404 }));
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the branch is not on GitHub",
		});
	});
	it("reads a package.json at the merge base and at the commit the comparison saw", async () => {
		const routes = branch([{ filename: "package.json", status: "modified" }], {
			contents: (_path, ref) => scripts(ref === sha("e") ? "vitest" : "true"),
		});
		expect(await port().review?.("gateweave/c-1")).toEqual({
			edits: [{ path: "package.json", change: "modified", kind: "package script" }],
		});
		expect(routes).toContain(`GET /repos/acme/site/contents/package.json?ref=${sha("e")}`);
		expect(routes).toContain(`GET /repos/acme/site/contents/package.json?ref=${sha("a")}`);
	});
	it("compares and reads at one commit when the branch moves meanwhile", async () => {
		// The branch is at `a` when it is looked up, and `b` at every look after.
		const heads = [sha("a")];
		const routes = branch([{ filename: "package.json", status: "modified" }], {
			head: () => heads.shift() ?? sha("b"),
			// The base and the commit the comparison saw have the same scripts; the branch's name, or
			// the commit it moved to, would give others.
			contents: (_path, ref) => scripts(ref === sha("e") || ref === sha("a") ? "vitest" : "true"),
		});
		expect(await port().review?.("gateweave/c-1")).toEqual({ edits: [] });
		expect(routes.some((route) => route.includes(sha("b")))).toBe(false);
		expect(routes).toContain(`GET /repos/acme/site/compare/main...${sha("a")}?per_page=1&page=1`);
		expect(routes).toContain(`GET /repos/acme/site/contents/package.json?ref=${sha("a")}`);
	});
	it("reads the base's tree once, from the merge base, for its package.json files", async () => {
		const routes = branch([{ filename: "tools/lint.mjs", status: "modified" }], {
			tree: ["package.json", "src/cart.ts", "apps/web/package.json", "docs/package.json.md"],
			contents: (path) =>
				path === "apps/web/package.json"
					? scripts("cd ../../tools && node lint.mjs")
					: scripts("tsc"),
		});
		expect(await port().review?.("gateweave/c-1")).toEqual({
			edits: [{ path: "tools/lint.mjs", change: "modified", kind: "check script" }],
		});
		expect(routes).toEqual([
			"GET /repos/acme/site/git/ref/heads/gateweave/c-1",
			`GET /repos/acme/site/compare/main...${sha("a")}?per_page=1&page=1`,
			`GET /repos/acme/site/git/commits/${sha("e")}`,
			`GET /repos/acme/site/git/trees/${sha("f")}?recursive=1`,
			`GET /repos/acme/site/contents/package.json?ref=${sha("e")}`,
			`GET /repos/acme/site/contents/apps/web/package.json?ref=${sha("e")}`,
		]);
	});
	it("is unverified when the base's tree is denied or cut short", async () => {
		const files = [{ filename: "src/cart.ts", status: "modified" }];
		branch(files, { tree: 403 });
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the base's file tree could not be read",
		});
		branch(files, { tree: ["package.json"], truncated: true });
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the base's file tree is too large to be listed in full",
		});
	});
	it("is unverified when a package.json of the base is denied, and clean when it is not there", async () => {
		const files = [{ filename: "tools/lint.mjs", status: "modified" }];
		branch(files, {
			tree: ["package.json"],
			contents: () => Response.json({ message: "no" }, { status: 403 }),
		});
		expect(await port().review?.("gateweave/c-1")).toEqual({
			unverified: "the base's package.json could not be read",
		});
		branch(files, { tree: ["package.json"] });
		expect(await port().review?.("gateweave/c-1")).toEqual({ edits: [] });
	});
	it("flags a file that `sh -c 'cd tools && node lint.mjs'` names, from the base's package.json", async () => {
		branch([{ filename: "tools/lint.mjs", status: "modified" }], {
			tree: ["package.json"],
			contents: () => scripts("sh -c 'cd tools && node lint.mjs'"),
		});
		expect(await port().review?.("gateweave/c-1")).toEqual({
			edits: [{ path: "tools/lint.mjs", change: "modified", kind: "check script" }],
		});
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

describe("namesFile", () => {
	it("does not let a newline join another command to the runner", () => {
		expect(namesFile("vitest run test/b.test.ts\necho test/a.test.ts", "test/a.test.ts")).toBe(
			false,
		);
	});

	it("does not take a redirection target for a runner argument", () => {
		expect(namesFile("echo > vitest run test/a.test.ts; exit 1", "test/a.test.ts")).toBe(false);
		expect(namesFile("vitest run > test/a.test.ts", "test/a.test.ts")).toBe(false);
	});

	it("does not treat an escaped quote inside double quotes as the end of the word", () => {
		expect(namesFile('vitest run "test/\\" test/a.test.ts"', "test/a.test.ts")).toBe(false);
	});

	it("does not treat a quoted command name as an environment assignment", () => {
		expect(namesFile('"X=1" vitest run test/a.test.ts', "test/a.test.ts")).toBe(false);
	});

	it("recognizes node --test only before the end of its options", () => {
		expect(namesFile("node -- --test test/a.test.ts", "test/a.test.ts")).toBe(false);
		expect(namesFile("node --import tsx --test test/a.test.ts", "test/a.test.ts")).toBe(true);
	});

	it("accepts npm exec's separator before the runner", () => {
		expect(namesFile("npm exec -- vitest run test/a.test.ts", "test/a.test.ts")).toBe(true);
	});

	it("still accepts a runner whose output is redirected", () => {
		for (const command of [
			"vitest run test/a.test.ts >proof.out",
			"vitest run test/a.test.ts 2>proof.err",
			"vitest run test/a.test.ts 2>&1",
		]) {
			expect(namesFile(command, "test/a.test.ts")).toBe(true);
		}
	});

	it("keeps command separators inside a parameter expansion", () => {
		expect(namesFile(`echo \${X:-; vitest run test/a.test.ts }; exit 1`, "test/a.test.ts")).toBe(
			false,
		);
		expect(namesFile(`FOO=\${BAR} vitest run test/a.test.ts`, "test/a.test.ts")).toBe(true);
	});

	it("removes an escaped newline without separating the word", () => {
		expect(namesFile("vitest run test\\\n/a.test.ts", "test/a.test.ts")).toBe(true);
		expect(namesFile("vitest run \\\ntest/a.test.ts", "test/a.test.ts")).toBe(true);
	});

	it("does not treat a runner option's value as a test operand", () => {
		expect(namesFile("vitest run --exclude test/a.test.ts test/b.test.ts", "test/a.test.ts")).toBe(
			false,
		);
		expect(namesFile("vitest run --exclude test/a.test.ts test/b.test.ts", "test/b.test.ts")).toBe(
			true,
		);
		expect(
			namesFile(
				"node --test --test-reporter spec --test-reporter-destination test/a.test.js test/b.test.js",
				"test/a.test.js",
			),
		).toBe(false);
		expect(
			namesFile(
				"node --test --test-reporter spec --test-reporter-destination test/a.test.js test/b.test.js",
				"test/b.test.js",
			),
		).toBe(true);
	});
});
