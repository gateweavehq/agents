/**
 * The working tree as `planApply` sees a repository: only the paths a setup writes and the folders
 * above them, which is all it looks at. Symlinks are never followed, so a setup cannot write
 * through one, and line endings are LF: a checkout with CRLF holds the same text as the setup.
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { RepositoryEntry, WrittenFile } from "@gateweave/agents-adapters";
import { MAX_FILE_LENGTH, repositoryPath } from "@gateweave/agents-model";

export interface WorkingTree {
	tree: RepositoryEntry[];
	texts: Map<string, string | null>;
}

/**
 * Stands in for whatever a folder holds, so `planApply` sees the folder. It cannot be a path a
 * setup writes: repository paths never hold a NUL.
 */
const IN_FOLDER = "\0";

export async function inspect(root: string, paths: readonly string[]): Promise<WorkingTree> {
	const tree: RepositoryEntry[] = [];
	const texts = new Map<string, string | null>();
	const seen = new Set<string>();
	for (const path of paths) {
		const segments = path.split("/");
		for (let end = 1; end <= segments.length; end++) {
			const at = segments.slice(0, end).join("/");
			if (seen.has(at)) continue;
			seen.add(at);
			const stats = await lstat(join(root, at)).catch(() => null);
			if (stats === null) break;
			if (stats.isSymbolicLink()) {
				tree.push({ path: at, symlink: true });
				break;
			}
			if (stats.isDirectory()) {
				if (end === segments.length) tree.push({ path: `${at}/${IN_FOLDER}`, symlink: false });
				continue;
			}
			tree.push({ path: at, symlink: false });
			if (end === segments.length) texts.set(at, await readText(join(root, at)));
			break;
		}
	}
	return { tree, texts };
}

async function readText(file: string): Promise<string | null> {
	const bytes = await readFile(file);
	if (bytes.length > MAX_FILE_LENGTH * 4) return null;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return text.length > MAX_FILE_LENGTH ? null : text.replaceAll("\r\n", "\n");
	} catch {
		return null;
	}
}

/** Writes what `planApply` decided, creating folders as needed. */
export async function writeChanges(root: string, changes: readonly WrittenFile[]): Promise<void> {
	const base = resolve(root);
	for (const change of changes) {
		const file = resolve(base, change.path);
		// The writers only produce safe paths; this keeps a bug in one from writing elsewhere.
		const inside = relative(base, file);
		if (!repositoryPath.safeParse(change.path).success || inside.startsWith(`..${sep}`)) {
			throw new Error(`Refusing to write outside the repository: ${change.path}`);
		}
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, change.content);
	}
}
