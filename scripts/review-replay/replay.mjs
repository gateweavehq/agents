// The replay gate's logic, apart from the processes it starts: they are passed in, so the tests
// run it on a made-up set with stand-ins for the reviewer and the judge.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonIn } from "./engines.mjs";

const REPO = /^\w[\w.-]*(\/\w[\w.-]*)?$/;
const REVISION = /^[0-9a-f]{7,40}$/i;

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
		const raw = row?.row ?? index + 1;
		if ((typeof raw !== "string" && typeof raw !== "number") || String(raw).trim() === "")
			throw new Error(`Row ${index + 1} has an id that is not a string or a number`);
		const id = String(raw);
		const at = `Row ${JSON.stringify(id)}`;
		if (seen.has(id)) throw new Error(`${at} appears twice in the set`);
		seen.add(id);
		if (typeof row.repo !== "string" || !REPO.test(row.repo)) throw new Error(`${at} has no repo`);
		for (const key of ["fix", "also_fix"]) {
			if (row[key] != null && !REVISION.test(row[key])) throw new Error(`${at} has a bad ${key}`);
		}
		if (!Number.isInteger(Number(row.pr))) throw new Error(`${at} has no pr number`);
		if (!REVISION.test(row.pre_fix ?? "")) throw new Error(`${at} has no pre_fix`);
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

/**
 * The product's instructions, then what this run is (the repository, pull request and reviewed
 * head: the only identifiers the reviewer gets) and the schema the submit_review tool validates a
 * whole submission with, then the product's message.
 */
export function reviewPrompt(model, view, diff) {
	const schema = JSON.stringify(model.reviewJsonSchema, null, 2);
	return `${model.REVIEW_INSTRUCTIONS}

This review is of pull request ${view.pr} of ${view.repo}, at the reviewed head ${view.pre_fix}. The working folder is that repository at the reviewed head. Nothing is run here, so a proposed test is not run.

There is no ${model.REVIEW_TOOL} tool in this run. Reply with one JSON object and nothing else: the input the tool takes. It is refused as a whole unless it satisfies this JSON Schema:
${schema}

${model.reviewMessage(diff, view.criteria)}`;
}

/** The reply as the product's tool takes it: the whole submission is valid, or none of it is. */
export function parseFindings(model, reply) {
	const parsed = model.reviewInput.safeParse(jsonIn(reply));
	if (!parsed.success) {
		const why = parsed.error.issues
			.slice(0, 3)
			.map((issue) => `${issue.path.join(".") || "reply"}: ${issue.message}`)
			.join("; ");
		throw new Error(`The reply is not a valid ${model.REVIEW_TOOL} input: ${why}`);
	}
	return parsed.data.findings;
}

/** `fix` is `{ diff, reason }`: a null diff says why the judge has no patch. */
export function judgePrompt(view, findings, fix) {
	const change =
		fix.diff === null
			? `The change that fixed it is not available (${fix.reason}). Judge from the defect above and the code at the reviewed head.`
			: `The change that fixed it (for you only, the reviewer never saw it):
\`\`\`diff
${fix.diff}
\`\`\``;
	const listed = findings
		.map((f, i) => `[${i}] ${f.path}:${f.line} ${f.title}\n    Failing case: ${f.failingCase}`)
		.join("\n");
	return `You judge the findings of a code review of a pull request. The repository in the working folder is at the head that was reviewed: read its files to check a finding.

The defect this pull request is known to have:
${view.defect}

${change}

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
				offDiff: Boolean(f.offDiff),
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

// A row id is whatever the set says, and sits in a table cell or a list line.
const label = (id) => id.replace(/[\r\n|`]/g, " ");

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
	for (const row of failed)
		lines.push(`- Row ${label(row.id)} (${row.repo}#${row.pr}): ${row.error}`);
	const skipped = rows.filter((row) => row.status === "skipped");
	lines.push("", "## Rows the product skips, counted as misses", "");
	if (skipped.length === 0) lines.push("None.");
	for (const row of skipped)
		lines.push(`- Row ${label(row.id)} (${row.repo}#${row.pr}): ${row.error}`);
	const unpatched = rows.filter((row) => row.fixPatch && !row.fixPatch.available);
	lines.push("", "## Rows judged without the fix patch", "");
	if (unpatched.length === 0) lines.push("None.");
	for (const row of unpatched) {
		lines.push(`- Row ${label(row.id)} (${row.repo}#${row.pr}): ${row.fixPatch.reason}`);
	}
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
			`| ${label(row.id)} | ${row.repo}#${row.pr} | ${row.findings.length} | ${row.findings.filter(isReal).length} | ${hit ? "yes" : "no"} |`,
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

const RESULTS_VERSION = 2;

/** The product does not review this pull request, so the row is a miss with no findings. */
class SkippedByProduct extends Error {}

