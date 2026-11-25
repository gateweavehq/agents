/**
 * The files that decide whether an agent's own checks pass. An agent that can change a
 * test, a `package.json` script, the CI workflows or the lint configuration can make its checks
 * pass without making the work right, so a green check proves little when the diff touches one.
 * `open_pull_request` looks for such edits in what it pushed: a pull request that has any is
 * opened as a draft, and the tool's section lists the paths. Adding a file is never an edit:
 * a new test only asks more of the work.
 *
 * These are the pure parts: which paths are oracles, and what a list of changed files comes to.
 */

/** What a path is for, in the words the pull request uses. */
export type OracleKind = "test" | "package script" | "check script" | "CI" | "lint or type config";

/** One edit to an oracle: the path, how it changed, and what it is. */
export interface OracleEdit {
	path: string;
	change: "modified" | "deleted" | "renamed";
	kind: OracleKind;
}

/**
 * What the review of a branch found: the edits (none for a clean one), or why it could not tell,
 * which is as much a reason for a draft as an edit is.
 */
export type OracleReview = { edits: OracleEdit[] } | { unverified: string };

/** A file the branch changes, as the pull request port lists it (`./pull-requests.ts`). */
export interface ChangedFile {
	path: string;
	status: string;
	previousPath?: string;
}

const TEST_FOLDERS = new Set([
	"test",
	"tests",
	"__tests__",
	"__mocks__",
	"__snapshots__",
	"__fixtures__",
	"fixtures",
	"e2e",
	"spec",
	"specs",
]);

const TEST_NAME = [
	/\.(?:test|spec)\.[^/]+$/,
	/(?:^|\/)test_[^/]+\.py$/,
	/_test\.(?:go|py|rb|rs|exs?)$/,
	/(?:Test|Tests|Spec)\.(?:java|kt|swift|cs|php)$/,
	// What pytest reads: an `addopts = --ignore=...` here can leave a failing test out of a run.
	/(?:^|\/)\.?pytest\.ini$/,
	/(?:^|\/)conftest\.py$/,
	/(?:^|\/)(?:vitest|jest|playwright|cypress|karma)(?:\.[\w-]+)*\.config\.[^/]+$/,
	// Vite's config can hold the Vitest one.
	/(?:^|\/)vite(?:st)?\.(?:workspace|config)\.[^/]+$/,
	/\.snap$/,
];

const CONFIG_NAME = [
	/(?:^|\/)biome\.jsonc?$/,
	/(?:^|\/)\.eslintrc(?:\.[^/]+)?$/,
	/(?:^|\/)\.eslintignore$/,
	/(?:^|\/)eslint\.config\.[^/]+$/,
	/(?:^|\/)\.prettierrc(?:\.[^/]+)?$/,
	/(?:^|\/)\.prettierignore$/,
	/(?:^|\/)prettier\.config\.[^/]+$/,
	/(?:^|\/)\.stylelintrc(?:\.[^/]+)?$/,
	/(?:^|\/)stylelint\.config\.[^/]+$/,
	/(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/,
	/(?:^|\/)\.golangci\.[^/]+$/,
	/(?:^|\/)ruff\.toml$/,
	/(?:^|\/)\.flake8$/,
	/(?:^|\/)\.pylintrc$/,
	/(?:^|\/)\.rubocop\.yml$/,
	/(?:^|\/)clippy\.toml$/,
	/(?:^|\/)(?:pyproject\.toml|setup\.cfg|tox\.ini|mypy\.ini|\.coveragerc)$/,
];

/** The kind of oracle a path is, or null for a file that is not one. */
export function oracleKind(path: string): OracleKind | null {
	if (path.startsWith(".github/")) return "CI";
	// The scripts a repository keeps at its top level are what `pnpm check` and the like run.
	if (path.startsWith("scripts/")) return "check script";
	if (/(?:^|\/)package\.json$/.test(path)) return "package script";
	if (CONFIG_NAME.some((pattern) => pattern.test(path))) return "lint or type config";
	if (path.split("/").some((part) => TEST_FOLDERS.has(part))) return "test";
	if (TEST_NAME.some((pattern) => pattern.test(path))) return "test";
	return null;
}

/** The `scripts` of a package.json's text: null when it is not JSON or has none to compare. */
function scriptsOf(text: string | null): string | null {
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return null;
		const scripts = (parsed as { scripts?: unknown }).scripts;
		// Sorted, so a reordered script is not an edit but a changed one is.
		return JSON.stringify(
			scripts && typeof scripts === "object"
				? Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)))
				: {},
		);
	} catch {
		return null;
	}
}

