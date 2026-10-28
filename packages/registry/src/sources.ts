import { branchHead, GitHubApp, readTexts, readTree } from "@gateweave/agents-github";
import type { RepositoryRow } from "./db/schema";
import type { RepositorySource } from "./scanner";

/** The GitHub App settings a scan needs; the rest belong to the connect flow in the app. */
export interface SourceEnv {
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
}

// One client per isolate, so installation tokens are reused across scans and workspaces.
let client: { appId: string; privateKey: string; app: GitHubApp } | undefined;

function githubApp(appId: string, privateKey: string): GitHubApp {
	if (client?.appId !== appId || client.privateKey !== privateKey) {
		client = { appId, privateKey, app: new GitHubApp({ appId, privateKey }) };
	}
	return client.app;
}

/** Where to read the repository from, or why it cannot be read on this server. */
export function sourceFor(
	env: SourceEnv,
	repository: RepositoryRow,
): RepositorySource | { unavailable: string } {
	const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: privateKey } = env;
	const { installationId, defaultBranch } = repository;
	if (repository.provider !== "github" || installationId === null) {
		return { unavailable: "No GitHub App installation reaches this repository" };
	}
	if (!appId || !privateKey) return { unavailable: "GitHub is not set up on this server" };
	const app = githubApp(appId, privateKey);
	const name = { owner: repository.owner, name: repository.name };
	const token = () => app.installationToken(installationId);
	return {
		head: async () => branchHead(await token(), name, defaultBranch),
		files: async (tree) => readTree(await token(), name, tree),
		texts: async (blobIds) => readTexts(await token(), name, blobIds),
	};
}
