/** What the writers collect: files by path, and the problems that kept an asset out. */
import { repositoryPath } from "@gateweave/agents-model";
import { compare } from "./util";
import type { AssetToWrite, WriteProblem, WriteResult } from "./write";

/**
 * Text as every file is written: `\n` newlines and one trailing newline, so the bytes do not
 * depend on the machine that produced them.
 */
export function normalizeText(text: string): string {
	const unix = text.replace(/\r\n?/g, "\n");
	return unix === "" || unix.endsWith("\n") ? unix : `${unix}\n`;
}

/** True for a path the registry could store, which is also one that stays inside the repository. */
export function isSafePath(path: string): boolean {
	return repositoryPath.safeParse(path).success;
}

export class Output {
	readonly #files = new Map<string, string>();
	readonly #problems = new Map<string, WriteProblem>();

	problem(asset: string, message: string): void {
		this.#problems.set(`${asset}\0${message}`, { asset, message });
	}

	/** Writes a file. Two assets that want one path with different text are a conflict. */
	add(path: string, content: string, asset: string): void {
		const text = normalizeText(content);
		const known = this.#files.get(path);
		if (known === undefined) this.#files.set(path, text);
		else if (known !== text) this.problem(asset, `${path} is also written by another asset`);
	}

	result(): WriteResult {
		return {
			files: [...this.#files]
				.sort(([a], [b]) => compare(a, b))
				.map(([path, content]) => ({ path, content })),
			problems: [...this.#problems.values()].sort(
				(a, b) => compare(a.asset, b.asset) || compare(a.message, b.message),
			),
		};
	}
}

/**
 * The text of an asset that is one file, or null with a problem. An asset whose text the
 * registry did not keep cannot be written, and part of one is worse than none.
 */
export function singleText(asset: AssetToWrite, output: Output): string | null {
	const [file, ...rest] = asset.files;
	if (!file || rest.length > 0) {
		output.problem(asset.name, "Expected exactly one file");
		return null;
	}
	if (file.content === null) {
		output.problem(asset.name, "The registry did not keep this asset's text");
		return null;
	}
	return file.content;
}
