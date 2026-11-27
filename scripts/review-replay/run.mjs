// The replay gate: does the review agent find enough of the defects that agents' pull requests
// had, without too much noise? It holds no data. The set is read from `--set`, and the bar is
// REVIEW_GATE in @gateweave/agents-model.
//
//   node scripts/review-replay/run.mjs --set <replay-set.json> --reviewer claude:<model> \
//     --judge codex:<model> --out <dir> [--org gateweavehq]
//
// Needs git, gh (signed in, for private repositories), and the codex and claude command lines.
// The reviewer reads only the replay checkout (see reviewerLaunch in engines.mjs). Codex cannot
// enforce that on Windows, so there the reviewer is claude and the judge is codex. Before any row,
// a preflight runs the reviewer, started the way the rows start it (plus --output-format
// stream-json --verbose), and reads its transcript: a successful Read of a canary inside its
// checkout, refused calls on canaries outside it, and a refused or absent way to the network. A
// leak, or a transcript that does not prove it all, stops the run with nothing written. Only a
// claude reviewer can be proven for now: a codex reviewer is refused.
// The exit status is 0 for a pass, 1 for a failed gate, 2 for an error that stopped the run, and
// 130 or 143 when SIGINT or SIGTERM stopped it (rows done are kept; run it again to resume).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ask, checkFamilies, checkReviewerBoundary, parseEngine } from "./engines.mjs";
import { cleanHistory, fixPatch, githubSource } from "./history.mjs";
import { resumeStarting, terminateAll } from "./launcher.mjs";
import { loadModel } from "./model.mjs";
import { preflight } from "./preflight.mjs";
import { runReplay, splitSet } from "./replay.mjs";

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
	// A set that cannot be used is found before a model is asked anything.
	splitSet(JSON.parse(setText));
	const source = overrides.source ?? githubSource(values.org);
	const askModel = overrides.askModel ?? ask;
	// Once, before any path is made from it: a relative --out is read against the folder the run
	// started in, and every git command runs in some other folder.
	const out = resolve(values.out);
	const cacheDir = join(out, "cache");

	await preflight({ reviewer, askModel: (...args) => askModel(...args), source, cacheDir });

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
		org: values.org,
		out,
		deps,
		signal: overrides.signal,
		log: (line) => console.error(line),
	});
	console.log(
		`Gate: ${totals.pass ? "PASS" : "FAIL"}: ${totals.hits} hits of ${totals.rows} rows, real share ${(totals.realShare * 100).toFixed(1)}%. Wrote results.json and summary.md to ${out}`,
	);
	return { totals };
}

/** A failed gate is a failed command: 0 for a pass, 1 for a fail. */
export const gateExitCode = (totals) => (totals.pass ? 0 : 1);

/**
 * Runs `main` for the command line. An interrupt (SIGINT, SIGTERM) ends the model and git commands
 * that run, lets the code unwind so the reviewer's home folder and the scratch folders are removed,
 * and exits with the signal's status after that. A second one exits at once.
 */
export async function cli(argv, { exit = process.exit, stop = process, overrides = {} } = {}) {
	const controller = new AbortController();
	let interrupted = null;
	const handlers = ["SIGINT", "SIGTERM"].map((name) => {
		const handler = () => {
			if (interrupted) return exit(130);
			interrupted = name;
			console.error(`${name}: stopping the running commands and cleaning up`);
			controller.abort();
			terminateAll();
		};
		stop.on(name, handler);
		return [name, handler];
	});
	try {
		const { totals } = await main(argv, { ...overrides, signal: controller.signal });
		return gateExitCode(totals);
	} catch (error) {
		if (interrupted) {
			console.error("The replay was interrupted. Done rows are kept: run it again to resume.");
			return interrupted === "SIGINT" ? 130 : 143;
		}
		console.error(error instanceof Error ? error.message : error);
		return 2;
	} finally {
		for (const [name, handler] of handlers) stop.off(name, handler);
		resumeStarting();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	cli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
