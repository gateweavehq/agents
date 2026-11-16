// The paths a commit made through the API may name. A path from a model or a person is a key in
// GitHub's tree, never a path on a disk, so this is not about traversal: it is about asking
// GitHub only for what Git itself would take, and saying why not in words.

/** Where GitHub reads workflows from. Writing under it needs the app's Workflows permission. */
export const WORKFLOWS_FOLDER = ".github/workflows/";

/**
 * Why `path` cannot name a file in a repository, or null when it can. A path is relative, its
 * parts are divided by `/`, and none of them is empty, `.`, `..` or `.git`.
 */
export function repositoryPathProblem(path: string): string | null {
	if (path === "") return "is empty";
	if (path.includes("\\")) return "holds a backslash; a repository's paths use /";
	if (path.includes("\0")) return "holds a character a path cannot";
	if (path.startsWith("/")) return "is not a path inside the repository";
	for (const part of path.split("/")) {
		if (part === "") return "has an empty part";
		if (part === "." || part === "..") return `has the part ${part}`;
		// Git refuses the name at any depth and in any case, since some file systems fold it.
		if (part.toLowerCase() === ".git") return "is inside .git";
	}
	return null;
}
