// Every row here is made up. The real replay set is read only from --set, never from this folder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	ask,
	checkFamilies,
	checkReviewerBoundary,
	parseEngine,
	reviewerLaunch,
} from "./engines.mjs";
import { cleanHistory, fixDiff, fixPatch, git } from "./history.mjs";
import { commandLine } from "./launcher.mjs";
import { loadModel } from "./model.mjs";
import { HIDDEN_KEYS, parseFindings, reviewPrompt, runReplay, score, splitSet } from "./replay.mjs";
import { main } from "./run.mjs";

const run = promisify(execFile);
const model = await loadModel();
const RUN = fileURLToPath(new URL("./run.mjs", import.meta.url));

let root;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "replay-test-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

const finding = (title, extra = {}) => ({
	severity: "high",
	path: "src/calc.js",
	line: 3,
	title,
	failingCase: `Input 0 gives ${title}`,
	...extra,
});

const row = (n, extra = {}) => ({
	row: n,
	repo: "widgets",
	pr: 10 + n,
	pre_fix: "abcdef1",
	fix: "1234567",
	also_fix: null,
	criteria: ["Division by zero is refused"],
	files: ["src/calc.js"],
	defect: `Made-up defect ${n}: divide returns NaN`,
	found_by: "nobody",
	...extra,
});

/** A repository of four commits: a base, a pull request commit, `pre_fix` and a fix. */
let sources = 0;
async function fixtureRepo() {
	const dir = join(root, `widgets-source-${++sources}`);
	await mkdir(dir, { recursive: true });
	await git(dir, ["init", "--quiet", "--initial-branch=main"]);
	const commit = async (file, text, message) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", file), text);
		await git(dir, ["add", "-A"]);
		await git(dir, ["commit", "--quiet", "-m", message]);
		return (await git(dir, ["rev-parse", "HEAD"])).trim();
	};
	const base = await commit("calc.js", "export const half = (n) => n / 2;\n", "base");
	await commit(
		"calc.js",
		"export const half = (n) => n / 2;\nexport const inv = (n) => 1 / n;\n",
		"pr",
	);
	const preFix = await commit("notes.md", "a note\n", "pre-fix head");
	const fix = await commit("calc.js", "export const inv = (n) => (n === 0 ? 0 : 1 / n);\n", "fix");
	return { dir, base, preFix, fix };
}

test("the reviewer's view holds none of the answers", () => {
	const [entry] = splitSet([row(1)]);
	assert.deepEqual(Object.keys(entry.reviewer).sort(), ["criteria", "id", "pr", "pre_fix", "repo"]);
	for (const key of HIDDEN_KEYS) {
		assert.equal(key in entry.reviewer, false);
		assert.equal(key in entry.judge, true);
	}
	assert.equal(JSON.stringify(entry.reviewer).includes("Made-up defect"), false);
});

test("the reviewer's input and working folder hold no answer and no commit after pre_fix", async () => {
	const repo = await fixtureRepo();
	const out = join(root, "out-clean");
	const source = { cloneUrl: () => repo.dir, baseOf: async () => repo.base };
	const seen = [];
	const deps = {
		async prepare(view, dir) {
			seen.push({ view });
			const made = await cleanHistory({
				source,
				cacheDir: join(out, "cache"),
				dir,
				row: view,
			});
			return {
				diff: made.diff,
				fixDiff: (judge) => fixDiff(made.mirror, made.preFix, repo.fix, judge.also_fix),
			};
		},
		async review(prompt, dir) {
			const commits = (await git(dir, ["rev-list", "--all"])).trim().split("\n");
			const objects = await git(dir, ["cat-file", "--batch-check", "--batch-all-objects"]);
			seen.push({ prompt, commits, hasFix: objects.includes(repo.fix) });
			seen.push({ notes: await readFile(join(dir, "src", "notes.md"), "utf8") });
			seen.push({ calc: await readFile(join(dir, "src", "calc.js"), "utf8") });
			return JSON.stringify({ findings: [finding("zero")] });
		},
		judge: async (prompt) => {
			seen.push({ judgePrompt: prompt });
			return JSON.stringify({ verdicts: [{ index: 0, verdict: "hit", reason: "r" }] });
		},
	};
	await runReplay({
		model,
		setText: JSON.stringify([row(1, { pre_fix: repo.preFix, fix: repo.fix })]),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps,
	});

	const review = seen.find((item) => item.prompt);
	assert.equal(review.commits.length, 2);
	assert.equal(review.hasFix, false);
	assert.equal(seen.find((item) => item.notes).notes.trim(), "a note");
	// The fix changed calc.js: the folder still holds the version before it.
	assert.doesNotMatch(seen.find((item) => item.calc).calc, /n === 0/);
	assert.match(review.prompt, /Division by zero is refused/);
	assert.match(review.prompt, /\+export const inv/);
	// The identifiers the reviewer is promised, and the product's schema for what it replies.
	assert.match(review.prompt, /pull request 11 of widgets, at the reviewed head /);
	assert.ok(review.prompt.includes(repo.preFix));
	assert.match(review.prompt, /"maxItems": 20/);
	assert.match(review.prompt, /"failingCase"/);
	for (const hidden of ["Made-up defect", repo.fix, "found_by", "nobody"]) {
		assert.equal(review.prompt.includes(hidden), false, hidden);
	}
	// The judge, and only the judge, sees the defect and the fix.
	const judgePrompt = seen.find((item) => item.judgePrompt).judgePrompt;
	assert.match(judgePrompt, /Made-up defect 1/);
	assert.match(judgePrompt, /n === 0 \? 0/);
});

