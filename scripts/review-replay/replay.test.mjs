// Every row here is made up. The real replay set is read only from --set, never from this folder.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkFamilies, parseEngine } from "./engines.mjs";
import { cleanHistory, fixDiff, git } from "./history.mjs";
import { loadModel } from "./model.mjs";
import { HIDDEN_KEYS, runReplay, score, splitSet } from "./replay.mjs";

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
async function fixtureRepo() {
	const dir = join(root, "widgets.git-source");
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

test("a finding the schema refuses is dropped and a missing verdict is unsure", async () => {
	const out = join(root, "out-lenient");
	const deps = {
		prepare: async () => ({ diff: "d", fixDiff: async () => "f" }),
		review: async () =>
			JSON.stringify({
				findings: [
					finding("ok"),
					{ severity: "high", title: "no path" },
					finding("two", { line: 9 }),
				],
			}),
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
	assert.equal(rows[0].rejected, 1);
	assert.deepEqual(
		rows[0].findings.map((f) => f.verdict),
		["real", "unsure"],
	);
});
