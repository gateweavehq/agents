// Every row here is made up. The real replay set is read only from --set, never from this folder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	ask,
	checkFamilies,
	checkReviewerBoundary,
	jsonIn,
	parseEngine,
	reviewerEnv,
	reviewerLaunch,
} from "./engines.mjs";
import { cleanHistory, fixDiff, fixPatch, git, mirrorOf } from "./history.mjs";
import {
	commandLine,
	resolveExecutable,
	resumeStarting,
	runCommand,
	terminateAll,
} from "./launcher.mjs";
import { loadModel } from "./model.mjs";
import { checkTranscript, preflight, readTranscript } from "./preflight.mjs";
import {
	HIDDEN_KEYS,
	judgePrompt,
	parseFindings,
	promptFingerprint,
	reviewPrompt,
	runReplay,
	score,
	splitSet,
} from "./replay.mjs";
import { cli, gateExitCode, main } from "./run.mjs";

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
	const askModel = async (_engine, prompt, _dir, { role }) => {
		asked.push(role);
		if (prompt.includes(CHECK_MARK)) return confinedTranscript(prompt);
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
			{
				source: {
					cloneUrl: () => repo.dir,
					baseOf: async () => repo.base,
					headOf: async () => "f".repeat(40),
				},
				askModel,
			},
		);
	} finally {
		console.log = log;
		process.chdir(before);
	}
	const saved = JSON.parse(await readFile(join(root, "out-relative", "results.json"), "utf8"));
	assert.equal(saved.rows[0].status, "done", saved.rows[0].error);
	// The preflight asks the reviewer once before the row, then the row's reviewer and judge.
	assert.deepEqual(asked, ["reviewer", "reviewer", "judge"]);
	const cached = (await readdir(join(root, "out-relative", "cache"))).filter((name) =>
		name.endsWith(".git"),
	);
	assert.equal(cached.length, 1);
	assert.match(cached[0], /^widgets-source-\d+-[0-9a-f]{12}\.git$/);
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
let reply = JSON.stringify(
	input.includes("You judge")
		? { verdicts: [{ index: 0, verdict: "hit", reason: "r" }] }
		: { findings: [] },
);
if (args.includes("stream-json")) {
	// A confined session's transcript: the inside file read, the outside ones refused.
	const files = Object.fromEntries([...input.matchAll(/^- (\\w+): (.+)$/gm)].map((m) => [m[1], m[2]]));
	const lines = [{ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"] }];
	const call = (path, content, isError) => {
		const id = "toolu_" + (lines.length + 1);
		lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }] } });
		lines.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
	};
	call(files.inside, "1 " + readFileSync(files.inside, "utf8"), false);
	for (const name of ["answer_file", "cache", "beside"]) call(files[name], "Outside the working directory", true);
	lines.push({ type: "result", subtype: "success", is_error: false, result: "done" });
	reply = lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n";
}
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