test("a judge of the reviewer's family is refused", async () => {
	const codex = parseEngine("codex:a", "--reviewer");
	assert.throws(
		() => checkFamilies(codex, parseEngine("openai:b", "--judge")),
		/another model family/,
	);
	assert.throws(
		() =>
			checkFamilies(parseEngine("claude:a", "--reviewer"), parseEngine("anthropic:b", "--judge")),
		/another model family/,
	);
	checkFamilies(codex, parseEngine("claude:b", "--judge"));
	checkFamilies(parseEngine("anthropic:a", "--reviewer"), parseEngine("codex:b", "--judge"));
	assert.throws(() => parseEngine("gemini:x", "--judge"), /--judge must be/);

	const out = join(root, "out-refused");
	await assert.rejects(
		run(process.execPath, [
			RUN,
			"--set",
			"none.json",
			"--reviewer",
			"codex:a",
			"--judge",
			"openai:b",
			"--out",
			out,
		]),
		(error) => error.code === 2 && /another model family/.test(error.stderr),
	);
	await assert.rejects(readFile(join(out, "results.json")), { code: "ENOENT" });
});

/** Stand-ins that answer from a table of verdicts by row, with nothing to clone. */
function standIns(table, calls = []) {
	return {
		async prepare(view) {
			calls.push(`prepare ${view.id}`);
			if (table[view.id] === "clone fails") throw new Error("clone failed");
			return { diff: "diff --git a/x b/x\n", fixDiff: async () => "a fix" };
		},
		async review(prompt) {
			const id = /ROW (\d+)/.exec(prompt)?.[1];
			return JSON.stringify({
				findings: (table[id] ?? []).map((_verdict, i) => finding(`f${id}-${i}`)),
			});
		},
		async judge(prompt) {
			const id = /f(\d+)-0/.exec(prompt)?.[1];
			const verdicts = table[id].map((verdict, index) => ({ index, verdict, reason: "r" }));
			return `Here you go:\n${JSON.stringify({ verdicts })}`;
		},
	};
}

// The made-up reviewer reads which row it is on from the criteria.
const setOf = (n) =>
	JSON.stringify(Array.from({ length: n }, (_, i) => row(i + 1, { criteria: [`ROW ${i + 1}`] })));

test("scoring is code: totals, shares and the pass or fail line", async () => {
	const table = {
		1: ["hit", "real", "false"],
		2: ["unsure", "unsure"],
		3: ["real", "hit"],
		4: [],
	};
	const out = join(root, "out-score");
	const { totals } = await runReplay({
		model,
		setText: setOf(4),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps: standIns(table),
	});
	assert.equal(totals.hits, 2);
	assert.equal(totals.findings, 7);
	assert.equal(totals.real, 4);
	assert.equal(totals.unsure, 2);
	assert.equal(totals.false, 1);
	assert.equal(totals.realShare, 4 / 7);
	assert.equal(totals.lenientShare, 6 / 7);
	assert.equal(totals.topPrecision, 4 / 7);
	// The real bar is 12 of 35, so 2 hits fail it.
	assert.equal(totals.pass, false);
	assert.match(await readFile(join(out, "summary.md"), "utf8"), /^Gate: FAIL$/m);

	const saved = Object.values(JSON.parse(await readFile(join(out, "results.json"), "utf8")).rows);
	const barOf = (hits, realShare) => ({
		...model,
		REVIEW_GATE: { bar: { rows: 4, hits, realShare } },
	});
	assert.equal(score(barOf(2, 0.5), saved).pass, true);
	assert.equal(score(barOf(2, 0.6), saved).pass, false);
	assert.equal(score(barOf(3, 0.5), saved).pass, false);
	const summary = await readFile(join(out, "summary.md"), "utf8");
	assert.match(summary, /Real share: 57\.1%, 4 real of 7 findings, unsure counted as not real/);
	assert.match(summary, /Lenient share, unsure counted as real: 85\.7%/);
	assert.match(summary, /Not the full set: 4 rows were run, the gate is defined on 35/);
});

