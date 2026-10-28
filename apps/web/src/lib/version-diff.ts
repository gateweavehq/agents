import type { AssetFile } from "@gateweave/agents-model";
import { diffLines } from "diff";

export interface DiffLine {
	/** `+` added, `-` removed, a space unchanged. */
	kind: "+" | "-" | " ";
	text: string;
}

export interface FileDiff {
	path: string;
	status: "added" | "removed" | "changed";
	/** Null when the text of either side is not kept, so only the fact that it changed is known. */
	lines: DiffLine[] | null;
}

function linesOf(text: string, kind: DiffLine["kind"]): DiffLine[] {
	// A chunk ends with the newline of its last line, which is not another, empty line.
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n").map((line) => ({ kind, text: line }));
}

/**
 * The files that differ between two versions of an asset, in path order, each with a line diff.
 * Files with the same Git blob id are left out: the id is a hash of the content, so the text need
 * not be compared.
 */
export function diffFiles(from: readonly AssetFile[], to: readonly AssetFile[]): FileDiff[] {
	const before = new Map(from.map((file) => [file.path, file]));
	const after = new Map(to.map((file) => [file.path, file]));
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	const diffs: FileDiff[] = [];
	for (const path of paths) {
		const old = before.get(path);
		const next = after.get(path);
		if (old && next && old.blob === next.blob) continue;
		const status = !old ? "added" : !next ? "removed" : "changed";
		if ((old && old.content === null) || (next && next.content === null)) {
			diffs.push({ path, status, lines: null });
			continue;
		}
		const lines = diffLines(old?.content ?? "", next?.content ?? "").flatMap((part) =>
			// An empty side (an added or removed file) contributes no chunk at all.
			part.value === "" ? [] : linesOf(part.value, part.added ? "+" : part.removed ? "-" : " "),
		);
		diffs.push({ path, status, lines });
	}
	return diffs;
}