/** The commands of a package.json's `scripts`; none when it is not JSON or has no scripts. */
function commandsOf(text: string | null): string[] {
	if (text === null) return [];
	try {
		const scripts: unknown = (JSON.parse(text) as { scripts?: unknown } | null)?.scripts;
		if (typeof scripts !== "object" || scripts === null) return [];
		return Object.values(scripts).filter(
			(command): command is string => typeof command === "string",
		);
	} catch {
		return [];
	}
}

/** `path` joined to `directory` with its `.` and `..` parts taken out; null when it leaves the repository. */
function resolvePath(directory: string, path: string): string | null {
	const parts = directory === "" ? [] : directory.split("/");
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.pop() === undefined) return null;
		} else parts.push(part);
	}
	return parts.join("/");
}

/** A file a script can run: the paths a `package.json` script names are looked at only for these. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|sh|py|rb|ps1)$/;

/**
 * A flag that has a tool run somewhere else than where the command stands (`pnpm --dir tools`,
 * `npm --prefix tools`, `make -C tools`, `--filter`): a relative path after one is not the
 * command's own place.
 */
const MOVES_ELSEWHERE =
	/^(?:-C|--cwd|--dir|--directory|--prefix|--workspaces?|-w|-ws|--filter|-F|--recursive|-r)(?:=|$)/;

/** What the scripts of one `package.json` name. */
interface NamedFiles {
	/** Paths from the repository's root. */
	paths: Set<string>;
	/** File names a script runs from a place that could not be told, as patterns over the name. */
	unplaced: RegExp[];
}

