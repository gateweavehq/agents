/**
 * Skills share one format across agents (a folder with a `SKILL.md`), so one reader serves
 * them all. Every adapter that reads a skills folder gets identical assets, which `detect`
 * merges when two of them find the same one.
 */
import type { DetectedAsset, ScanProblem } from "@gateweave/agents-model";
import { addProblem, directoryFiles, flatFields, readText } from "./assets";
import { parseFrontMatter } from "./frontmatter";
import type { RepositoryTree } from "./types";
import { basename, compare, dirname, str, truncate, under } from "./util";

/** Skill assets under any of `roots` (such as `.claude/skills`), at the repository root or below. */
export function skillAssets(
	tree: RepositoryTree,
	roots: readonly string[],
	problems: ScanProblem[],
): DetectedAsset[] {
	const directories = [...tree.keys()]
		.filter((path) => basename(path) === "SKILL.md" && roots.some((root) => inFolder(path, root)))
		.map(dirname)
		.sort(compare);
	// A SKILL.md inside another skill's folder is one of that skill's files, not a skill.
	const kept: string[] = [];
	for (const directory of directories) {
		if (!kept.some((outer) => directory.startsWith(`${outer}/`))) kept.push(directory);
	}
	const assets: DetectedAsset[] = [];
	for (const directory of kept) {
		const asset = skillAsset(tree, directory, problems);
		if (asset) assets.push(asset);
	}
	return assets;
}

/** True for `<root>/<name>/SKILL.md`, however deep the root sits. A `SKILL.md` directly in the root is no skill. */
function inFolder(path: string, root: string): boolean {
	const found = under(path, root);
	return found !== null && found.rest !== "SKILL.md";
}

function skillAsset(
	tree: RepositoryTree,
	directory: string,
	problems: ScanProblem[],
): DetectedAsset | null {
	const text = readText(tree, `${directory}/SKILL.md`, problems);
	if (text === null) return null;
	const front = parseFrontMatter(text);
	if (!front.ok) {
		addProblem(problems, `${directory}/SKILL.md`, front.message);
		return null;
	}
	const description = str(front.data.description);
	return {
		kind: "skill",
		key: directory,
		name: truncate(str(front.data.name) ?? basename(directory), 200),
		description: description === null ? null : truncate(description, 2000),
		path: directory,
		files: directoryFiles(tree, directory, problems),
		metadata: flatFields(front.data, ["name", "description"]),
	};
}