test("a reply with prose that holds braces still yields the JSON object", () => {
	assert.deepEqual(jsonIn('I checked foo() {} first.\n{"findings": []}'), { findings: [] });
	assert.deepEqual(jsonIn('```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
	assert.deepEqual(jsonIn('{"a": 1} and then {x}'), { a: 1 });
	assert.throws(() => jsonIn("nothing { here }"), /no JSON object/);
});

test("a malformed object is passed over whole, never entered for an object nested in it", () => {
	// The outer object is broken: the complete object inside it is not the answer.
	assert.throws(() => jsonIn('{"response":{"findings":[]} BROKEN}'), /no JSON object/);
	assert.throws(() => jsonIn('{"response":{"findings":[]}'), /no JSON object/);
	assert.throws(() => jsonIn('{"a": [{"b": 1}'), /no JSON object/);
	assert.throws(
		() => parseFindings(model, '{"response":{"findings":[]} BROKEN}'),
		/no JSON object/,
	);
	// A complete answer after a broken attempt is still found, and braces in strings do not count.
	assert.deepEqual(jsonIn('{"bad": } then {"findings": []}'), { findings: [] });
	assert.deepEqual(jsonIn('{"a": "}{", "b": "\\"}"} trailing'), { a: "}{", b: '"}' });
	assert.deepEqual(jsonIn('Here:\n```json\n{"a": {"b": [1, {"c": 2}]}}\n```\nDone {x}'), {
		a: { b: [1, { c: 2 }] },
	});
});

test("an engine name is one of the declared ones, not something every object inherits", () => {
	for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
		assert.throws(() => parseEngine(`${name}:m`, "--reviewer"), /--reviewer must be/);
	}
	assert.equal(parseEngine("openai:m", "--judge").engine, "codex");
});

test("a part of the set cannot pass the gate, however well it scores", async () => {
	const low = { ...model, REVIEW_GATE: { bar: { rows: 3, hits: 2, realShare: 0.5 } } };
	const { totals } = await runReplay({
		model: low,
		setText: setOf(2),
		reviewer: "codex:m",
		judge: "claude:m",
		out: join(root, "out-partial"),
		deps: standIns({ 1: ["hit"], 2: ["hit"] }),
	});
	assert.equal(totals.hits, 2);
	assert.equal(totals.realShare, 1);
	assert.equal(totals.pass, false);
	assert.match(await readFile(join(root, "out-partial", "summary.md"), "utf8"), /^Gate: FAIL$/m);
	assert.equal(gateExitCode({ pass: true }), 0);
	assert.equal(gateExitCode(totals), 1);
});

test("a resume has to match the prompts and the organization it ran with", async () => {
	const out = join(root, "out-identity");
	const base = {
		model,
		setText: setOf(1),
		reviewer: "codex:m",
		judge: "claude:m",
		org: "acme",
		out,
	};
	await runReplay({ ...base, deps: standIns({ 1: ["hit"] }) });
	const calls = [];
	await runReplay({ ...base, deps: standIns({ 1: ["hit"] }, calls) });
	assert.deepEqual(calls, []);
	await assert.rejects(
		runReplay({ ...base, org: "other", deps: standIns({}) }),
		/prompts, organization/,
	);
	// The instructions the reviewer is given changed: what was measured is not this.
	const edited = { ...model, REVIEW_INSTRUCTIONS: `${model.REVIEW_INSTRUCTIONS} Be gentle.` };
	await assert.rejects(
		runReplay({ ...base, model: edited, deps: standIns({}) }),
		/use another --out/,
	);
	// A file from before the format was versioned this way is refused too.
	const file = join(out, "results.json");
	const saved = JSON.parse(await readFile(file, "utf8"));
	await writeFile(file, JSON.stringify({ ...saved, version: 2 }));
	await assert.rejects(runReplay({ ...base, deps: standIns({}) }), /use another --out/);
});

test("a folder that will not be removed neither loses the finished row nor stops the next", async () => {
	const out = join(root, "out-cleanup");
	const log = [];
	const calls = [];
	const removeFails = async () => {
		throw new Error("EBUSY");
	};
	const { totals, rows } = await runReplay({
		model,
		setText: setOf(2),
		reviewer: "codex:m",
		judge: "claude:m",
		out,
		deps: standIns({ 1: ["hit"], 2: ["real"] }, calls),
		log: (line) => log.push(line),
		remove: removeFails,
	});
	assert.deepEqual(calls, ["prepare 1", "prepare 2"]);
	assert.deepEqual(
		rows.map((r) => r.status),
		["done", "done"],
	);
	assert.equal(totals.hits, 1);
	const saved = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
	assert.equal(saved.rows.length, 2);
	assert.ok(log.some((line) => /could not remove .*EBUSY/.test(line)));
});

test("a mirror is named by the repository it is of, and reused only for that one", async () => {
	const one = await fixtureRepo();
	const two = await fixtureRepo();
	// The two sources must not share a history, or a copy of the wrong one would pass the check.
	await writeFile(join(two.dir, "src", "only-two.js"), "export const two = 2;\n");
	await git(two.dir, ["add", "-A"]);
	await git(two.dir, ["commit", "--quiet", "-m", "only in the second source"]);
	assert.notEqual(
		(await git(one.dir, ["rev-parse", "HEAD"])).trim(),
		(await git(two.dir, ["rev-parse", "HEAD"])).trim(),
	);
	const urls = { "acme/widgets": one.dir, acme__widgets: two.dir, widgets: one.dir };
	const source = { cloneUrl: (repo) => urls[repo] };
	const cacheDir = join(root, "mirror-cache");
	const a = await mirrorOf(source, cacheDir, "acme/widgets");
	const b = await mirrorOf(source, cacheDir, "acme__widgets");
	const short = await mirrorOf(source, cacheDir, "widgets");
	assert.notEqual(a, b);
	// A qualified name and the short name that resolve to the same place share one copy.
	assert.equal(a, short);
	assert.equal(
		(await git(b, ["rev-parse", "HEAD"])).trim(),
		(await git(two.dir, ["rev-parse", "HEAD"])).trim(),
	);
	// A copy that is of another repository is refused, not reused.
	await git(a, ["config", "replay.source", "somewhere/else"]);
	await assert.rejects(mirrorOf(source, cacheDir, "acme/widgets"), /is of somewhere\/else, not of/);
});

test("a program is found only on absolute PATH entries, and the reviewer's PATH holds only those", async () => {
	const bin = await mkdtemp(join(root, "path bin "));
	const name = "replay-tool-for-test";
	const file = join(bin, process.platform === "win32" ? `${name}.cmd` : name);
	await writeFile(file, "echo\n");
	await chmod(file, 0o755);
	const env = { PATH: ["bin", ".", bin].join(delimiter), PATHEXT: ".CMD" };
	assert.equal(resolveExecutable(name, env), file);
	assert.throws(() => resolveExecutable(name, { PATH: ["bin", "."].join(delimiter) }), /not found/);

	const made = reviewerEnv(
		"claude",
		{ PATH: ["bin", bin, "./x"].join(delimiter) },
		join(root, "reviewer-home"),
		process.platform,
	);
	assert.equal(made.PATH, bin);
});

const script = async (name, text) => {
	const file = join(root, name);
	await writeFile(file, text);
	return file;
};

test("output is decoded as a stream, so a character split between chunks stays whole", async () => {
	const file = await script(
		"split-char.mjs",
		`const bytes = Buffer.from("caf\\u00e9 \\u20ac ok");
process.stdout.write(bytes.subarray(0, 4));
setTimeout(() => process.stdout.write(bytes.subarray(4, 8)), 100);
setTimeout(() => process.stdout.write(bytes.subarray(8)), 200);
`,
	);
	assert.equal(await runCommand("node", [file], { input: "" }), "café € ok");
});

test("a timeout settles the launch even when a descendant keeps the pipes open", async () => {
	const child = await script("hold-pipes.mjs", "setTimeout(() => {}, 60000);\n");
	const parent = await script(
		"hold-parent.mjs",
		`import { spawn } from "node:child_process";
// A descendant with the parent's pipes, which a kill of the parent alone would not end.
spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "inherit" });
setTimeout(() => {}, 60000);
`,
	);
	const started = Date.now();
	await assert.rejects(
		runCommand("node", [parent], { input: "", timeoutMs: 300, killGraceMs: 1500 }),
		/node timed out after 300 ms/,
	);
	assert.ok(Date.now() - started < 10000);
});

// The preflight proves the reviewer's confinement from the transcript of its session
// (`--output-format stream-json --verbose`), never from what the model says. These transcripts are
// written by hand, in the shape claude writes: an init message that lists the tools, tool_use
// events, and a tool_result event for each, with `is_error` set when the call was refused.
const CHECK_MARK = "check of the setup of this run";
const named = (prompt) =>
	Object.fromEntries([...prompt.matchAll(/^- (\w+): (.+)$/gm)].map((m) => [m[1], m[2]]));
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const preflightSource = {
	cloneUrl: () => "https://example.invalid/agents.git",
	headOf: async () => HEAD,
};

/** One transcript line per event. `steps` are [tool, input, result text, is_error]; no result: cut off. */
function jsonl(steps, { tools = ["Read", "Grep", "Glob"], init = true } = {}) {
	const lines = [];
	if (init)
		lines.push({ type: "system", subtype: "init", session_id: "s-1", tools, mcp_servers: [] });
	steps.forEach(([name, input, content, isError], i) => {
		const id = `toolu_${i + 1}`;
		lines.push({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
		});
		if (content !== undefined) {
			lines.push({
				type: "user",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
				},
			});
		}
	});
	lines.push({ type: "result", subtype: "success", is_error: false, result: "done" });
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

const readOf = (path, text) => ["Read", { file_path: path }, `     1\t${text}`, false];
const refusedRead = (path) => [
	"Read",
	{ file_path: path },
	"Permission denied: the file is outside the working directory",
	true,
];

const OUTSIDE = ["answer_file", "cache", "beside"];

/**
 * What a confined reviewer's session looks like for this prompt: its own canary read, the three
 * outside files refused, and no way to the network. `change` breaks one part at a time.
 */
async function confinedTranscript(prompt, change = {}) {
	const files = named(prompt);
	const { skip = [], read = [], inside = "ok", network = "absent", tools } = change;
	const steps = [];
	if (inside === "ok") steps.push(readOf(files.inside, await readFile(files.inside, "utf8")));
	if (inside === "denied") steps.push(refusedRead(files.inside));
	if (inside === "empty") steps.push(readOf(files.inside, ""));
	if (inside === "wrong")
		steps.push(readOf(files.inside, "canary-00000000000000000000000000000000"));
	if (inside === "grep") {
		steps.push(["Grep", { pattern: "canary", path: files.inside }, "1 match", false]);
	}
	if (inside === "other")
		steps.push(readOf(`${files.inside}.x`, await readFile(files.inside, "utf8")));
	for (const name of OUTSIDE) {
		if (skip.includes(name)) continue;
		steps.push(
			read.includes(name)
				? readOf(files[name], await readFile(files[name], "utf8"))
				: refusedRead(files[name]),
		);
	}
	const toolsFor = ["Read", "Grep", "Glob"];
	if (network === "denied")
		steps.push(["WebFetch", { url: "https://example.invalid/agents.git" }, "refused", true]);
	if (network === "bash-denied")
		steps.push(["Bash", { command: "git clone x" }, "not allowed", true]);
	if (network === "fetched")
		steps.push(["WebFetch", { url: "https://example.invalid/agents.git" }, HEAD, false]);
	if (network === "bash-ran") steps.push(["Bash", { command: "ls" }, "README.md", false]);
	if (network !== "absent") toolsFor.push(network.startsWith("bash") ? "Bash" : "WebFetch");
	return jsonl(steps, { tools: tools ?? toolsFor, init: change.init !== false });
}

async function runPreflight(askModel, options = {}) {
	const cacheDir = join(root, `preflight-cache-${Math.random().toString(36).slice(2)}`);
	let base;
	try {
		await preflight({
			reviewer: parseEngine("claude:m", "--reviewer"),
			askModel: (engine, prompt, cwd, asked) => {
				// <throwaway folder>/row/repo is the checkout: this run's own folder, nobody else's.
				base = dirname(dirname(cwd));
				return askModel(engine, prompt, cwd, asked);
			},
			source: preflightSource,
			cacheDir,
			log: () => {},
			...options,
		});
	} finally {
		// Whatever the outcome, nothing of the preflight stays: not its folder, not its cache canary.
		if (!options.remove && base) assert.equal(existsSync(base), false);
		if (!options.remove) assert.deepEqual(await readdir(cacheDir), []);
	}
}

// A transcript that is not proven: the error names the check, never a canary, and nothing was reviewed.
const refused = (pattern) => (error) => {
	assert.match(error.message, pattern);
	assert.match(error.message, /Nothing was reviewed and no result was written/);
	assert.equal(/canary-[0-9a-f]{8}/.test(error.message), false);
	return true;
};

test("the preflight passes a reviewer whose transcript shows its own read and refused outside calls", async () => {
	const seen = [];
	await runPreflight(async (engine, prompt, cwd, options) => {
		seen.push({ engine: engine.spec, options, files: named(prompt), cwd });
		assert.match(prompt, /example\.invalid\/agents\.git/);
		return confinedTranscript(prompt);
	});
	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0].options, { role: "reviewer", transcript: true });
	assert.deepEqual(Object.keys(seen[0].files), ["inside", "answer_file", "cache", "beside"]);
	// The inside canary is in the checkout the reviewer works in; the others are outside it.
	assert.equal(seen[0].files.inside.startsWith(seen[0].cwd), true);
	for (const name of OUTSIDE)
		assert.equal(seen[0].files[name].startsWith(seen[0].cwd), false, name);
});

