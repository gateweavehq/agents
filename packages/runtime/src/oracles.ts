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

/** The files a task runner keeps its commands in, at any depth. */
const BUILD_FILE = /(?:^|\/)(?:Makefile|justfile|Taskfile\.yml|noxfile\.py)$/;

/** The kind of oracle a path is, or null for a file that is not one. */
export function oracleKind(path: string): OracleKind | null {
	if (path.startsWith(".github/")) return "CI";
	// The scripts a repository keeps at its top level are what `pnpm check` and the like run.
	if (path.startsWith("scripts/")) return "check script";
	// The files a task runner reads its commands from.
	if (BUILD_FILE.test(path)) return "check script";
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

/** The most `package.json` files at the base that are read; a base with more is not reviewed. */
export const MANIFESTS_LIMIT = 40;

/** The words of a script, as what is left of it after whitespace, quotes and shell operators. */
function wordsOf(command: string): string[] {
	const words: string[] = [];
	for (const found of command.split(/[\s"'`;&|<>()=]+/)) {
		// A variable, a glob or a brace names no file, and nothing is guessed about what it stands for.
		if (/[$*?{[]/.test(found)) continue;
		// The place the script stands in is not looked at, so `./x.mjs` and `../x.mjs` are `x.mjs`.
		let word = found;
		while (word.startsWith("./") || word.startsWith("../"))
			word = word.slice(word.indexOf("/") + 1);
		if (word === "" || word === "." || word === "..") continue;
		words.push(word);
	}
	return words;
}

/** Whether a word of a script names the file: the path ends with the word at a path boundary. */
function isNamed(words: ReadonlySet<string>, path: string): boolean {
	let start = 0;
	for (;;) {
		if (words.has(path.slice(start))) return true;
		const slash = path.indexOf("/", start);
		if (slash < 0) return false;
		start = slash + 1;
	}
}

/** Where the `package.json` files of the base are, and whether that is all of them. */
export interface BaseManifests {
	paths: string[];
	complete: boolean;
}

/**
 * What the oracles a list of changed files edits come to. A file that is added is never one. A
 * `package.json` counts when it is deleted, or when its scripts are not the base's: `text` reads
 * it at the base or at the branch, and a file that cannot be read is taken as changed, since it
 * was not shown to be the same. A renamed file counts by where it was.
 *
 * Any other file that existed at the base counts as a check script when a word of a script of a
 * `package.json` at the base names it: the file's path ends with the word at a path boundary.
 * That is all of the reading: no directory, no `cd`, no `sh -c`, and a word with a variable, a
 * glob or a brace names nothing. `manifests` lists the `package.json` files of the base tree. The
 * review is unverified, a reason for a draft as an edit is, when that tree or one of those files
 * cannot be read (`text` throws; it returns null for a file that is not there), or when the tree
 * has more than `MANIFESTS_LIMIT` of them.
 */
export async function reviewOracles(
	files: readonly ChangedFile[],
	text: (path: string, side: "base" | "head") => Promise<string | null>,
	manifests: () => Promise<BaseManifests>,
): Promise<OracleReview> {
	const edits: OracleEdit[] = [];
	let unverified: string | null = null;
	// The words of every script at the base, read once; why they cannot be told if not.
	let words: Promise<Set<string> | string> | undefined;
	const readWords = async (): Promise<Set<string> | string> => {
		let listed: BaseManifests;
		try {
			listed = await manifests();
		} catch {
			return "the base's file tree could not be read";
		}
		if (!listed.complete) return "the base's file tree is too large to be listed in full";
		if (listed.paths.length > MANIFESTS_LIMIT) {
			return `the base has ${listed.paths.length} package.json files, and more than ${MANIFESTS_LIMIT} are not read`;
		}
		const named = new Set<string>();
		for (const manifest of listed.paths) {
			let body: string | null;
			try {
				body = await text(manifest, "base");
			} catch {
				return `the base's ${manifest} could not be read`;
			}
			for (const command of commandsOf(body)) {
				for (const word of wordsOf(command)) named.add(word);
			}
		}
		return named;
	};
	for (const file of files) {
		if (file.status === "added" || file.status === "copied" || file.status === "unchanged")
			continue;
		const renamed = file.status === "renamed" && file.previousPath !== undefined;
		const path = renamed ? (file.previousPath ?? file.path) : file.path;
		let kind = oracleKind(path);
		if (kind === null) {
			words ??= readWords();
			const named = await words;
			if (typeof named === "string") {
				unverified ??= named;
				continue;
			}
			if (isNamed(named, path)) kind = "check script";
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
