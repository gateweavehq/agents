// The replay gate's logic, apart from the processes it starts: they are passed in, so the tests
// run it on a made-up set with stand-ins for the reviewer and the judge.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonIn } from "./engines.mjs";

/** What only the judge may see. The reviewer's view is built from the other keys by name. */
export const HIDDEN_KEYS = ["defect", "fix", "also_fix", "files", "found_by"];
export const VERDICTS = ["hit", "real", "false", "unsure"];

const criteriaList = (criteria) =>
	(Array.isArray(criteria) ? criteria : [criteria])
		.filter((item) => typeof item === "string" && item.trim())
		.map((item) => item.trim());

/**
 * Splits the replay set into what the reviewer is given and what only the judge sees, before
 * anything runs. The reviewer's view is built key by key, never by removing keys from the row.
 */
export function splitSet(raw) {
	const rows = Array.isArray(raw) ? raw : raw?.rows;
	if (!Array.isArray(rows) || rows.length === 0) throw new Error("The set holds no rows");
	const seen = new Set();
	return rows.map((row, index) => {
		const id = String(row?.row ?? index + 1);
		const at = `Row ${id}`;
		if (seen.has(id)) throw new Error(`${at} appears twice in the set`);
		seen.add(id);
		if (typeof row.repo !== "string" || !row.repo) throw new Error(`${at} has no repo`);
		if (!Number.isInteger(Number(row.pr))) throw new Error(`${at} has no pr number`);
		if (!/^[0-9a-f]{7,40}$/i.test(row.pre_fix ?? "")) throw new Error(`${at} has no pre_fix`);
		if (typeof row.defect !== "string" || !row.defect.trim())
			throw new Error(`${at} has no defect`);
		return {
			id,
			reviewer: {
				id,
				repo: row.repo,
				pr: Number(row.pr),
				pre_fix: row.pre_fix,
				criteria: criteriaList(row.criteria),
			},
			judge: {
				id,
				defect: row.defect,
				fix: row.fix ?? null,
				also_fix: row.also_fix ?? null,
				files: row.files ?? [],
				found_by: row.found_by ?? null,
			},
		};
	});
}

const FORMAT_NOTE = `There is no ${"submit_review"} tool in this run. Reply with one JSON object and nothing else:
{"findings": [{"severity", "path", "line", "side", "title", "failingCase", "criterion", "test"}]}
with the fields ${"submit_review"} takes for a finding. "test" is null or {"path", "content", "command"}.
It is not run here. The working folder is the repository at the reviewed head.`;

export function reviewPrompt(model, view, diff) {
	return `${model.REVIEW_INSTRUCTIONS}\n\n${FORMAT_NOTE}\n\n${model.reviewMessage(diff, view.criteria)}`;
}

/** Keeps every finding the product's schema accepts, as the tool does: one bad one costs only itself. */
export function parseFindings(model, reply) {
	const list = jsonIn(reply).findings;
	if (!Array.isArray(list)) throw new Error("The reply has no findings list");
	const findings = [];
	let rejected = 0;
	for (const item of list) {
		const parsed = model.reviewFinding.safeParse(item);
		if (parsed.success) findings.push(parsed.data);
		else rejected += 1;
	}
	return { findings: findings.slice(0, model.REVIEW_LIMITS.findings), rejected };
}

export function judgePrompt(view, findings, fixDiff) {
	const listed = findings
		.map((f, i) => `[${i}] ${f.path}:${f.line} ${f.title}\n    Failing case: ${f.failingCase}`)
		.join("\n");
	return `You judge the findings of a code review of a pull request. The repository in the working folder is at the head that was reviewed: read its files to check a finding.

The defect this pull request is known to have:
${view.defect}

The change that fixed it (for you only, the reviewer never saw it):
\`\`\`diff
${fixDiff}
\`\`\`

The findings:
${listed}

Mark each finding with one verdict:
- "hit": it names the defect above, whatever file it points at
- "real": it is not that defect, but its failing case follows from the code at the reviewed head, or the change above confirms it
- "false": the code, or the spec, says otherwise
- "unsure": a design choice, or too narrow to judge

Reply with one JSON object and nothing else:
{"verdicts": [{"index": 0, "verdict": "hit", "reason": "one sentence"}]}
Give one verdict for every index from 0 to ${findings.length - 1}.`;
}

/** A finding with no verdict, or an unknown one, is unsure, which counts as not real. */
export function parseVerdicts(reply, count) {
	const list = jsonIn(reply).verdicts;
	if (!Array.isArray(list)) throw new Error("The reply has no verdicts list");
	return Array.from({ length: count }, (_, index) => {
		const item = list.find((entry) => entry?.index === index);
		const ok = VERDICTS.includes(item?.verdict);
		return {
			verdict: ok ? item.verdict : "unsure",
			reason: ok && typeof item.reason === "string" ? item.reason : "No verdict given",
		};
	});
}

const isReal = (finding) => finding.verdict === "hit" || finding.verdict === "real";

