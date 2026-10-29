import {
	branchCommit,
	branchHead,
	createBranch,
	createCommit,
	moveBranch,
	openPullRequest,
	pullRequest,
	readTexts,
	readTree,
	sharedApp,
	updatePullRequest,
} from "@gateweave/agents-github";
import type { RepositoryWriter } from "./apply";
import type { RepositoryRow } from "./db/schema";
import type { RepositorySource } from "./scanner";

/** The GitHub App settings a scan needs; the rest belong to the connect flow in the app. */
export interface SourceEnv {
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
}

export const GITHUB_NOT_SET_UP = "GitHub is not set up on this server";

/** Whether the server can act as its GitHub App: read, write and mint tokens for sandboxes. */
export function githubSetUp(env: SourceEnv): boolean {
	return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
}

/** Where to read the repository from, or why it cannot be read on this server. */
export function sourceFor(
	env: SourceEnv,
	repository: RepositoryRow,
): RepositorySource | { unavailable: string } {
	const writer = writerFor(env, repository);
	if ("unavailable" in writer) return writer;
	const { head, files, texts } = writer;
	return { head, files, texts };
}

/** Where to write a setup into the repository, or why it cannot be written on this server. */
export function writerFor(
	env: SourceEnv,
	repository: RepositoryRow,
): RepositoryWriter | { unavailable: string } {
	const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;
	const { installationId, defaultBranch } = repository;
	if (repository.provider !== "github" || installationId === null) {
		return { unavailable: "No GitHub App installation reaches this repository" };
	}
	if (!appId || !privateKey) return { unavailable: GITHUB_NOT_SET_UP };
	// One client per isolate, so installation tokens are reused across scans and workspaces.
	const app = sharedApp({ appId, privateKey });
	const name = { owner: repository.owner, name: repository.name };
	const token = () => app.installationToken(installationId);
	return {
		head: async () => branchHead(await token(), name, defaultBranch),
		files: async (tree) => readTree(await token(), name, tree),
		texts: async (blobIds) => readTexts(await token(), name, blobIds),
		commit: async (input) => createCommit(await token(), name, input),
		branchCommit: async (branch) => branchCommit(await token(), name, branch),
		createBranch: async (branch, commit) => createBranch(await token(), name, branch, commit),
		moveBranch: async (branch, commit) => moveBranch(await token(), name, branch, commit, true),
		openPullRequest: async (input) =>
			openPullRequest(await token(), name, { ...input, base: defaultBranch }),
		pullRequest: async (number) => pullRequest(await token(), name, number),
		updatePullRequest: async (number, input) =>
			updatePullRequest(await token(), name, number, input),
	};
}
