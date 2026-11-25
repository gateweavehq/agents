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
	/(?:^|\/)(?:pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|mypy\.ini|\.coveragerc)$/,
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

/** The files a `package.json` in `directory` has its scripts name, as paths from the repository's root. */
function pathsNamedBy(directory: string, commands: readonly string[]): Set<string> {
	const named = new Set<string>();
	for (const command of commands) {
		for (const word of command.split(/[\s;&|<>()"'`=]+/)) {
			if (!SCRIPT_FILE.test(word)) continue;
			const path = resolvePath(directory, word);
			if (path !== null) named.add(path);
		}
	}
	return named;
}

/**
 * The oracles a list of changed files edits. A file that is added is never one. A `package.json`
 * counts when it is deleted, or when its scripts are not the base's: `text` reads it at the base
 * or at the branch, and a file that cannot be read is taken as changed, since it was not shown
 * to be the same. A renamed file counts by where it was. A script file counts when it is under
 * `scripts/` or when a `package.json` above it, at the base, has a script that names it.
 */
export async function reviewOracles(
	files: readonly ChangedFile[],
	text: (path: string, side: "base" | "head") => Promise<string | null>,
): Promise<OracleEdit[]> {
	const edits: OracleEdit[] = [];
	// What each directory's package.json at the base names, read once.
	const named = new Map<string, Promise<Set<string>>>();
	const namedIn = (directory: string): Promise<Set<string>> => {
		let found = named.get(directory);
		if (found === undefined) {
			const manifest = directory === "" ? "package.json" : `${directory}/package.json`;
			found = text(manifest, "base").then((body) => pathsNamedBy(directory, commandsOf(body)));
			named.set(directory, found);
		}
		return found;
	};
	const runByScript = async (path: string): Promise<boolean> => {
		if (!SCRIPT_FILE.test(path)) return false;
		const parts = path.split("/");
		for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
			if ((await namedIn(parts.slice(0, depth).join("/"))).has(path)) return true;
		}
		return false;
	};
	for (const file of files) {
		if (file.status === "added" || file.status === "copied" || file.status === "unchanged")
			continue;
		const renamed = file.status === "renamed" && file.previousPath !== undefined;
		const path = renamed ? (file.previousPath ?? file.path) : file.path;
		const kind = oracleKind(path) ?? ((await runByScript(path)) ? "check script" : null);
		if (kind === null) continue;
		const change = renamed ? "renamed" : file.status === "removed" ? "deleted" : "modified";
		if (kind === "package script" && change === "modified") {
			const [before, after] = await Promise.all([text(path, "base"), text(path, "head")]);
			const scripts = scriptsOf(before);
			if (scripts !== null && scripts === scriptsOf(after)) continue;
		}
		edits.push({ path, change, kind });
	}
	return edits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
