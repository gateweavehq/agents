// The replay gate: does the review agent find enough of the defects that agents' pull requests
// had, without too much noise? It holds no data. The set is read from `--set`, and the bar is
// REVIEW_GATE in @gateweave/agents-model.
//
//   node scripts/review-replay/run.mjs --set <replay-set.json> --reviewer claude:<model> \
//     --judge codex:<model> --out <dir> [--org gateweavehq]
//
// Needs git, gh (signed in, for private repositories), and the codex and claude command lines.
// The reviewer reads only the replay checkout (see reviewerLaunch in engines.mjs). Codex cannot
// enforce that on Windows, so there the reviewer is claude and the judge is codex.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ask, checkFamilies, checkReviewerBoundary, parseEngine } from "./engines.mjs";
import { cleanHistory, fixPatch, githubSource } from "./history.mjs";
import { loadModel } from "./model.mjs";
import { runReplay } from "./replay.mjs";

const USAGE =
	"Usage: node scripts/review-replay/run.mjs --set <replay-set.json> --reviewer <codex|claude>:<model> --judge <claude|codex>:<model> --out <dir> [--org <github org>]";

/**
 * `overrides` is for tests: `source` replaces GitHub, `askModel` replaces the command lines, and
 * `platform` replaces the system the boundary of the reviewer is checked for.
 */
export async function main(argv, overrides = {}) {
	const { values } = parseArgs({
		args: argv,
		options: {
			set: { type: "string" },
			reviewer: { type: "string" },
			judge: { type: "string" },
			out: { type: "string" },
			org: { type: "string", default: "gateweavehq" },
		},
	});
	if (!values.set || !values.reviewer || !values.judge || !values.out) throw new Error(USAGE);
	// Before anything is read or started.
	const reviewer = parseEngine(values.reviewer, "--reviewer");
	const judge = parseEngine(values.judge, "--judge");
	checkFamilies(reviewer, judge);
	checkReviewerBoundary(reviewer, overrides.platform);

	const model = await loadModel();
	const setText = await readFile(values.set, "utf8");
	const source = overrides.source ?? githubSource(values.org);
	const askModel = overrides.askModel ?? ask;
	// Once, before any path is made from it: a relative --out is read against the folder the run
	// started in, and every git command runs in some other folder.
	const out = resolve(values.out);
	const cacheDir = join(out, "cache");

	const deps = {
		async prepare(view, dir) {
			const { diff, mirror, preFix } = await cleanHistory({ source, cacheDir, dir, row: view });
			return {
				diff,
				fixDiff: (judgeView) =>
					fixPatch({
						source,
						mirror,
						repo: view.repo,
						pr: view.pr,
						preFix,
						fix: judgeView.fix,
						alsoFix: judgeView.also_fix,
					}),
			};
		},
		review: (prompt, dir) => askModel(reviewer, prompt, dir, { role: "reviewer" }),
		judge: (prompt, dir) => askModel(judge, prompt, dir, { role: "judge" }),
	};

	const { totals } = await runReplay({
		model,
		setText,
		reviewer: reviewer.spec,
		judge: judge.spec,
		out,
		deps,
		log: (line) => console.error(line),
	});
	console.log(
		`Gate: ${totals.pass ? "PASS" : "FAIL"}: ${totals.hits} hits of ${totals.rows} rows, real share ${(totals.realShare * 100).toFixed(1)}%. Wrote results.json and summary.md to ${out}`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	});
}
