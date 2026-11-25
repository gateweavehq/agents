/**
 * An agent's edits to the files that decide whether its own checks pass (AGT-167). The pull
 * request stays a draft and its section lists the paths; adding a test is not flagged.
 */
import type { PullRequestOutcome } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import { type ChangedFile, oracleKind, reviewOracles } from "../src/oracles";
import { pullRequestTools } from "../src/pull-requests";
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

/** `open_pull_request` with no checks set, over a branch that changes `files`. */
function setup(files: ChangedFile[], texts: Record<string, string> = {}, unreadable = false) {
	const proposed: { body: string; draft?: boolean }[] = [];
	const tools = pullRequestTools({
		sandbox: new MemorySandbox(),
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
				return {
					edits: await reviewOracles(files, async (path, side) => texts[`${side}:${path}`] ?? null),
				};
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
	])("%s is a %s", (path, kind) => {
		expect(oracleKind(path)).toBe(kind);
	});
	it.each(["src/cart.ts", "README.md", "docs/testing.md", "src/latest.ts"])(
		"%s is not one",
		(path) => {
			expect(oracleKind(path)).toBeNull();
		},
	);
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
			{ path: "src/cart.ts", status: "modified" },
		]);
		const outcome = await call();
		expect(outcome.draft).toBeUndefined();
		expect(proposed[0]?.draft).toBeUndefined();
		expect(proposed[0]?.body).not.toContain("Checks run by Gateweave");
	});
	it("opens a draft when it cannot tell what the branch changes", async () => {
		const { call, proposed } = setup([], {}, true);
		expect((await call()).draft).toBe(true);
		expect(proposed[0]?.draft).toBe(true);
		expect(proposed[0]?.body).toContain("could not tell whether");
	});
});