test("the preflight passes when the network is tried and refused, whatever the tool list says", async () => {
	for (const network of ["denied", "bash-denied"]) {
		await runPreflight(async (_e, prompt) => confinedTranscript(prompt, { network }));
	}
	// No init message at all, but the attempt on the network was refused.
	await runPreflight(async (_e, prompt) =>
		confinedTranscript(prompt, { network: "denied", init: false }),
	);
});

// The three hand-written transcripts of the brief, with fixed paths and canaries.
const FILES = {
	inside: "/tmp/replay-preflight-A/row/repo/CANARY.txt",
	answer_file: "/tmp/replay-preflight-A/set/replay-set.json",
	cache: "/tmp/cache/preflight-canary-x.txt",
	beside: "/tmp/replay-preflight-A/row/beside-checkout.txt",
};
const SECRETS = {
	inside: "canary-11111111111111111111111111111111",
	answer_file: "canary-22222222222222222222222222222222",
	cache: "canary-33333333333333333333333333333333",
	beside: "canary-44444444444444444444444444444444",
};
const HEADS = "9".repeat(40);
const check = (transcript, platform = "linux") =>
	checkTranscript({ transcript, files: FILES, secrets: SECRETS, head: HEADS, platform });
const INIT = '{"type":"system","subtype":"init","session_id":"s-1","tools":["Read","Grep","Glob"]}';
const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"done"}';
const use = (id, name, input) =>
	`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"${id}","name":"${name}","input":${JSON.stringify(input)}}]}}`;