/** A pattern for the file name a script runs from a place that could not be told. */
function unplacedPattern(word: string): RegExp {
	const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
	// A brace or bracket can stand for any name.
	if (/[[{]/.test(name)) return /^/;
	const literal = name.split(/[*?$~`]+/).map((part) => part.replace(/[.+^$|()\\]/g, "\\$&"));
	return new RegExp(`^${literal.join("[^/]*")}$`);
}

/** The directory a `cd` in a command goes to; null when that cannot be told. */
function directoryAfter(
	command: string,
	from: string | null,
	grouped: boolean,
	rest: string | undefined,
): string | null {
	if (from === null || grouped || command !== "cd") return null;
	const target = (rest ?? "")
		.split(/\s+/)
		.find((part) => part !== "" && !["--", "-P", "-L", "-e", "-@"].includes(part));
	if (target === undefined || target === "-") return null;
	const quoted = /^(["'])(.*)\1$/.exec(target);
	if (quoted === null && /^["']/.test(target)) return null;
	const path = quoted?.[2] ?? target;
	// A variable, a glob, `~`, a Windows or an absolute path says nothing about the repository.
	if (path === "" || /[$*?[{~`\\]/.test(path) || /^(?:\/|[A-Za-z]:)/.test(path)) return null;
	return resolvePath(from, path);
}

/**
 * The files a `package.json` in `directory` has its scripts name. A command is read as the shell
 * runs it: its `cd` moves where the words after it are looked for. A file named from a place
 * that cannot be told (a `cd` into a variable, a subshell, `--dir`, a glob or a variable in the
 * path) is not placed, so that a changed file of that name is not taken for an unrelated one.
 */
function pathsNamedBy(directory: string, commands: readonly string[]): NamedFiles {
	const named: NamedFiles = { paths: new Set(), unplaced: [] };
	for (const command of commands) {
		// After a subshell, a group, a substitution, a pipe or a background job, which directory a
		// later word is read in is not told.
		const grouped = /[(){}`]|(?<![|&>])[|&](?![|&])/.test(command);
		let cwd: string | null = directory;
		for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
			const text = segment.trim().replace(/^[({!\s]+/, "");
			const move = /^(cd|pushd|popd|chdir)(?:\s+(.*))?$/.exec(text);
			if (move !== null) {
				cwd = directoryAfter(move[1] ?? "", cwd, grouped, move[2]);
				continue;
			}
			const here =
				cwd !== null && !text.split(/\s+/).some((token) => MOVES_ELSEWHERE.test(token))
					? cwd
					: null;
			for (const word of text.split(/[\s()"'`<>=]+/)) {
				if (!SCRIPT_FILE.test(word)) continue;
				if (here === null || /[\\$*?[{~]/.test(word) || /^(?:\/|[A-Za-z]:)/.test(word)) {
					named.unplaced.push(unplacedPattern(word));
					continue;
				}
				const path = resolvePath(here, word);
				if (path !== null) named.paths.add(path);
			}
		}
	}
	return named;
}

/**
 * What the oracles a list of changed files edits come to. A file that is added is never one. A
 * `package.json` counts when it is deleted, or when its scripts are not the base's: `text` reads
 * it at the base or at the branch, and a file that cannot be read is taken as changed, since it
 * was not shown to be the same. A renamed file counts by where it was. A script file counts when
 * it is under `scripts/` or when a `package.json` above it, at the base, has a script that names
 * it. When that cannot be told, because such a `package.json` cannot be read (`text` throws; it
 * returns null for a file that is not there) or a script runs a file of that name from a place
 * that cannot be told, the review is unverified.
 */
export async function reviewOracles(
	files: readonly ChangedFile[],
	text: (path: string, side: "base" | "head") => Promise<string | null>,
): Promise<OracleReview> {
	const edits: OracleEdit[] = [];
	let unverified: string | null = null;
	// What each directory's package.json at the base names, read once; why it cannot be told if not.
	const named = new Map<string, Promise<NamedFiles | string>>();
	const manifestOf = (directory: string) =>
		directory === "" ? "package.json" : `${directory}/package.json`;
	const namedIn = (directory: string): Promise<NamedFiles | string> => {
		let found = named.get(directory);
		if (found === undefined) {
			found = text(manifestOf(directory), "base").then(
				(body) => pathsNamedBy(directory, commandsOf(body)),
				() => `the base's ${manifestOf(directory)} could not be read`,
			);
			named.set(directory, found);
		}
		return found;
	};
	/** Whether a package.json runs the file; a reason when that cannot be told. */
	const runByScript = async (path: string): Promise<boolean | string> => {
		if (!SCRIPT_FILE.test(path)) return false;
		const parts = path.split("/");
		const name = parts[parts.length - 1] ?? path;
		let unknown: string | null = null;
		for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
			const directory = parts.slice(0, depth).join("/");
			const found = await namedIn(directory);
			if (typeof found === "string") {
				unknown ??= found;
			} else if (found.paths.has(path)) {
				return true;
			} else if (found.unplaced.some((pattern) => pattern.test(name))) {
				unknown ??= `a script of the base's ${manifestOf(directory)} runs a file named like ${path} from a place that cannot be told`;
			}
		}
		return unknown ?? false;
	};
	for (const file of files) {
		if (file.status === "added" || file.status === "copied" || file.status === "unchanged")
			continue;
		const renamed = file.status === "renamed" && file.previousPath !== undefined;
		const path = renamed ? (file.previousPath ?? file.path) : file.path;
		let kind = oracleKind(path);
		if (kind === null) {
			const run = await runByScript(path);
			if (typeof run === "string") {
				unverified ??= run;
				continue;
			}
			if (run) kind = "check script";
		}
		if (kind === null) continue;
		const change = renamed ? "renamed" : file.status === "removed" ? "deleted" : "modified";
		if (kind === "package script" && change === "modified") {
			// A file that cannot be read is not shown to be the same.
			const [before, after] = await Promise.all([
				text(path, "base").catch(() => null),
				text(path, "head").catch(() => null),
			]);
			const scripts = scriptsOf(before);
			if (scripts !== null && scripts === scriptsOf(after)) continue;
		}
		edits.push({ path, change, kind });
	}
	if (unverified !== null) return { unverified };
	return { edits: edits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
}
