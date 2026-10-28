/**
 * `gateweave-agents`: writes a setup into a working tree the way the app's pull request would,
 * and checks in CI that the tree still holds it. The planning is the adapters' own, so the CLI,
 * the pull request and the registry's drift agree on every file.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { planApply, writeAssets } from "@gateweave/agents-adapters";
import { RUNTIME_NAMES } from "@gateweave/agents-model";
import { version } from "../package.json";
import { loadSetup, READY_MADE } from "./setups";
import { inspect, writeChanges } from "./working-tree";

export interface Io {
	cwd: string;
	out: (line: string) => void;
	err: (line: string) => void;
}

/** Exit codes: a check that found differences, and anything that stopped a command. */
const DIFFERS = 1;
const FAILED = 2;

const HELP = `Usage: gateweave-agents <command> [options]

Commands:
  apply <setup>   Write the setup into the working tree
  check <setup>   Exit with ${DIFFERS} when the working tree no longer holds what the setup writes
  list            List the ready-made setups

<setup> is a folder with a setup.json, or the name of a ready-made setup.

Options:
  --dir <path>    The repository's working tree (default: the current folder)
  --dry-run       With apply: say what would be written, and write nothing
  -h, --help      Show this help
  -v, --version   Show the version`;

export async function run(args: readonly string[], io: Io): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(args);
	} catch (error) {
		io.err(`${message(error)}\n\n${HELP}`);
		return FAILED;
	}
	const { values, positionals } = parsed;
	if (values.version) {
		io.out(version);
		return 0;
	}
	const [command, target, ...extra] = positionals;
	if (values.help || command === undefined) {
		(values.help ? io.out : io.err)(HELP);
		return values.help ? 0 : FAILED;
	}

	if (command === "list") return extra.length > 0 || target ? usage(io) : list(io);
	if (command !== "apply" && command !== "check") {
		io.err(`Unknown command: ${command}\n\n${HELP}`);
		return FAILED;
	}
	if (target === undefined || extra.length > 0) return usage(io);
	if (values["dry-run"] && command === "check") return usage(io, "--dry-run is for apply");
	try {
		return await applyOrCheck(command, target, values.dir, values["dry-run"] === true, io);
	} catch (error) {
		io.err(message(error));
		return FAILED;
	}
}

function parse(args: readonly string[]) {
	return parseArgs({
		args: [...args],
		allowPositionals: true,
		options: {
			dir: { type: "string" },
			"dry-run": { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}

function usage(io: Io, reason = "Wrong number of arguments"): number {
	io.err(`${reason}\n\n${HELP}`);
	return FAILED;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function list(io: Io): number {
	for (const name of READY_MADE.keys()) io.out(name);
	return 0;
}

async function applyOrCheck(
	command: "apply" | "check",
	target: string,
	dir: string | undefined,
	dryRun: boolean,
	io: Io,
): Promise<number> {
	const loaded = await loadSetup(target, io.cwd);
	if (!loaded.ok) {
		io.err(`Cannot read ${loaded.from}:`);
		for (const problem of loaded.problems) io.err(`  ${problem}`);
		return FAILED;
	}
	const { setup } = loaded;
	const root = resolve(io.cwd, dir ?? ".");
	const written = writeAssets(setup.assets, setup.runtimes);
	const paths = written.files.map((file) => file.path);
	const tree = await inspect(root, paths);
	const plan = planApply({ files: written.files, ...tree });
	const existing = new Set(tree.tree.map((entry) => entry.path));
	const runtimes = setup.runtimes.map((runtime) => RUNTIME_NAMES[runtime]).join(", ");

	if (command === "apply") {
		const verb = dryRun ? "would write" : "wrote";
		io.out(`${dryRun ? "Would apply" : "Applying"} ${setup.name} (${runtimes}) to ${root}`);
		if (!dryRun) await writeChanges(root, plan.changes);
		for (const change of plan.changes) io.out(`  ${verb}  ${change.path}`);
		io.out(
			`${plan.changes.length} ${files(plan.changes.length)} ${dryRun ? "to write" : "written"}, ` +
				`${plan.unchanged.length} already up to date.`,
		);
	} else {
		io.out(`Checking ${root} against ${setup.name} (${runtimes})`);
		for (const change of plan.changes) {
			io.out(`  ${existing.has(change.path) ? "differs" : "missing"}  ${change.path}`);
		}
		if (plan.changes.length === 0) {
			io.out(`All ${plan.unchanged.length} ${files(plan.unchanged.length)} hold what it writes.`);
		} else {
			const total = plan.changes.length + plan.unchanged.length;
			io.out(
				`${plan.changes.length} of ${total} ${files(total)} differ from the setup. ` +
					`Run \`gateweave-agents apply ${target}\` to write them.`,
			);
		}
	}
	report(
		io,
		"Left alone",
		plan.problems.map(({ path, message }) => `${path}: ${message}`),
	);
	report(
		io,
		"Not written",
		written.problems.map(({ asset, message }) => `${asset}: ${message}`),
	);
	return command === "check" && plan.changes.length > 0 ? DIFFERS : 0;
}

function files(count: number): string {
	return count === 1 ? "file" : "files";
}

/** Problems are warnings: a repository may keep CLAUDE.md as a symlink on purpose. */
function report(io: Io, title: string, lines: readonly string[]): void {
	if (lines.length === 0) return;
	io.err(`${title}:`);
	for (const line of lines) io.err(`  ${line}`);
}