/** The totals and the gate's verdict, from the rows' judged findings. Pure code. */
export function score(model, rows) {
	const bar = model.REVIEW_GATE.bar;
	const findings = rows.flatMap((row) => row.findings);
	const real = findings.filter(isReal).length;
	const unsure = findings.filter((f) => f.verdict === "unsure").length;
	const hits = rows.filter((row) => row.findings.some((f) => f.verdict === "hit")).length;
	const share = (n, of) => (of === 0 ? 0 : n / of);

	let top = 0;
	let topReal = 0;
	for (const row of rows) {
		const { shown } = model.rankFindings(
			row.findings.map((f) => ({
				...f,
				offDiff: false,
				proof: { proven: false, reason: "not run" },
			})),
		);
		top += shown.length;
		topReal += shown.filter(isReal).length;
	}

	const realShare = share(real, findings.length);
	return {
		rows: rows.length,
		hits,
		findings: findings.length,
		real,
		unsure,
		false: findings.length - real - unsure,
		realShare,
		lenientShare: share(real + unsure, findings.length),
		topPrecision: share(topReal, top),
		topFindings: top,
		bar,
		pass: hits >= bar.hits && realShare >= bar.realShare,
	};
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

export function summaryOf(rows, totals, { reviewer, judge }) {
	const lines = [
		"# Replay gate",
		"",
		`Gate: ${totals.pass ? "PASS" : "FAIL"}`,
		"",
		`- Reviewer: ${reviewer}. Judge: ${judge}.`,
		`- Hits: ${totals.hits} of ${totals.rows} rows (the bar is at least ${totals.bar.hits}).`,
		`- Real share: ${pct(totals.realShare)}, ${totals.real} real of ${totals.findings} findings, unsure counted as not real (the bar is at least ${pct(totals.bar.realShare)}).`,
	];
	if (totals.rows !== totals.bar.rows) {
		lines.push(
			`- Not the full set: ${totals.rows} rows were run, the gate is defined on ${totals.bar.rows}.`,
		);
	}
	lines.push(
		"",
		"## For information only",
		"",
		`- Lenient share, unsure counted as real: ${pct(totals.lenientShare)}.`,
		`- Precision of the top 5 of each row: ${pct(totals.topPrecision)} (${totals.topFindings} findings shown).`,
		`- Findings: ${totals.real} real, ${totals.unsure} unsure, ${totals.false} false.`,
	);
	const failed = rows.filter((row) => row.status === "failed");
	lines.push("", "## Rows that failed to run, counted as misses", "");
	if (failed.length === 0) lines.push("None.");
	for (const row of failed) lines.push(`- Row ${row.id} (${row.repo}#${row.pr}): ${row.error}`);
	lines.push(
		"",
		"## Rows",
		"",
		"| row | repo#pr | findings | real | hit |",
		"| --- | --- | --- | --- | --- |",
	);
	for (const row of rows) {
		const hit = row.findings.some((f) => f.verdict === "hit");
		lines.push(
			`| ${row.id} | ${row.repo}#${row.pr} | ${row.findings.length} | ${row.findings.filter(isReal).length} | ${hit ? "yes" : "no"} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

async function writeAtomic(file, text) {
	await writeFile(`${file}.tmp`, text);
	await rename(`${file}.tmp`, file);
}

async function readResults(file) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Runs every row of the set and writes `results.json` and `summary.md` to `out`.
 * `deps.prepare(view, dir)` builds the clean history in `dir` and returns the diff and a way to
 * read the fix for the judge; `deps.review(prompt, dir)` and `deps.judge(prompt, dir)` return a
 * model's reply. A row that fails is a miss with no findings, and runs again on a resume.
 */
export async function runReplay({ model, setText, reviewer, judge, out, deps, log = () => {} }) {
	const entries = splitSet(JSON.parse(setText));
	const setHash = createHash("sha256").update(setText).digest("hex");
	await mkdir(out, { recursive: true });
	const file = join(out, "results.json");

	const previous = await readResults(file);
	if (
		previous &&
		(previous.set !== setHash || previous.reviewer !== reviewer || previous.judge !== judge)
	) {
		throw new Error(`${file} is from another set, reviewer or judge: use another --out`);
	}
	const results = previous ?? { version: 1, set: setHash, reviewer, judge, rows: {} };

	const scratch = await mkdtemp(join(tmpdir(), "replay-"));
	try {
		for (const entry of entries) {
			if (results.rows[entry.id]?.status === "done") {
				log(`row ${entry.id}: done already`);
				continue;
			}
			const { repo, pr, pre_fix } = entry.reviewer;
			const base = { id: entry.id, repo, pr, pre_fix };
			const dir = join(scratch, entry.id, "repo");
			try {
				const history = await deps.prepare(entry.reviewer, dir);
				const { findings, rejected } = parseFindings(
					model,
					await deps.review(reviewPrompt(model, entry.reviewer, history.diff), dir),
				);
				let verdicts = [];
				if (findings.length > 0) {
					const fix = await history.fixDiff(entry.judge);
					verdicts = parseVerdicts(
						await deps.judge(judgePrompt(entry.judge, findings, fix), dir),
						findings.length,
					);
				}
				results.rows[entry.id] = {
					...base,
					status: "done",
					rejected,
					findings: findings.map((f, i) => ({ ...f, ...verdicts[i] })),
				};
			} catch (error) {
				results.rows[entry.id] = {
					...base,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
					findings: [],
				};
			} finally {
				await rm(join(scratch, entry.id), { recursive: true, force: true, maxRetries: 3 });
			}
			log(`row ${entry.id}: ${results.rows[entry.id].status}`);
			await writeAtomic(file, `${JSON.stringify(results, null, 2)}\n`);
		}
	} finally {
		await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
	}

	const rows = entries.map((entry) => results.rows[entry.id]);
	const totals = score(model, rows);
	await writeAtomic(file, `${JSON.stringify({ ...results, totals }, null, 2)}\n`);
	await writeAtomic(join(out, "summary.md"), summaryOf(rows, totals, { reviewer, judge }));
	return { totals, rows };
}