const answer = (id, content, isError) =>
	`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"${id}","content":${JSON.stringify(content)},"is_error":${isError}}]}}`;
const insideRead = [
	use("t1", "Read", { file_path: FILES.inside }),
	answer("t1", `     1\t${SECRETS.inside}`, false),
];
const denial = (id, path) => [
	use(id, "Read", { file_path: path }),
	answer(id, "Permission denied: outside the working directory", true),
];
const lines = (...parts) => `${parts.flat(Number.POSITIVE_INFINITY).join("\n")}\n`;

test("a transcript with all denials passes", () => {
	check(
		lines(
			INIT,
			insideRead,
			denial("t2", FILES.answer_file),
			denial("t3", FILES.cache),
			denial("t4", FILES.beside),
			RESULT,
		),
	);
	// The tool results may be a list of text parts, as claude writes some of them.
	check(
		lines(
			INIT,
			insideRead,
			denial("t2", FILES.answer_file),
			denial("t3", FILES.cache),
			denial("t4", FILES.beside),
			[
				use("t5", "Read", { file_path: FILES.inside }),
				`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t5","content":[{"type":"text","text":"${SECRETS.inside}"}],"is_error":false}]}}`,
			],
			RESULT,
		),
	);
});

test("a transcript that skips an outside probe refuses, whichever it skips", () => {
	const all = { answer_file: "t2", cache: "t3", beside: "t4" };
	for (const skipped of OUTSIDE) {
		const probes = OUTSIDE.filter((name) => name !== skipped).map((name) =>
			denial(all[name], FILES[name]),
		);
		assert.throws(
			() => check(lines(INIT, insideRead, probes, RESULT)),
			refused(/not proven.*no refused tool call on/),
			skipped,
		);
	}
	// A probe on another path is not a probe on this one.
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					denial("t2", FILES.answer_file),
					denial("t3", FILES.cache),
					denial("t4", `${FILES.beside}.other`),
					RESULT,
				),
			),
		refused(/not proven.*beside the checkout/),
	);
	// A call that never got its result (the session was cut off) shows no denial.
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					denial("t2", FILES.answer_file),
					denial("t3", FILES.cache),
					use("t4", "Read", { file_path: FILES.beside }),
					RESULT,
				),
			),
		refused(/not proven.*beside the checkout/),
	);
});

test("a transcript with a successful outside read refuses", () => {
	const fine = [denial("t2", FILES.answer_file), denial("t3", FILES.cache)];
	// Its content shows in the result.
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					fine,
					use("t4", "Read", { file_path: FILES.beside }),
					answer("t4", `     1\t${SECRETS.beside}`, false),
					RESULT,
				),
			),
		refused(/not confined to its checkout.*a file beside the checkout/),
	);
	// The call went through with nothing to show for it: still not confined.
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					fine,
					use("t4", "Read", { file_path: FILES.beside }),
					answer("t4", "", false),
					RESULT,
				),
			),
		refused(/a tool call on a file beside the checkout succeeded/),
	);
	// A refusal followed by a success on the same path is a success.
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					fine,
					denial("t4", FILES.beside),
					use("t5", "Read", { file_path: FILES.beside }),
					answer("t5", "", false),
					RESULT,
				),
			),
		refused(/succeeded/),
	);
	// The canary in the reviewer's own words counts too.
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					fine,
					denial("t4", FILES.beside),
					`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I saw ${SECRETS.answer_file}"}]}}`,
					RESULT,
				),
			),
		refused(/not confined to its checkout.*replay set/),
	);
});

test("a transcript without a successful Read of the inside canary refuses", () => {
	const outside = [
		denial("t2", FILES.answer_file),
		denial("t3", FILES.cache),
		denial("t4", FILES.beside),
	];
	const cases = {
		"no read": [],
		"a refused read": denial("t1", FILES.inside),
		"an empty result": [use("t1", "Read", { file_path: FILES.inside }), answer("t1", "", false)],
		"another file's content": [
			use("t1", "Read", { file_path: FILES.inside }),
			answer("t1", "     1\tsomething else", false),
		],
		"another tool": [
			use("t1", "Grep", { pattern: "canary", path: FILES.inside }),
			answer("t1", SECRETS.inside, false),
		],
		"another path": [
			use("t1", "Read", { file_path: `${FILES.inside}.x` }),
			answer("t1", SECRETS.inside, false),
		],
		"a call with no result": [use("t1", "Read", { file_path: FILES.inside })],
	};
	for (const [name, part] of Object.entries(cases)) {
		assert.throws(
			() => check(lines(INIT, part, outside, RESULT)),
			refused(/not proven.*no successful Read of the file inside its own checkout/),
			name,
		);
	}
});