/**
 * The checks `prepareReview` in the runtime makes before it sends a diff to the reviewer: the
 * limit on the bytes the host sends, the same limit on the decoded text's UTF-8 length (bytes that
 * are not UTF-8 decode to longer text), and the registry's limit on the whole message. A diff over
 * a limit is skipped there, not cut, so nothing the reviewer is given is ever clipped here.
 */
export function skipReason(model, history, criteria) {
	const limit = model.REVIEW_LIMITS.diffBytes;
	const text = Buffer.byteLength(history.diff, "utf8");
	const raw = history.diffBytes ?? text;
	if (raw > limit) return `The diff is ${raw} bytes, over the review limit of ${limit}`;
	if (text > limit) {
		return `The diff decodes to ${text} bytes, over the review limit of ${limit}`;
	}
	if (model.reviewMessage(history.diff, criteria).length > model.REVIEW_MESSAGE_LIMIT) {
		return "The review message is over the registry's limit";
	}
	return null;
}

/** The judge's patch as `{ diff, reason }`; a bare string is a patch that was found. */
const asFix = (fix) => (typeof fix === "string" ? { diff: fix, reason: null } : fix);

/**
 * Runs every row of the set and writes `results.json` and `summary.md` to `out`.
 * `deps.prepare(view, dir)` builds the clean history in `dir` and returns the diff and a way to
 * read the fix for the judge; `deps.review(prompt, dir)` and `deps.judge(prompt, dir)` return a
 * model's reply. A row that fails is a miss with no findings, and runs again on a resume.
 *
 * A row's id is only a label the set gives it. The rows are kept in a Map and saved as a list, and
 * every row works in a folder the system names, so no id decides a path or a property.
 */
export async function runReplay({ model, setText, reviewer, judge, out, deps, log = () => {} }) {
	const entries = splitSet(JSON.parse(setText));
	const setHash = createHash("sha256").update(setText).digest("hex");
	await mkdir(out, { recursive: true });
	const file = join(out, "results.json");

	const previous = await readResults(file);
	if (
		previous &&
		(previous.version !== RESULTS_VERSION ||
			previous.set !== setHash ||
			previous.reviewer !== reviewer ||
			previous.judge !== judge)
	) {
		throw new Error(`${file} is from another set, reviewer, judge or format: use another --out`);
	}
	const done = new Map((previous?.rows ?? []).map((row) => [row.id, row]));
	const save = () =>
		writeAtomic(
			file,
			`${JSON.stringify({ version: RESULTS_VERSION, set: setHash, reviewer, judge, rows: [...done.values()] }, null, 2)}\n`,
		);

	const scratch = await mkdtemp(join(tmpdir(), "replay-"));
	try {
		for (const entry of entries) {
			if (done.get(entry.id)?.status === "done") {
				log(`row ${entry.id}: done already`);
				continue;
			}
			const { repo, pr, pre_fix } = entry.reviewer;
			const base = { id: entry.id, repo, pr, pre_fix };
			const rowDir = await mkdtemp(join(scratch, "row-"));
			const dir = join(rowDir, "repo");
			try {
				const history = await deps.prepare(entry.reviewer, dir);
				const skipped = skipReason(model, history, entry.reviewer.criteria);
				if (skipped) throw new SkippedByProduct(skipped);
				const submitted = parseFindings(
					model,
					await deps.review(reviewPrompt(model, entry.reviewer, history.diff), dir),
				);
				// Whether a finding sits on the diff the reviewer was given, as the product decides it.
				const parsedDiff = model.parseDiff(history.diff);
				const findings = submitted.map((f) => ({
					...f,
					offDiff: !model.lineOnDiff(parsedDiff, f),
				}));
				let verdicts = [];
				let fixPatch = null;
				if (findings.length > 0) {
					const fix = asFix(await history.fixDiff(entry.judge));
					fixPatch = { available: fix.diff !== null, reason: fix.reason ?? null };
					verdicts = parseVerdicts(
						await deps.judge(judgePrompt(entry.judge, findings, fix), dir),
						findings.length,
					);
				}
				done.set(entry.id, {
					...base,
					status: "done",
					fixPatch,
					findings: findings.map((f, i) => ({ ...f, ...verdicts[i] })),
				});
			} catch (error) {
				done.set(entry.id, {
					...base,
					status: error instanceof SkippedByProduct ? "skipped" : "failed",
					error: error instanceof Error ? error.message : String(error),
					findings: [],
				});
			} finally {
				await rm(rowDir, { recursive: true, force: true, maxRetries: 3 });
			}
			log(`row ${entry.id}: ${done.get(entry.id)?.status}`);
			await save();
		}
	} finally {
		await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
	}

	const rows = entries.map((entry) => done.get(entry.id));
	const totals = score(model, rows);
	await writeAtomic(
		file,
		`${JSON.stringify({ version: RESULTS_VERSION, set: setHash, reviewer, judge, rows, totals }, null, 2)}\n`,
	);
	await writeAtomic(join(out, "summary.md"), summaryOf(rows, totals, { reviewer, judge }));
	return { totals, rows };
}
