// The paths a commit made through the API may name. A path from a model or a person is a key in
// GitHub's tree, never a path on a disk here, so this is not about traversal in this code. It is
// about the people who clone the repository afterwards: a name that a Git client refuses, or
// that Windows or macOS folds into `.git` or `.gitmodules`, must not get into a commit through
// an API that has no client to refuse it. Each refusal is in words.
//
// The text is someone else's, so nothing here runs a pattern that can repeat over it: lengths
// are checked first, and what is trimmed or left out is done a character at a time.
import { encoder } from "./encoding";

/** Where GitHub reads workflows from. Writing under it needs the app's Workflows permission. */
export const WORKFLOWS_FOLDER = ".github/workflows/";

const MAX_PATH_BYTES = 4096;
const MAX_PART_BYTES = 255;

/** Names Windows keeps for devices, whatever follows the first dot. */
const WINDOWS_DEVICES = new Set(["con", "prn", "aux", "nul"]);

/** Characters Windows allows in no name, besides the colon and the control characters. */
const WINDOWS_FORBIDDEN = '<>"|?*';

const DOT = 0x2e;
const SPACE = 0x20;

/** Whether HFS+ leaves the character out when it compares names, as Git's own check lists them. */
function ignoredByHfs(code: number): boolean {
	return (
		(code >= 0x200c && code <= 0x200f) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x206a && code <= 0x206f) ||
		code === 0xfeff
	);
}

/**
 * What a name is to a file system that ignores case, the characters HFS+ ignores, and the dots
 * and spaces Windows drops from a name's end.
 */
function folded(part: string): string {
	let kept = "";
	for (let index = 0; index < part.length; index++) {
		if (!ignoredByHfs(part.charCodeAt(index))) kept += part.charAt(index);
	}
	let end = kept.length;
	while (end > 0 && (kept.charCodeAt(end - 1) === DOT || kept.charCodeAt(end - 1) === SPACE)) {
		end--;
	}
	return kept.slice(0, end).toLowerCase();
}

function isDigits(text: string): boolean {
	if (text === "") return false;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x30 || code > 0x39) return false;
	}
	return true;
}

/**
 * The short names NTFS may give `.gitmodules`, as Git's own check has them: `gitmod~1` to
 * `gitmod~4`, and the fallback NTFS makes from a hash of the name, eight characters that begin
 * with some of `gi7eba`, then `~`, then a number that does not start with 0.
 */
function shortGitmodules(name: string): boolean {
	if (name.length !== 8) return false;
	if (name.startsWith("gitmod~")) return "1234".includes(name.charAt(7));
	const tilde = name.indexOf("~");
	if (tilde === -1 || tilde > 6 || name.slice(0, tilde) !== "gi7eba".slice(0, tilde)) return false;
	return name.charAt(tilde + 1) !== "0" && isDigits(name.slice(tilde + 1));
}

/**
 * `con`, `prn`, `aux`, `nul`, and `com` or `lpt` with a digit from 1 to 9 or one of the
 * superscripts ¹ ² ³, which Windows reserves as well; in any case.
 */
function windowsDevice(name: string): boolean {
	const lower = name.toLowerCase();
	if (WINDOWS_DEVICES.has(lower)) return true;
	return (
		lower.length === 4 &&
		(lower.startsWith("com") || lower.startsWith("lpt")) &&
		"123456789¹²³".includes(lower.charAt(3))
	);
}

/**
 * Why `path` cannot name a file in a repository, or null when it can. A path is relative and
 * its parts are divided by `/`. No part is empty, `.` or `..`; none is `.git` or `.gitmodules`,
 * or a name a file system reads as one of them; none is a name Windows cannot hold.
 */
export function repositoryPathProblem(path: string): string | null {
	if (path === "") return "is empty";
	// A string is never more bytes than three for each of its units, and never fewer than one,
	// so the count of units settles the long ones before anything reads them.
	if (path.length > MAX_PATH_BYTES || encoder.encode(path).length > MAX_PATH_BYTES) {
		return "is longer than 4,096 bytes";
	}
	if (path.includes("\\")) return "holds a backslash; a repository's paths use /";
	if (path.startsWith("/")) return "is not a path inside the repository";
	for (const part of path.split("/")) {
		if (part === "") return "has an empty part";
		if (encoder.encode(part).length > MAX_PART_BYTES) return "has a part longer than 255 bytes";
		if (part === "." || part === "..") return `has the part ${part}`;
		for (let index = 0; index < part.length; index++) {
			const code = part.charCodeAt(index);
			if (code < 0x20 || code === 0x7f) return "holds a control character";
		}
		const name = folded(part);
		if (name === ".git" || name === "git~1") {
			return "is inside .git, or a name that some file systems read as .git";
		}
		if (name === ".gitmodules" || shortGitmodules(name)) {
			return "is .gitmodules, or a name that some file systems read as it; submodules are not changed this way";
		}
		if (part.includes(":")) {
			return "holds a colon, which Windows reads as a stream of another file";
		}
		for (const forbidden of WINDOWS_FORBIDDEN) {
			if (part.includes(forbidden)) return `holds ${forbidden}, which Windows allows in no name`;
		}
		const last = part.charCodeAt(part.length - 1);
		if (last === DOT || last === SPACE) {
			return "has a part ending in a dot or a space, which Windows drops";
		}
		const dot = part.indexOf(".");
		if (windowsDevice((dot === -1 ? part : part.slice(0, dot)).trimEnd())) {
			return `has the part ${part}, a name Windows keeps for a device`;
		}
	}
	return null;
}