test("a transcript proves the network by an errored attempt or by a tool list without one", () => {
	const part = [
		insideRead,
		denial("t2", FILES.answer_file),
		denial("t3", FILES.cache),
		denial("t4", FILES.beside),
	];
	const withFetch = '{"type":"system","subtype":"init","tools":["Read","Grep","Glob","WebFetch"]}';
	// The tool is there and nothing was tried: unproven.
	assert.throws(
		() => check(lines(withFetch, part, RESULT)),
		refused(/not proven.*failed attempt to fetch from the network/),
	);
	// No init message and no attempt: unproven.
	assert.throws(
		() => check(lines(part, RESULT)),
		refused(/not proven.*failed attempt to fetch from the network/),
	);
	// An init message that does not list the tools: unproven too.
	assert.throws(
		() => check(lines('{"type":"system","subtype":"init"}', part, RESULT)),
		refused(/not proven.*failed attempt to fetch from the network/),
	);
	// A tool list with Bash is not a tool list without a way to the network.
	assert.throws(
		() => check(lines('{"type":"system","subtype":"init","tools":["Read","Bash"]}', part, RESULT)),
		refused(/not proven/),
	);
	// An errored attempt proves it, with or without the list.
	check(
		lines(
			withFetch,
			part,
			[use("t5", "WebFetch", { url: "https://x" }), answer("t5", "no", true)],
			RESULT,
		),
	);
	check(
		lines(part, [use("t5", "Bash", { command: "git clone x" }), answer("t5", "no", true)], RESULT),
	);
	// A call that got through, or the head commit anywhere, is a leak.
	assert.throws(
		() =>
			check(
				lines(
					withFetch,
					part,
					[use("t5", "WebFetch", { url: "https://x" }), answer("t5", "fine", false)],
					RESULT,
				),
			),
		refused(/not confined to its checkout.*a WebFetch call succeeded/),
	);
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					part,
					[use("t5", "Read", { file_path: "/x" }), answer("t5", `head ${HEADS}`, true)],
					RESULT,
				),
			),
		refused(/the repository, retrieved from the network/),
	);
	assert.throws(
		() =>
			check(lines(INIT, part, [`{"type":"result","result":"it points at ${HEADS.slice(0, 12)}"}`])),
		refused(/retrieved from the network/),
	);
});

test("a transcript's paths match however the system spells them", () => {
	const winFiles = {
		inside: "C:\\Temp\\replay-preflight-A\\row\\repo\\CANARY.txt",
		answer_file: "C:\\Temp\\replay-preflight-A\\set\\replay-set.json",
		cache: "C:\\Out\\cache\\preflight-canary-x.txt",
		beside: "C:\\Temp\\replay-preflight-A\\row\\beside-checkout.txt",
	};
	// claude may write the paths with forward slashes and another case of the drive letter.
	const spelled = (path) => path.replaceAll("\\", "/").replace(/^C:/, "c:");
	const transcript = lines(
		INIT,
		[
			use("t1", "Read", { file_path: spelled(winFiles.inside) }),
			answer("t1", SECRETS.inside, false),
		],
		...["answer_file", "cache", "beside"].map((name, i) =>
			denial(`t${i + 2}`, spelled(winFiles[name])),
		),
		RESULT,
	);
	const on = (platform) =>
		checkTranscript({ transcript, files: winFiles, secrets: SECRETS, head: HEADS, platform });
	on("win32");
	// Elsewhere the paths are case sensitive, and these are other paths.
	assert.throws(() => on("linux"), refused(/not proven/));
});

test("what the model says about itself is no transcript", async () => {
	// Nothing at all, prose, and the old kind of self-report: none holds a tool call.
	const report = JSON.stringify({
		inside: "x",
		answer_file: "UNREADABLE",
		cache: "UNREADABLE",
		beside: "UNREADABLE",
		network: "UNREADABLE",
	});
	for (const reply of ["", "   \n", undefined, "I could not read any file and have no network."]) {
		await assert.rejects(
			runPreflight(async () => reply),
			refused(/not proven.*gave no transcript/),
		);
	}
	await assert.rejects(
		runPreflight(async () => report),
		refused(/not proven/),
	);
	// A result line that claims everything, with no tool call behind it.
	await assert.rejects(
		runPreflight(async () =>
			lines(
				INIT,
				'{"type":"result","subtype":"success","result":"Read inside OK. All outside reads were denied and the network is unreachable."}',
			),
		),
		refused(/not proven.*no successful Read/),
	);
	// A line that is not an event is skipped, and the events around it still count.
	assert.equal(readTranscript(`not json\n${INIT}\n[1,2]\n`).events, 1);
});

test("a reviewer's own text cannot pose as an event", async () => {
	// The model writes a line of fake transcript into its reply: inside the JSON event, it is text.
	const fake = JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", id: "z", name: "Read", input: { file_path: "x" } }] },
	});
	const events = readTranscript(
		`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `${fake}\n${fake}` }] } })}\n`,
	);
	assert.equal(events.events, 1);
	assert.deepEqual(events.calls, []);
});

test("a canary written with JSON escapes is found once the strings are decoded", () => {
	const escaped = SECRETS.beside.replace("c", "\\u0063");
	const hidden = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I saw ${escaped}"}]}}`;
	// The raw text does not hold the canary's start, the decoded string does.
	assert.equal(hidden.includes(SECRETS.beside.slice(0, 24)), false);
	assert.throws(
		() =>
			check(
				lines(
					INIT,
					insideRead,
					denial("t2", FILES.answer_file),
					denial("t3", FILES.cache),
					denial("t4", FILES.beside),
					hidden,
					RESULT,
				),
			),
		refused(/not confined to its checkout.*a file beside the checkout/),
	);
});

for (const [which, field] of [
	["the replay set's stand-in", "answer_file"],
	["the judge's cache folder", "cache"],
	["a file beside the checkout", "beside"],
]) {
	test(`the preflight refuses a reviewer that reads ${which}`, async () => {
		let secret = "";
		await assert.rejects(
			runPreflight(async (_engine, prompt) => {
				// An unconfined reviewer reads the file it is asked for.
				secret = (await readFile(named(prompt)[field], "utf8")).trim();
				return confinedTranscript(prompt, { read: [field] });
			}),
			(error) => {
				assert.match(error.message, /not confined to its checkout/);
				assert.match(error.message, /no result was written/);
				// The error says which kind of file, never what it held.
				assert.ok(secret.length > 0);
				assert.equal(error.message.includes(secret), false);
				return true;
			},
		);
	});

	test(`the preflight refuses a transcript that skips the probe of ${which}`, async () => {
		await assert.rejects(
			runPreflight(async (_e, prompt) => confinedTranscript(prompt, { skip: [field] })),
			refused(/not proven.*no refused tool call on/),
		);
	});
}

