import { scanResult } from "@gateweave/agents-model";
import { expect } from "vitest";
import type { Detection, RepositoryTree } from "../src";

/**
 * A repository from path to text. `null` is a file the scanner did not download, such as a
 * binary: it has a blob id and a size but no content.
 */
export function repo(files: Record<string, string | null>): RepositoryTree {
	return new Map(
		Object.entries(files).map(([path, text]) => {
			const size = (text ?? `binary ${path}`).length;
			const blob = fakeBlob(path);
			return [path, text === null ? { blob, size } : { blob, size, content: text }];
		}),
	);
}

/** A stable 40-digit hex id per path. The adapters only pass blob ids along, never compute them. */
function fakeBlob(path: string): string {
	let hash = 0;
	for (const char of path) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
	return hash.toString(16).padStart(8, "0").repeat(5);
}

/** The scan the registry would receive from this detection must be accepted as it is. */
export function expectValid(detection: Detection): void {
	const result = scanResult.safeParse({
		commit: "a".repeat(40),
		scannedAt: 1,
		...detection,
		files: [],
	});
	expect(result.success, result.success ? "" : JSON.stringify(result.error.issues)).toBe(true);
}

export function assetOf(detection: Detection, key: string) {
	const asset = detection.assets.find((candidate) => candidate.key === key);
	if (!asset)
		throw new Error(`No asset ${key} in ${detection.assets.map((a) => a.key).join(", ")}`);
	return asset;
}

export function agentOf(detection: Detection, key = "main") {
	const agent = detection.agents.find((candidate) => candidate.key === key);
	if (!agent) throw new Error(`No agent ${key}`);
	return agent;
}

/** The text of an asset's single file. */
export function textOf(detection: Detection, key: string): string {
	const files = assetOf(detection, key).files;
	const content = files[0]?.content;
	if (files.length !== 1 || content === undefined) throw new Error(`${key} is not one text file`);
	return content;
}