test("a passing run says PASS", async () => {
	const low = { ...model, REVIEW_GATE: { bar: { rows: 2, hits: 2, realShare: 0.5 } } };
	const out = join(root, "out-pass");
	const { totals } = await runReplay({
		model: low,
		setText: setOf(2),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps: standIns({ 1: ["hit", "false"], 2: ["hit"] }),
	});
	assert.equal(totals.pass, true);
	const summary = await readFile(join(out, "summary.md"), "utf8");
	assert.match(summary, /^Gate: PASS$/m);
	assert.doesNotMatch(summary, /Not the full set/);
});

test("a row that fails is a miss, is listed, and runs again on a resume", async () => {
	const out = join(root, "out-resume");
	const calls = [];
	const first = await runReplay({
		model,
		setText: setOf(3),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps: standIns({ 1: ["hit"], 2: "clone fails", 3: ["real"] }, calls),
	});
	assert.equal(first.totals.rows, 3);
	assert.equal(first.totals.hits, 1);
	assert.equal(first.rows[1].status, "failed");
	assert.deepEqual(first.rows[1].findings, []);
	assert.match(
		await readFile(join(out, "summary.md"), "utf8"),
		/Row 2 \(widgets#12\): clone failed/,
	);
	assert.deepEqual(calls, ["prepare 1", "prepare 2", "prepare 3"]);

	const again = [];
	const resumed = await runReplay({
		model,
		setText: setOf(3),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps: standIns({ 1: ["hit"], 2: ["hit", "false"], 3: ["real"] }, again),
	});
	assert.deepEqual(again, ["prepare 2"]);
	assert.equal(resumed.totals.hits, 2);
	assert.equal(resumed.totals.findings, 4);
	assert.match(
		await readFile(join(out, "summary.md"), "utf8"),
		/Rows that failed to run, counted as misses\n\nNone\./,
	);

	await assert.rejects(
		runReplay({
			model,
			setText: setOf(3),
			reviewer: "codex:other",
			judge: "claude:m",
			out,
			deps: standIns({}),
		}),
		/use another --out/,
	);
});

test("a submission the schema refuses fails the row, as the product refuses it whole", async () => {
	// One bad finding costs the whole submission, as it does at the submit_review tool.
	assert.throws(
		() =>
			parseFindings(
				model,
				JSON.stringify({ findings: [finding("ok"), { severity: "high", title: "no path" }] }),
			),
		/not a valid submit_review input: findings\.1\.path/,
	);
	const many = Array.from({ length: 21 }, (_, i) => finding(`t${i}`, { line: i + 1 }));
	assert.throws(
		() => parseFindings(model, JSON.stringify({ findings: many })),
		/not a valid submit_review input/,
	);
	// An omitted side and criterion take the schema's defaults.
	const [only] = parseFindings(model, JSON.stringify({ findings: [finding("ok")] }));
	assert.equal(only.side, "RIGHT");
	assert.equal(only.criterion, null);

	const out = join(root, "out-lenient");
	const deps = {
		prepare: async () => ({ diff: "d", fixDiff: async () => "f" }),
		review: async () =>
			JSON.stringify({ findings: [finding("ok"), { severity: "high", title: "no path" }] }),
		judge: async () => JSON.stringify({ verdicts: [] }),
	};
	const { rows } = await runReplay({
		model,
		setText: setOf(1),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps,
	});
	assert.equal(rows[0].status, "failed");
	assert.match(rows[0].error, /not a valid submit_review input/);
	assert.deepEqual(rows[0].findings, []);
});

test("a missing verdict is unsure", async () => {
	const out = join(root, "out-unsure");
	const deps = {
		prepare: async () => ({ diff: "d", fixDiff: async () => "f" }),
		review: async () => JSON.stringify({ findings: [finding("ok"), finding("two", { line: 9 })] }),
		judge: async () => JSON.stringify({ verdicts: [{ index: 0, verdict: "real", reason: "r" }] }),
	};
	const { rows } = await runReplay({
		model,
		setText: setOf(1),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps,
	});
	assert.deepEqual(
		rows[0].findings.map((f) => f.verdict),
		["real", "unsure"],
	);
});

test("the reviewer's prompt names the pull request and carries the product's schema", () => {
	const [entry] = splitSet([row(1)]);
	const prompt = reviewPrompt(model, entry.reviewer, "diff --git a/x b/x\n");
	assert.match(prompt, /pull request 11 of widgets, at the reviewed head abcdef1\./);
	assert.ok(prompt.includes(JSON.stringify(model.reviewJsonSchema, null, 2)));
	assert.ok(prompt.startsWith(model.REVIEW_INSTRUCTIONS));
	assert.equal(prompt.includes("Made-up defect"), false);
});

test("a finding on the diff outranks one off it, so the top five are chosen on membership", async () => {
	const diff = `diff --git a/src/calc.js b/src/calc.js
--- a/src/calc.js
+++ b/src/calc.js
@@ -1,1 +1,2 @@
 export const half = (n) => n / 2;
+export const inv = (n) => 1 / n;
`;
	// Six findings of one severity: five off the diff, then the only one on it.
	const findings = [
		...Array.from({ length: 5 }, (_, i) => finding(`off${i}`, { line: 50 + i })),
		finding("on", { line: 2 }),
	];
	const deps = {
		prepare: async () => ({ diff, fixDiff: async () => "a fix" }),
		review: async () => JSON.stringify({ findings }),
		judge: async () =>
			JSON.stringify({
				verdicts: findings.map((f, index) => ({
					index,
					verdict: f.title === "on" ? "real" : "false",
					reason: "r",
				})),
			}),
	};
	const out = join(root, "out-top");
	const { totals, rows } = await runReplay({
		model,
		setText: setOf(1),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps,
	});
	assert.deepEqual(
		rows[0].findings.map((f) => f.offDiff),
		[true, true, true, true, true, false],
	);
	// Without diff membership the first five are shown and none of them is real: 0%.
	assert.equal(totals.topFindings, 5);
	assert.equal(totals.topPrecision, 1 / 5);
});

/** Runs one row whose preparation gives `history`, and says which model calls were made. */
async function runWith(name, history) {
	const called = [];
	const out = join(root, name);
	const result = await runReplay({
		model,
		setText: setOf(2),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps: {
			prepare: async (view) =>
				view.id === "1" ? history : { diff: "diff --git a/x b/x\n", fixDiff: async () => "a fix" },
			review: async () => {
				called.push("review");
				return JSON.stringify({ findings: [finding("f2-0")] });
			},
			judge: async () => {
				called.push("judge");
				return JSON.stringify({ verdicts: [{ index: 0, verdict: "hit", reason: "r" }] });
			},
		},
	});
	return { ...result, called, summary: await readFile(join(out, "summary.md"), "utf8") };
}

test("a diff over the review limit is skipped as the product skips it: a miss, listed", async () => {
	const limit = model.REVIEW_LIMITS.diffBytes;
	const big = `diff --git a/x b/x\n+${"a".repeat(limit)}\n`;
	// Over the limit as the host sends it.
	const raw = await runWith("out-big", { diff: big, fixDiff: async () => "a fix" });
	// Within it as bytes, over it once decoded (bytes that are not UTF-8 become longer replacements).
	const decoded = await runWith("out-decoded", {
		diff: big,
		diffBytes: limit - 1,
		fixDiff: async () => "a fix",
	});
	// Exactly at the limit is reviewed, as the product reviews it.
	const edge = `${"a".repeat(limit - 1)}\n`;
	const atLimit = await runWith("out-edge", {
		diff: edge,
		diffBytes: limit,
		fixDiff: async () => "a fix",
	});
	for (const { rows, called, summary, totals } of [raw, decoded]) {
		assert.equal(rows[0].status, "skipped");
		assert.deepEqual(rows[0].findings, []);
		// No model was asked about the skipped row: only row 2 was reviewed and judged.
		assert.deepEqual(called, ["review", "judge"]);
		assert.equal(totals.hits, 1);
		assert.equal(totals.rows, 2);
		assert.match(
			summary,
			/## Rows the product skips, counted as misses\n\n- Row 1 \(widgets#11\): The diff .* over the review limit of 200000/,
		);
		assert.match(summary, /Rows that failed to run, counted as misses\n\nNone\./);
	}
	assert.match(raw.rows[0].error, /is 200\d+ bytes/);
	assert.match(decoded.rows[0].error, /decodes to/);
	assert.equal(atLimit.rows[0].status, "done");
});

test("a diff of bytes that are not UTF-8 is skipped once decoded past the limit", async () => {
	// Latin-1 text: each byte is one byte to the host and three once decoded to a replacement.
	const repo = await makeRepo("latin1");
	const base = await repo.commit("calc.js", "export const half = (n) => n / 2;\n", "base");
	const latin = Buffer.concat([Buffer.alloc(70_000, 0xe9), Buffer.from("\n")]);
	const preFix = await repo.commit("wide.txt", latin, "latin-1 file");
	const made = await cleanHistory({
		source: { cloneUrl: () => repo.dir, baseOf: async () => base },
		cacheDir: join(root, "cache-latin1"),
		dir: join(root, "checkout-latin1"),
		row: { repo: "widgets", pr: 11, pre_fix: preFix },
	});
	const limit = model.REVIEW_LIMITS.diffBytes;
	assert.ok(made.diffBytes < limit);
	assert.ok(Buffer.byteLength(made.diff, "utf8") > limit);
	const { rows, called } = await runWith("out-latin1", {
		diff: made.diff,
		diffBytes: made.diffBytes,
		fixDiff: async () => "a fix",
	});
	assert.equal(rows[0].status, "skipped");
	assert.match(rows[0].error, /decodes to/);
	assert.deepEqual(called, ["review", "judge"]);
});

test("a row id never becomes a property or a path", async () => {
	const canary = await mkdtemp(join(tmpdir(), "replay-canary-"));
	await writeFile(join(canary, "keep.txt"), "kept");
	const ids = ["__proto__", "constructor", `../${canary.split(/[\\/]/).pop()}`, "a/b", ".."];
	const set = JSON.stringify(ids.map((id, i) => row(i + 1, { row: id, criteria: [] })));
	const prepared = [];
	const deps = {
		async prepare(_view, dir) {
			prepared.push(dir);
			await mkdir(dir, { recursive: true });
			return { diff: "d", fixDiff: async () => "a fix" };
		},
		review: async () => JSON.stringify({ findings: [finding("x")] }),
		judge: async () => JSON.stringify({ verdicts: [{ index: 0, verdict: "real", reason: "r" }] }),
	};
	const out = join(root, "out-ids");
	try {
		const first = await runReplay({
			model,
			setText: set,
			reviewer: "codex:m",
			judge: "claude:m",
			out,
			deps,
		});
		assert.deepEqual(
			first.rows.map((r) => r.id),
			ids,
		);
		assert.ok(first.rows.every((r) => r.status === "done"));
		assert.equal(new Set(prepared).size, ids.length);
		assert.equal(await readFile(join(canary, "keep.txt"), "utf8"), "kept");
		// The checkpoint keeps them all, and a resume reads them back.
		const saved = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
		assert.deepEqual(
			saved.rows.map((r) => r.id),
			ids,
		);
		const again = [];
		await runReplay({
			model,
			setText: set,
			reviewer: "codex:m",
			judge: "claude:m",
			out,
			deps: { ...deps, prepare: async (view) => again.push(view.id) },
		});
		assert.deepEqual(again, []);
	} finally {
		await rm(canary, { recursive: true, force: true });
	}
});

test("a repository name that is not a name is refused", () => {
	for (const repo of ["a b", "x;y", "../x", "a/b/c", "--flag", ""]) {
		assert.throws(() => splitSet([row(1, { repo })]), /has no repo/, repo);
	}
	assert.throws(() => splitSet([row(1, { fix: "--upload-pack=x" })]), /bad fix/);
	splitSet([row(1, { repo: "gateweavehq/agents", fix: null })]);
});

/** A repository whose history the tests shape: `commit` writes a file under src/ and commits it. */
async function makeRepo(name) {
	const dir = join(root, `${name}-${++sources}`);
	await mkdir(dir, { recursive: true });
	await git(dir, ["init", "--quiet", "--initial-branch=main"]);
	const commit = async (file, text, message) => {
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", file), text);
		await git(dir, ["add", "-A"]);
		await git(dir, ["commit", "--quiet", "-m", message]);
		return (await git(dir, ["rev-parse", "HEAD"])).trim();
	};
	return { dir, commit, git: (...args) => git(dir, args) };
}

test("a base branch update merged into the reviewed branch is not part of the diff", async () => {
	const repo = await makeRepo("merged-base");
	await repo.commit("calc.js", "export const half = (n) => n / 2;\n", "base");
	await repo.git("checkout", "--quiet", "-b", "pr");
	await repo.commit("pr.js", "export const pr = 1;\n", "pr work");
	await repo.git("checkout", "--quiet", "main");
	const update = await repo.commit("main.js", "export const main = 1;\n", "base branch update");
	await repo.git("checkout", "--quiet", "pr");
	await repo.git("merge", "--quiet", "--no-ff", "-m", "merge main", "main");
	const preFix = await repo.commit("more.js", "export const more = 1;\n", "pr work again");
	await repo.git("checkout", "--quiet", "main");
	const later = await repo.commit("later.js", "export const later = 1;\n", "after the merge");

	// The oldest commit of the pull request has `base` as its parent, which predates the update.
	// The recorded base is the base branch's tip at some time: the update, or what came after it.
	for (const [name, recorded] of [
		["update", update],
		["tip", later],
	]) {
		const { diff } = await cleanHistory({
			source: { cloneUrl: () => repo.dir, baseOf: async () => recorded },
			cacheDir: join(root, `cache-merged-${name}`),
			dir: join(root, `checkout-merged-${name}`),
			row: { repo: "widgets", pr: 11, pre_fix: preFix },
		});
		assert.match(diff, /src\/pr\.js/, name);
		assert.match(diff, /src\/more\.js/, name);
		assert.doesNotMatch(diff, /src\/main\.js/, name);
		assert.doesNotMatch(diff, /src\/later\.js/, name);
	}
});

/** A repository with a fix that only a pull request ref holds, as after a squash merge. */
async function pullRefRepo() {
	const repo = await makeRepo("pull-ref");
	const base = await repo.commit("calc.js", "export const half = (n) => n / 2;\n", "base");
	await repo.commit(
		"calc.js",
		"export const half = (n) => n / 2;\nexport const inv = (n) => 1 / n;\n",
		"pr",
	);
	const preFix = await repo.commit("notes.md", "a note\n", "pre-fix head");
	await repo.git("checkout", "--quiet", "--detach");
	const fix = await repo.commit(
		"calc.js",
		"export const inv = (n) => (n === 0 ? 0 : 1 / n);\n",
		"fix",
	);
	await repo.git("update-ref", "refs/pull/20/head", fix);
	await repo.git("checkout", "--quiet", "main");
	return { ...repo, base, preFix, fix };
}

test("a fix that only another pull request holds is fetched from its ref", async () => {
	const repo = await pullRefRepo();
	const source = {
		cloneUrl: () => repo.dir,
		baseOf: async () => repo.base,
		refsFor: async () => ["refs/pull/20/head", "not a ref"],
	};
	const made = await cleanHistory({
		source,
		cacheDir: join(root, "cache-pullref"),
		dir: join(root, "checkout-pullref"),
		row: { repo: "widgets", pr: 11, pre_fix: repo.preFix },
	});
	// A short revision cannot be fetched by itself: the ref that holds it is.
	const patch = await fixPatch({
		source,
		mirror: made.mirror,
		repo: "widgets",
		pr: 11,
		preFix: made.preFix,
		fix: repo.fix.slice(0, 7),
		alsoFix: null,
	});
	assert.equal(patch.reason, null);
	assert.match(patch.diff, /n === 0 \? 0/);
});

test("a fix that cannot be had is recorded and the judge reads the reviewed tree", async () => {
	const repo = await pullRefRepo();
	const source = { cloneUrl: () => repo.dir, baseOf: async () => repo.base };
	const prompts = [];
	const deps = {
		async prepare(view, dir) {
			const made = await cleanHistory({
				source,
				cacheDir: join(root, "cache-nofix"),
				dir,
				row: view,
			});
			return {
				diff: made.diff,
				fixDiff: (judge) =>
					fixPatch({
						source,
						mirror: made.mirror,
						repo: view.repo,
						pr: view.pr,
						preFix: made.preFix,
						fix: judge.fix,
						alsoFix: judge.also_fix,
					}),
			};
		},
		review: async () => JSON.stringify({ findings: [finding("zero")] }),
		async judge(prompt) {
			prompts.push(prompt);
			return JSON.stringify({ verdicts: [{ index: 0, verdict: "hit", reason: "r" }] });
		},
	};
	const out = join(root, "out-nofix");
	const { rows, totals } = await runReplay({
		model,
		setText: JSON.stringify([row(1, { pre_fix: repo.preFix, fix: "deadbee" })]),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps,
	});
	assert.equal(rows[0].status, "done");
	assert.equal(totals.hits, 1);
	assert.equal(rows[0].fixPatch.available, false);
	assert.match(rows[0].fixPatch.reason, /deadbee could not be fetched/);
	assert.match(prompts[0], /The change that fixed it is not available/);
	assert.match(
		await readFile(join(out, "summary.md"), "utf8"),
		/Rows judged without the fix patch\n\n- Row 1/,
	);
});

test("a relative --out is read once, before the paths made from it", async () => {
	const repo = await fixtureRepo();
	const before = process.cwd();
	await writeFile(
		join(root, "relative-set.json"),
		JSON.stringify([row(1, { pre_fix: repo.preFix, fix: repo.fix })]),
	);
	const asked = [];
	const askModel = async (_engine, _prompt, _dir, { role }) => {
		asked.push(role);
		return role === "reviewer"
			? JSON.stringify({ findings: [finding("zero")] })
			: JSON.stringify({ verdicts: [{ index: 0, verdict: "hit", reason: "r" }] });
	};
	const log = console.log;
	process.chdir(root);
	console.log = () => {};
	try {
		await main(
			[
				"--set",
				"relative-set.json",
				"--reviewer",
				"claude:m",
				"--judge",
				"codex:m",
				"--out",
				"out-relative",
			],
			{ source: { cloneUrl: () => repo.dir, baseOf: async () => repo.base }, askModel },
		);
	} finally {
		console.log = log;
		process.chdir(before);
	}
	const saved = JSON.parse(await readFile(join(root, "out-relative", "results.json"), "utf8"));
	assert.equal(saved.rows[0].status, "done", saved.rows[0].error);
	assert.deepEqual(asked, ["reviewer", "judge"]);
	assert.ok(existsSync(join(root, "out-relative", "cache", "widgets.git")));
	assert.equal(existsSync(join(root, "out-relative", "cache", "out-relative")), false);
});

// The launcher, through stand-ins for the codex and claude command lines that record what they
// were started with. They are .cmd shims on Windows, as npm installs them, and scripts elsewhere.
const STUB = `import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const [tool, ...args] = process.argv.slice(2);
const input = readFileSync(0, "utf8");
const folder = tool === "codex" ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
let configFiles = {};
try {
	for (const name of readdirSync(folder)) configFiles[name] = readFileSync(join(folder, name), "utf8");
} catch {}
const reply = JSON.stringify(
	input.includes("You judge")
		? { verdicts: [{ index: 0, verdict: "hit", reason: "r" }] }
		: { findings: [] },
);
writeFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "capture-" + tool + ".json"),
	JSON.stringify({ args, cwd: process.cwd(), env: process.env, configFiles, input }),
);
if (tool === "codex") writeFileSync(args[args.indexOf("-o") + 1], reply);
else process.stdout.write(reply);
`;

let stubs;
const stubBin = () => {
	stubs ??= makeStubs();
	return stubs;
};
async function makeStubs() {
	const bin = join(root, "stub bin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "stub.mjs"), STUB);
	for (const tool of ["codex", "claude"]) {
		if (process.platform === "win32") {
			await writeFile(join(bin, `${tool}.cmd`), `@echo off\r\nnode "%~dp0stub.mjs" ${tool} %*\r\n`);
		} else {
			await writeFile(
				join(bin, tool),
				`#!/bin/sh\nexec node "$(dirname "$0")/stub.mjs" ${tool} "$@"\n`,
			);
			await chmod(join(bin, tool), 0o755);
		}
	}
	return bin;
}

/** Runs `fn` with these environment variables set, and puts them back. */
async function withEnv(patch, fn) {
	const saved = {};
	for (const [key, value] of Object.entries(patch)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const capture = async (tool) =>
	JSON.parse(await readFile(join(await stubBin(), `capture-${tool}.json`), "utf8"));

/** A made-up user: a login, and files the reviewer must never meet. */
async function madeUpUser() {
	const host = join(root, "host user");
	await mkdir(join(host, "claude", "projects"), { recursive: true });
	await mkdir(join(host, "codex"), { recursive: true });
	await writeFile(join(host, "claude", ".credentials.json"), "synthetic-claude-login");
	await writeFile(join(host, "claude", "settings.json"), "synthetic-settings");
	await writeFile(join(host, "claude", "projects", "answer.txt"), "synthetic-answer");
	await writeFile(join(host, "codex", "auth.json"), "synthetic-codex-login");
	await writeFile(join(host, "codex", "config.toml"), "synthetic-codex-config");
	return host;
}

const userEnv = async (host) => ({
	PATH: `${await stubBin()}${delimiter}${process.env.PATH ?? process.env.Path}`,
	CLAUDE_CONFIG_DIR: join(host, "claude"),
	CODEX_HOME: join(host, "codex"),
	ANTHROPIC_API_KEY: "synthetic-anthropic-key",
	OPENAI_API_KEY: "synthetic-openai-key",
	GITHUB_TOKEN: "synthetic-github-token",
	GH_TOKEN: "synthetic-gh-token",
	SYNTHETIC_ANSWER_FILE: join(host, "claude", "projects", "answer.txt"),
});

test("the claude reviewer starts with an allowlisted environment, a folder of its own and file tools confined to the checkout", async () => {
	const host = await madeUpUser();
	const dir = await mkdtemp(join(root, "reviewer cwd "));
	await withEnv(await userEnv(host), async () => {
		const reply = await ask(parseEngine("claude:m", "--reviewer"), "the prompt", dir, {
			role: "reviewer",
		});
		assert.deepEqual(JSON.parse(reply), { findings: [] });
	});
	const seen = await capture("claude");
	assert.equal(realpathSync.native(seen.cwd), realpathSync.native(dir));
	for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands"]) {
		assert.ok(seen.args.includes(flag), flag);
	}
	assert.equal(seen.args[seen.args.indexOf("--tools") + 1], "Read,Grep,Glob");
	assert.equal(seen.input, "the prompt");
	// Only the engine's own key and what the program needs.
	assert.equal(seen.env.ANTHROPIC_API_KEY, "synthetic-anthropic-key");
	for (const name of [
		"OPENAI_API_KEY",
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"SYNTHETIC_ANSWER_FILE",
		"CODEX_HOME",
	]) {
		assert.equal(
			name in seen.env && name !== "CODEX_HOME" ? seen.env[name] : undefined,
			undefined,
			name,
		);
	}
	// Its configuration folder is another one, and holds the login and nothing else.
	assert.notEqual(seen.env.CLAUDE_CONFIG_DIR, join(host, "claude"));
	assert.deepEqual(seen.configFiles, { ".credentials.json": "synthetic-claude-login" });
	assert.notEqual(seen.env.HOME, process.env.HOME);
	assert.ok(!seen.env.HOME.startsWith(host));
	assert.equal(JSON.stringify(seen.env).includes("synthetic-answer"), false);
	assert.equal(JSON.stringify(seen.env).includes(host.replaceAll("\\", "\\\\")), false);
	// And it is gone afterwards.
	assert.equal(existsSync(seen.env.HOME), false);
});

test("the codex reviewer's profile reads the checkout and the system, and has no network", {
	skip: process.platform === "win32",
}, async () => {
	const host = await madeUpUser();
	const dir = await mkdtemp(join(root, "reviewer cwd "));
	await withEnv(await userEnv(host), async () => {
		await ask(parseEngine("codex:m", "--reviewer"), "the prompt", dir, { role: "reviewer" });
	});
	const seen = await capture("codex");
	const profile = seen.args.filter((_arg, i) => seen.args[i - 1] === "-c");
	assert.ok(profile.includes('default_permissions="replay"'));
	assert.ok(profile.includes("permissions.replay.network.enabled=false"));
	const filesystem = profile.find((arg) => arg.startsWith("permissions.replay.filesystem="));
	assert.equal(filesystem.includes(`'${dir.replaceAll("\\", "/")}'="read"`), true);
	assert.equal(filesystem.includes(host), false);
	assert.equal((filesystem.match(/="read"/g) ?? []).length, 2);
	assert.deepEqual(seen.configFiles, { "auth.json": "synthetic-codex-login" });
	assert.equal(seen.env.OPENAI_API_KEY, "synthetic-openai-key");
	assert.equal(seen.env.GITHUB_TOKEN, undefined);
	assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
});

test("the codex reviewer's arguments turn hosted web search off and cut the network", () => {
	const launch = reviewerLaunch(parseEngine("codex:m", "--reviewer"), {
		cwd: "/work/checkout",
		home: "/work/home",
		file: "/work/home/tmp/reply.txt",
		host: {},
		platform: "linux",
	});
	const settings = launch.args.filter((_arg, i) => launch.args[i - 1] === "-c");
	// Codex's own web search tool is separate from the profile's network switch: cached by default.
	assert.ok(settings.includes('web_search="disabled"'));
	assert.ok(settings.includes("permissions.replay.network.enabled=false"));
	assert.ok(settings.includes('default_permissions="replay"'));
	// No flag may turn a search back on, and the prompt still comes on stdin.
	assert.equal(launch.args.includes("--search"), false);
	assert.equal(launch.args.at(-1), "-");
	// Claude's reviewer has no search or fetch tool at all.
	const claude = reviewerLaunch(parseEngine("claude:m", "--reviewer"), {
		cwd: "/work/checkout",
		home: "/work/home",
		file: "/work/home/tmp/reply.txt",
		host: {},
		platform: "linux",
	});
	assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "Read,Grep,Glob");
});

test("a codex reviewer is refused where codex cannot confine reads", () => {
	const codex = parseEngine("codex:m", "--reviewer");
	assert.throws(() => checkReviewerBoundary(codex, "win32"), /cannot be confined/);
	assert.throws(
		() => reviewerLaunch(codex, { cwd: "C:\\x", home: "C:\\h", file: "C:\\f", platform: "win32" }),
		/cannot be confined/,
	);
	checkReviewerBoundary(codex, "linux");
	checkReviewerBoundary(codex, "darwin");
	checkReviewerBoundary(parseEngine("claude:m", "--reviewer"), "win32");
	return assert.rejects(
		main(["--set", "none.json", "--reviewer", "codex:a", "--judge", "claude:b", "--out", "o"], {
			platform: "win32",
		}),
		/cannot be confined/,
	);
});

test("arguments reach a .cmd shim as they were given, with a space in the path", async () => {
	assert.deepEqual(
		commandLine("C:\\bin\\codex.cmd", ["-o", "C:\\Temp\\a b\\reply.txt", "-"], "win32", {
			ComSpec: "cmd.exe",
		}),
		{
			file: "cmd.exe",
			args: ["/d", "/s", "/c", '""C:\\bin\\codex.cmd" "-o" "C:\\Temp\\a b\\reply.txt" "-""'],
			options: { windowsVerbatimArguments: true },
		},
	);
	assert.deepEqual(commandLine("C:\\bin\\codex.exe", ["a b"], "win32"), {
		file: "C:\\bin\\codex.exe",
		args: ["a b"],
		options: {},
	});
	assert.deepEqual(commandLine("/bin/codex", ["a b"], "linux").args, ["a b"]);
	assert.equal(commandLine("x.cmd", ["C:\\dir\\"], "win32").args[3], '""x.cmd" "C:\\dir\\\\""');
	for (const bad of ["%PATH%", 'a"b', "a\nb"]) {
		assert.throws(() => commandLine("x.cmd", [bad], "win32"), /cannot be passed/);
	}

	// Through the launcher itself, with the output file in a folder whose name has a space. The
	// stand-in writes its reply where `-o` says: a split argument would leave it nothing to write.
	const spaced = join(root, "temp with space");
	await mkdir(spaced, { recursive: true });
	const host = await madeUpUser();
	const dir = await mkdtemp(join(root, "judge cwd "));
	const reply = await withEnv(
		{ ...(await userEnv(host)), TEMP: spaced, TMP: spaced, TMPDIR: spaced },
		() => ask(parseEngine("codex:m", "--judge"), "You judge", dir, { role: "judge" }),
	);
	assert.deepEqual(JSON.parse(reply).verdicts[0].verdict, "hit");
	const seen = await capture("codex");
	assert.ok(seen.args[seen.args.indexOf("-o") + 1].includes("temp with space"));
});