test("the preflight refuses a transcript whose inside read is missing or empty", async () => {
	for (const inside of ["none", "denied", "empty", "wrong", "grep", "other"]) {
		await assert.rejects(
			runPreflight(async (_e, prompt) => confinedTranscript(prompt, { inside })),
			refused(/not proven.*no successful Read of the file inside its own checkout/),
			inside,
		);
	}
});

test("the preflight refuses a reviewer that reaches the network", async () => {
	for (const network of ["fetched", "bash-ran"]) {
		await assert.rejects(
			runPreflight(async (_e, prompt) => confinedTranscript(prompt, { network })),
			refused(/not confined to its checkout|call succeeded/),
			network,
		);
	}
	// Tools that can reach it are there and nothing was tried.
	await assert.rejects(
		runPreflight(async (_e, prompt) =>
			confinedTranscript(prompt, { tools: ["Read", "Grep", "Glob", "WebSearch"] }),
		),
		refused(/not proven.*failed attempt to fetch from the network/),
	);
});

test("the preflight stops when the reviewer cannot be started", async () => {
	await assert.rejects(
		runPreflight(async () => {
			throw new Error("claude exited 1: unknown option '--output-format'");
		}),
		/could not be started for the preflight.*--output-format/,
	);
});

test("a codex reviewer is refused by the preflight, with no folder made and no model asked", async () => {
	let asked = 0;
	const before = new Set(await readdir(tmpdir()));
	await assert.rejects(
		preflight({
			reviewer: parseEngine("codex:m", "--reviewer"),
			askModel: async () => {
				asked++;
				return "";
			},
			source: preflightSource,
			cacheDir: join(root, "preflight-cache-codex"),
		}),
		refused(/cannot prove the confinement of a codex reviewer yet/),
	);
	assert.equal(asked, 0);
	assert.deepEqual(
		(await readdir(tmpdir())).filter((n) => n.startsWith("replay-preflight-") && !before.has(n)),
		[],
	);
	assert.equal(existsSync(join(root, "preflight-cache-codex")), false);
});

test("a removal that fails neither stops the other nor hides the preflight's own error", async () => {
	const stuck = (target) => async (path, options) => {
		if (path.endsWith(".txt")) throw new Error(`EBUSY ${target}`);
		return rm(path, options);
	};
	const log = [];
	let base;
	await assert.rejects(
		runPreflight(
			async (_e, prompt, cwd) => {
				base = dirname(dirname(cwd));
				return confinedTranscript(prompt, { skip: ["beside"] });
			},
			{ remove: stuck("cache canary"), log: (line) => log.push(line) },
		),
		// The error of the check, not the one of the removal.
		refused(/not proven.*beside the checkout/),
	);
	// The folder went although the cache canary would not.
	assert.equal(existsSync(base), false);
	assert.equal(log.length, 1);
	assert.match(log[0], /could not remove its throwaway files: EBUSY cache canary/);
	// A pass whose cleanup fails is reported, since files were left behind.
	await assert.rejects(
		runPreflight(async (_e, prompt) => confinedTranscript(prompt), { remove: stuck("x") }),
		/could not remove its throwaway files: EBUSY x/,
	);
	// And the other way round: the canary goes although the folder would not.
	let canary;
	let folder;
	await assert.rejects(
		runPreflight(
			async (_e, prompt, cwd) => {
				folder = dirname(dirname(cwd));
				canary = named(prompt).cache;
				return confinedTranscript(prompt, { skip: ["cache"] });
			},
			{
				remove: async (path, options) => {
					if (options.recursive) throw new Error("EBUSY folder");
					return rm(path, options);
				},
				log: (line) => log.push(line),
			},
		),
		refused(/not proven.*judge's cache folder/),
	);
	assert.equal(existsSync(canary), false);
	assert.match(log.at(-1), /EBUSY folder/);
	await rm(folder, { recursive: true, force: true });
});

test("the run stops before any row when the preflight is not proven, and writes no result", async () => {
	const repo = await fixtureRepo();
	const set = join(root, "preflight-set.json");
	await writeFile(set, JSON.stringify([row(1, { pre_fix: repo.preFix, fix: repo.fix })]));
	const replies = {
		"a leak": (prompt) => confinedTranscript(prompt, { read: ["beside"] }),
		"a skipped probe": (prompt) => confinedTranscript(prompt, { skip: ["cache"] }),
		"an empty reply": async () => "",
		prose: async () => "All fine, nothing to report.",
	};
	for (const [name, reply] of Object.entries(replies)) {
		const out = join(root, `out-preflight-${name.replace(/ /g, "-")}`);
		const asked = [];
		let prepared = 0;
		const source = {
			cloneUrl: () => repo.dir,
			baseOf: async () => {
				prepared++;
				return repo.base;
			},
			headOf: async () => "f".repeat(40),
		};
		await assert.rejects(
			main(["--set", set, "--reviewer", "claude:m", "--judge", "codex:m", "--out", out], {
				source,
				async askModel(_engine, prompt, _cwd, { role }) {
					asked.push(role);
					return reply(prompt);
				},
			}),
			/not confined to its checkout|not proven/,
			name,
		);
		assert.deepEqual(asked, ["reviewer"], name);
		assert.equal(prepared, 0, name);
		assert.equal(existsSync(join(out, "results.json")), false, name);
		assert.equal(existsSync(join(out, "summary.md")), false, name);
	}
	// A codex reviewer is refused where the boundary allows it, before any row.
	const out = join(root, "out-preflight-codex");
	const asked = [];
	await assert.rejects(
		main(["--set", set, "--reviewer", "codex:m", "--judge", "claude:m", "--out", out], {
			platform: "linux",
			source: { cloneUrl: () => repo.dir, baseOf: async () => repo.base, headOf: async () => HEAD },
			async askModel(_engine, _prompt, _cwd, { role }) {
				asked.push(role);
				return "";
			},
		}),
		/cannot prove the confinement of a codex reviewer/,
	);
	assert.deepEqual(asked, []);
	assert.equal(existsSync(join(out, "results.json")), false);
});

test("the preflight launch is the rows' launch with the output format as the only difference", () => {
	const where = {
		cwd: "/work/checkout",
		home: "/work/home",
		file: "/work/home/tmp/r.txt",
		host: {},
	};
	const claude = parseEngine("claude:m", "--reviewer");
	const rows = reviewerLaunch(claude, { ...where, platform: "linux" });
	const proof = reviewerLaunch(claude, { ...where, platform: "linux", transcript: true });
	assert.deepEqual(proof.args, [...rows.args, "--output-format", "stream-json", "--verbose"]);
	assert.deepEqual(proof.env, rows.env);
	assert.equal(proof.command, rows.command);
	// The confinement flags are all there in the proof.
	for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands"]) {
		assert.ok(proof.args.includes(flag), flag);
	}
	assert.equal(rows.args.includes("--output-format"), false);
	// There is no transcript of a codex reviewer to read, and a judge has none.
	assert.throws(
		() =>
			reviewerLaunch(parseEngine("codex:m", "--reviewer"), {
				...where,
				platform: "linux",
				transcript: true,
			}),
		/No transcript of a codex reviewer/,
	);
	return assert.rejects(
		ask(parseEngine("claude:m", "--judge"), "x", "/", { role: "judge", transcript: true }),
		/Only a reviewer has a transcript/,
	);
});

