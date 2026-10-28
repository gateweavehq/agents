/** A Markdown file with front matter as one asset: a command, a rule or a subagent's definition. */
import type { AssetKind, DetectedAsset, Metadata, ScanProblem } from "@gateweave/agents-model";
import { addProblem, readText } from "./assets";
import { parseFrontMatter } from "./frontmatter";
import type { RepositoryTree } from "./types";
import { basename, truncate } from "./util";

export interface Described {
	name: string;
	description: string | null;
	metadata: Metadata;
}

export function markdownAsset(
	tree: RepositoryTree,
	path: string,
	kind: AssetKind,
	problems: ScanProblem[],
	describe: (data: Record<string, unknown>, body: string) => Described,
	options: { lenient?: boolean } = {},
): { asset: DetectedAsset; data: Record<string, unknown> } | null {
	const text = readText(tree, path, problems);
	if (text === null) return null;
	const front = parseFrontMatter(text, options);
	if (!front.ok) {
		addProblem(problems, path, front.message);
		return null;
	}
	const { name, description, metadata } = describe(front.data, front.body);
	return {
		data: front.data,
		asset: {
			kind,
			key: path,
			name: truncate(name, 200),
			description: description === null ? null : truncate(description, 2000),
			path,
			files: [{ path: basename(path), content: text }],
			metadata,
		},
	};
}
