// The replay gate: does the review agent find enough of the defects that agents' pull requests
// had, without too much noise? It holds no data. The set is read from `--set`, and the bar is
// REVIEW_GATE in @gateweave/agents-model.
//
//   node scripts/review-replay/run.mjs --set <replay-set.json> --reviewer codex:<model> \
//     --judge claude:<model> --out <dir> [--org gateweavehq]
//
// Needs git, gh (signed in, for private repositories), and the codex and claude command lines.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ask, checkFamilies, parseEngine } from "./engines.mjs";
import { cleanHistory, fixDiff, githubSource, mirrorOf } from "./history.mjs";
import { loadModel } from "./model.mjs";
import { runReplay } from "./replay.mjs";

const USAGE =
	"Usage: node scripts/review-replay/run.mjs --set <replay-set.json> --reviewer codex:<model> --judge claude:<model> --out <dir> [--org <github org>]";

export async function main(argv) {
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

	const model = await loadModel();
	const setText = await readFile(values.set, "utf8");
	const source = githubSource(values.org);
	const cacheDir = join(values.out, "cache");

	const deps = {
		async prepare(view, dir) {
			const { diff, mirror, preFix } = await cleanHistory({ source, cacheDir, dir, row: view });
			return {
				diff,
				async fixDiff(judgeView) {
					await mirrorOf(
						source,
						cacheDir,
						view.repo,
						view.pr,
						[judgeView.fix, judgeView.also_fix].filter(Boolean),
					);
					return fixDiff(mirror, preFix, judgeView.fix, judgeView.also_fix);
				},
			};
		},
		review: (prompt, dir) => ask(reviewer, prompt, dir),
		judge: (prompt, dir) => ask(judge, prompt, dir),
	};

	const { totals } = await runReplay({
		model,
		setText,
		reviewer: reviewer.spec,
		judge: judge.spec,
		out: values.out,
		deps,
		log: (line) => console.error(line),
	});
	console.log(
		`Gate: ${totals.pass ? "PASS" : "FAIL"}: ${totals.hits} hits of ${totals.rows} rows, real share ${(totals.realShare * 100).toFixed(1)}%. Wrote results.json and summary.md to ${values.out}`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(2);
	});
}