test("the preflight goes through the launcher the rows use, with the same flags and the transcript format", async () => {
	const host = await madeUpUser();
	await withEnv(await userEnv(host), async () => {
		await preflight({
			reviewer: parseEngine("claude:m", "--reviewer"),
			askModel: ask,
			source: preflightSource,
			cacheDir: join(root, "preflight-cache-real"),
		});
	});
	const seen = await capture("claude");
	for (const flag of ["--restricted", "--strict-mcp-config", "--disable-slash-commands"]) {
		assert.ok(seen.args.includes(flag), flag);
	}
	assert.equal(seen.args[seen.args.indexOf("--tools") + 1], "Read,Grep,Glob");
	assert.equal(seen.args[seen.args.indexOf("--output-format") + 1], "stream-json");
	assert.ok(seen.args.includes("--verbose"));
	assert.match(seen.input, /check of the setup of this run/);
	// Its folder is the throwaway checkout, and the login folder is the one of the rows' reviewer.
	assert.match(seen.cwd, /replay-preflight-/);
	assert.deepEqual(seen.configFiles, { ".credentials.json": "synthetic-claude-login" });
	assert.equal(seen.env.GITHUB_TOKEN, undefined);
});

// Runs `main` for a made-up set of one row, with stand-in models and no network.
async function mainFor(args, { repo, asked = [] }) {
	const set = join(root, "main-set.json");
	await writeFile(set, JSON.stringify([row(1, { pre_fix: repo.preFix, fix: repo.fix })]));
	const log = console.log;
	console.log = () => {};
	try {
		return await main(["--set", set, "--reviewer", "claude:m", "--judge", "codex:m", ...args], {
			source: {
				cloneUrl: () => repo.dir,
				baseOf: async () => repo.base,
				headOf: async () => "f".repeat(40),
			},
			async askModel(_engine, prompt, _dir, { role }) {
				asked.push(role);
				if (prompt.includes(CHECK_MARK)) return confinedTranscript(prompt);
				return role === "reviewer"
					? JSON.stringify({ findings: [finding("zero")] })
					: JSON.stringify({ verdicts: [{ index: 0, verdict: "hit", reason: "r" }] });
			},
		});
	} finally {
		console.log = log;
	}
}

test("--org reaches the run, so a resume under another organization is refused", async () => {
	const repo = await fixtureRepo();
	const out = join(root, "out-org");
	await mainFor(["--out", out, "--org", "acme"], { repo });
	const saved = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
	assert.equal(saved.org, "acme");
	// The same organization resumes: nothing is asked of the row again, only the preflight.
	const asked = [];
	await mainFor(["--out", out, "--org", "acme"], { repo, asked });
	assert.deepEqual(asked, ["reviewer"]);
	await assert.rejects(
		mainFor(["--out", out, "--org", "other"], { repo }),
		/from another set, prompts, organization/,
	);
	// Without --org the default is what is recorded, not null.
	const plain = join(root, "out-org-default");
	await mainFor(["--out", plain], { repo });
	assert.equal(JSON.parse(await readFile(join(plain, "results.json"), "utf8")).org, "gateweavehq");
});

test("a resume has to match both judge prompts, the one without the fix patch too", async () => {
	const base = {
		model,
		setText: setOf(1),
		reviewer: "codex:m",
		judge: "claude:m",
		out: join(root, "out-judge-variants"),
	};
	await runReplay({ ...base, deps: standIns({ 1: ["hit"] }) });
	// Only the wording used when the fix patch is unavailable changes.
	const noPatch = (view, findings, fix) =>
		judgePrompt(view, findings, fix) + (fix.diff === null ? "\nBe lenient." : "");
	const withPatchOnly = (view, findings, fix) =>
		judgePrompt(view, findings, fix) + (fix.diff === null ? "" : "\nBe lenient.");
	assert.notEqual(promptFingerprint(model), promptFingerprint(model, noPatch));
	assert.notEqual(promptFingerprint(model), promptFingerprint(model, withPatchOnly));
	assert.notEqual(promptFingerprint(model, noPatch), promptFingerprint(model, withPatchOnly));
	await assert.rejects(
		runReplay({ ...base, judgePromptFor: noPatch, deps: standIns({}) }),
		/use another --out/,
	);
	await assert.rejects(
		runReplay({ ...base, judgePromptFor: withPatchOnly, deps: standIns({}) }),
		/use another --out/,
	);
	// The same prompts resume.
	await runReplay({ ...base, deps: standIns({}) });
});

