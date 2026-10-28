/**
 * Scanning one repository: read the default branch's tree, bring the text of the files the
 * adapters want, and let them detect the agents and assets. Texts the registry already holds,
 * by blob id, are not downloaded again, so a scan after a push downloads what the push changed.
 */
import { detect, type TreeFile, wantsFile } from "@gateweave/agents-adapters";
import {
	MAX_FILE_LENGTH,
	MAX_SCANNED_FILES,
	repositoryPath,
	type ScannedTreeFile,
	type ScanProblem,
	type ScanResult,
} from "@gateweave/agents-model";
import { eq } from "drizzle-orm";
import { blobs } from "./db/schema";
import type { Db } from "./state";

/** A file in the repository's tree. A symlink's text is the path it points to. */
export interface SourceFile {
	path: string;
	blob: string;
	size: number;
	symlink: boolean;
}

/** Where a scan reads one repository from. GitHub is the only one so far. */
export interface RepositorySource {
	/** The commit the default branch points to, and its tree. */
	head(): Promise<{ commit: string; tree: string }>;
	files(tree: string): Promise<{ files: SourceFile[]; truncated: boolean }>;
	/** Texts by blob id; null for a blob that is binary or cannot be read as text. */
	texts(blobIds: string[]): Promise<Map<string, string | null>>;
}

/** What the last scan left on the repository. */
export interface LastScan {
	scannedCommit: string | null;
	scanError: string | null;
}

/**
 * Reads the repository and detects what it holds. Null when the default branch is still at the
 * commit the last successful scan read, unless the scan is forced.
 */
export async function scanRepository(
	db: Db,
	source: RepositorySource,
	last: LastScan,
	startedAt: number,
	force = false,
): Promise<ScanResult | null> {
	const head = await source.head();
	if (!force && head.commit === last.scannedCommit && last.scanError === null) return null;
	const listing = await source.files(head.tree);
	const problems: ScanProblem[] = [];
	if (listing.truncated) {
		problems.push({
			path: null,
			message: "The repository has too many files to read; some were left out",
		});
	}

	const files = new Map(listing.files.map((file) => [file.path, file]));
	const tree = new Map<string, TreeFile>();
	const wanted: SourceFile[] = [];
	const links: SourceFile[] = [];
	for (const file of listing.files) {
		const want = wantsFile(file.path);
		if (file.symlink) {
			if (want) links.push(file);
			continue;
		}
		tree.set(file.path, { blob: file.blob, size: file.size });
		if (want) wanted.push(file);
	}

	const texts = await readTexts(db, source, [...wanted, ...links]);

	// A wanted symlink, such as a CLAUDE.md that points to AGENTS.md, stands for its target.
	const targets = new Map<string, SourceFile>();
	for (const link of links) {
		const text = texts.get(link.blob);
		const path = text ? resolveLink(link.path, text.trim()) : null;
		const target = path === null ? undefined : files.get(path);
		if (!target || target.symlink) {
			problems.push({
				path: link.path,
				message:
					"A symlink to a file outside the repository, or to another symlink, is not followed",
			});
			continue;
		}
		targets.set(link.path, target);
	}
	const more = [...targets.values()].filter((target) => !texts.has(target.blob));
	for (const [blob, text] of await readTexts(db, source, more)) texts.set(blob, text);

	for (const file of wanted) setText(tree, file.path, file, texts);
	for (const [path, target] of targets) setText(tree, path, target, texts);

	const read = scannedFiles([...wanted, ...links], texts);
	if (read.length > MAX_SCANNED_FILES) {
		problems.push({
			path: null,
			message: `Agents read more than ${MAX_SCANNED_FILES.toLocaleString("en")} files here; drift follows the first ones by path`,
		});
		read.length = MAX_SCANNED_FILES;
	}
	const detection = detect(tree);
	return {
		commit: head.commit,
		scannedAt: startedAt,
		agents: detection.agents,
		assets: detection.assets,
		problems: [...problems, ...detection.problems].slice(0, 100),
		files: read,
	};
}

/** The files the scan read, by path, with their text when it was read. */
function scannedFiles(
	files: readonly SourceFile[],
	texts: ReadonlyMap<string, string | null>,
): ScannedTreeFile[] {
	return files
		.filter((file) => repositoryPath.safeParse(file.path).success)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map(({ path, blob, size, symlink }) => {
			const content = symlink ? undefined : texts.get(blob);
			return { path, blob, size, symlink, ...(typeof content === "string" ? { content } : {}) };
		});
}

function setText(
	tree: Map<string, TreeFile>,
	path: string,
	file: SourceFile,
	texts: ReadonlyMap<string, string | null>,
) {
	const content = texts.get(file.blob);
	tree.set(path, {
		blob: file.blob,
		size: file.size,
		...(typeof content === "string" ? { content } : {}),
	});
}

/** Texts for these files: from the registry when it holds them, from the source otherwise. */
async function readTexts(
	db: Db,
	source: RepositorySource,
	files: readonly SourceFile[],
): Promise<Map<string, string | null>> {
	const texts = new Map<string, string | null>();
	const missing = new Set<string>();
	for (const file of files) {
		if (texts.has(file.blob) || missing.has(file.blob)) continue;
		// Larger files are not downloaded; an adapter that needs one reports it as unreadable.
		if (file.size > MAX_FILE_LENGTH) continue;
		const stored = file.symlink
			? undefined
			: db.select({ content: blobs.content }).from(blobs).where(eq(blobs.id, file.blob)).get();
		if (typeof stored?.content === "string") texts.set(file.blob, stored.content);
		else missing.add(file.blob);
	}
	if (missing.size > 0) {
		for (const [blob, text] of await source.texts([...missing])) texts.set(blob, text);
	}
	return texts;
}

/** The repository path a relative symlink at `from` points to, or null if it leaves the repository. */
export function resolveLink(from: string, target: string): string | null {
	if (target === "" || target.startsWith("/")) return null;
	const parts = from.split("/").slice(0, -1);
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(segment);
		}
	}
	return parts.length > 0 ? parts.join("/") : null;
}
