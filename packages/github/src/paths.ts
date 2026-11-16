// The paths a commit made through the API may name. A path from a model or a person is a key in
// GitHub's tree, never a path on a disk here, so this is not about traversal in this code. It is
// about the people who clone the repository afterwards: a name that a Git client refuses, or
// that Windows or macOS folds into `.git` or `.gitmodules`, must not get into a commit through
// an API that has no client to refuse it. Each refusal is in words.
import { encoder } from "./encoding";

/** Where GitHub reads workflows from. Writing under it needs the app's Workflows permission. */
export const WORKFLOWS_FOLDER = ".github/workflows/";

const MAX_PATH_BYTES = 4096;
const MAX_PART_BYTES = 255;

/** Characters HFS+ leaves out when it compares names, as Git's own check lists them. */
const IGNORED_BY_HFS = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** Names Windows keeps for devices, whatever follows the first dot. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The short names NTFS may give `.gitmodules`, as Git's own check lists them. */
const SHORT_GITMODULES = /^(gitmod~[1-4]|gi7eba~[0-9]+)$/;

function hasControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Why `path` cannot name a file in a repository, or null when it can. A path is relative and
 * its parts are divided by `/`. No part is empty, `.` or `..`; none is `.git` or `.gitmodules`,
 * or a name a file system reads as one of them; none is a name Windows cannot hold.
 */
export function repositoryPathProblem(path: string): string | null {
	if (path === "") return "is empty";
	if (path.includes("\\")) return "holds a backslash; a repository's paths use /";
	if (path.startsWith("/")) return "is not a path inside the repository";
	if (encoder.encode(path).length > MAX_PATH_BYTES) return "is longer than 4,096 bytes";
	for (const part of path.split("/")) {
		if (part === "") return "has an empty part";
		if (part === "." || part === "..") return `has the part ${part}`;
		if (hasControlCharacter(part)) return "holds a control character";
		// What the name is to a file system that ignores case, the characters HFS+ ignores, and
		// the dots and spaces Windows drops from a name's end.
		const folded = part
			.replace(IGNORED_BY_HFS, "")
			.toLowerCase()
			.replace(/[. ]+$/, "");
		if (folded === ".git" || folded === "git~1") {
			return "is inside .git, or a name that some file systems read as .git";
		}
		if (folded === ".gitmodules" || SHORT_GITMODULES.test(folded)) {
			return "is .gitmodules, or a name that some file systems read as it; submodules are not changed this way";
		}
		if (part.includes(":")) {
			return "holds a colon, which Windows reads as a stream of another file";
		}
		if (/[. ]$/.test(part)) return "has a part ending in a dot or a space, which Windows drops";
		if (WINDOWS_DEVICE.test(part.split(".")[0]?.trimEnd() ?? "")) {
			return `has the part ${part}, a name Windows keeps for a device`;
		}
		if (encoder.encode(part).length > MAX_PART_BYTES) return "has a part longer than 255 bytes";
	}
	return null;
}