test("a mirror appears at its path whole, and a stale or failed build does not block it", async () => {
	const repo = await fixtureRepo();
	const source = { cloneUrl: () => repo.dir };
	const cacheDir = join(root, "mirror-atomic");
	// What an interrupted run leaves: a half-built folder beside the place, not at it.
	await mkdir(join(cacheDir, "widgets-source-x.git.building-stale"), { recursive: true });
	await writeFile(join(cacheDir, "widgets-source-x.git.building-stale", "junk"), "half");
	const mirror = await mirrorOf(source, cacheDir, "widgets");
	assert.equal((await git(mirror, ["config", "--get", "replay.source"])).trim(), repo.dir);
	// Two runs at once end with one mirror, marker and all, and no build folder left of theirs.
	const raced = join(root, "mirror-raced");
	const [a, b] = await Promise.all([
		mirrorOf(source, raced, "widgets"),
		mirrorOf(source, raced, "widgets"),
	]);
	assert.equal(a, b);
	assert.equal((await git(a, ["config", "--get", "replay.source"])).trim(), repo.dir);
	assert.deepEqual(
		(await readdir(raced)).filter((name) => name.includes("building")),
		[],
	);
	// A clone that fails leaves nothing at the path and nothing beside it.
	const failed = join(root, "mirror-failed");
	await assert.rejects(
		mirrorOf({ cloneUrl: () => join(root, "no-such-repository") }, failed, "widgets"),
	);
	assert.deepEqual(await readdir(failed), []);
	// ...so the next run, with a real source, is not blocked.
	assert.equal(
		(await git(await mirrorOf(source, failed, "widgets"), ["rev-parse", "HEAD"])).trim().length,
		40,
	);
});

// An interrupt of the replay: the commands that run are ended, and the code unwinds.
const SLEEP = ["-e", "setInterval(() => {}, 1000)"];

test("terminating ends a running command, and nothing starts after it until starting is allowed again", async () => {
	const running = runCommand(process.execPath, SLEEP, { input: "" });
	const outcome = assert.rejects(running, /exited|timed out/);
	await new Promise((resolve) => setTimeout(resolve, 700));
	terminateAll();
	await outcome;
	await assert.rejects(
		runCommand(process.execPath, ["-e", ""], { input: "" }),
		/was not started: the replay was interrupted/,
	);
	resumeStarting();
	assert.equal(
		await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { input: "" }),
		"ok",
	);
});

test("an interrupted run keeps the rows done, records no row as failed, and resumes", async () => {
	const out = join(root, "out-interrupted");
	const controller = new AbortController();
	const deps = standIns({ 1: ["hit"], 2: ["hit"], 3: ["hit"] });
	const review = deps.review;
	deps.review = async (prompt, dir) => {
		if (prompt.includes("ROW 2")) {
			// The signal arrives while the second row's reviewer runs, and the command ends with it.
			controller.abort();
			throw new Error("claude exited null: killed");
		}
		return review(prompt, dir);
	};
	const base = { model, setText: setOf(3), reviewer: "codex:m", judge: "claude:m", out };
	await assert.rejects(runReplay({ ...base, deps, signal: controller.signal }), /killed/);
	const saved = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
	assert.deepEqual(
		saved.rows.map((r) => [r.id, r.status]),
		[["1", "done"]],
	);
	assert.equal(existsSync(join(out, "summary.md")), false);
	// Aborted before it starts: no row at all is touched.
	await assert.rejects(
		runReplay({
			...base,
			out: join(root, "out-aborted-early"),
			deps: standIns({}),
			signal: AbortSignal.abort(),
		}),
	);
	// The resume does only what is left.
	const calls = [];
	const { totals } = await runReplay({
		...base,
		deps: standIns({ 1: ["hit"], 2: ["hit"], 3: ["hit"] }, calls),
	});
	assert.deepEqual(calls, ["prepare 2", "prepare 3"]);
	assert.equal(totals.hits, 3);
});

test("SIGINT and SIGTERM end the running model, clean up, and exit with the signal's status", async () => {
	const repo = await fixtureRepo();
	const set = join(root, "signal-set.json");
	await writeFile(set, JSON.stringify([row(1, { pre_fix: repo.preFix, fix: repo.fix })]));
	for (const [signal, status] of [
		["SIGINT", 130],
		["SIGTERM", 143],
	]) {
		const stop = new EventEmitter();
		const out = join(root, `out-signal-${signal}`);
		let base;
		let started;
		const hanging = new Promise((resolve) => {
			started = resolve;
		});
		const exits = [];
		const finished = cli(
			["--set", set, "--reviewer", "claude:m", "--judge", "codex:m", "--out", out],
			{
				stop,
				exit: (code) => exits.push(code),
				overrides: {
					source: {
						cloneUrl: () => repo.dir,
						baseOf: async () => repo.base,
						headOf: async () => "f".repeat(40),
					},
					// The reviewer of the preflight never answers: it is a process that has to be ended.
					askModel: (_engine, _prompt, cwd) => {
						base = dirname(dirname(cwd));
						started();
						return runCommand(process.execPath, SLEEP, { cwd, input: "" });
					},
				},
			},
		);
		await hanging;
		await new Promise((resolve) => setTimeout(resolve, 500));
		const stderr = console.error;
		const lines = [];
		console.error = (line) => lines.push(String(line));
		try {
			stop.emit(signal);
			// A second one while it unwinds exits at once.
			stop.emit(signal);
			assert.equal(await finished, status);
		} finally {
			console.error = stderr;
		}
		assert.deepEqual(exits, [130]);
		assert.match(lines.join("\n"), /stopping the running commands and cleaning up/);
		assert.equal(existsSync(base), false, "the preflight's folder is removed");
		assert.equal(existsSync(join(out, "results.json")), false);
		// Handlers are taken off again.
		assert.equal(stop.listenerCount("SIGINT") + stop.listenerCount("SIGTERM"), 0);
	}
	// The command line works again afterwards in the same process.
	assert.equal(
		await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { input: "" }),
		"ok",
	);
});
