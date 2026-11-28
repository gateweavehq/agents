import { createReview, type GitHubApp, GitHubError } from "@gateweave/agents-github";
import type { SandboxRepository } from "@gateweave/agents-model";

export interface ReviewPostComment {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	body: string;
}

export interface ReviewPostMemory {
	recall(key: string): Promise<boolean>;
	remember(key: string): Promise<void>;
}

export interface ReviewPostInput {
	key: string;
	number: number;
	commitId: string;
	summary: string;
	comments: readonly ReviewPostComment[];
}

export type ReviewPost = (input: Omit<ReviewPostInput, "key">) => Promise<void>;

/**
 * Posts a review once for the key the conversation keeps. GitHub can refuse line comments with a
 * 422 when a line no longer matches the diff; that one refusal is retried with every finding in
 * the summary and no line comments. A retry after the post was recorded sends nothing again.
 */
export async function postReviewOnce(
	post: ReviewPost,
	input: ReviewPostInput,
	memory: ReviewPostMemory,
): Promise<{ posted: boolean; alreadyPosted: boolean; summaryOnly: boolean }> {
	if (await memory.recall(input.key))
		return { posted: false, alreadyPosted: true, summaryOnly: false };
	const withoutKey = {
		number: input.number,
		commitId: input.commitId,
		summary: input.summary,
	};
	try {
		await post({ ...withoutKey, comments: input.comments });
		await memory.remember(input.key);
		return { posted: true, alreadyPosted: false, summaryOnly: false };
	} catch (error) {
		if (!(error instanceof GitHubError) || error.status !== 422) throw error;
	}
	await post({ ...withoutKey, comments: [] });
	await memory.remember(input.key);
	return { posted: true, alreadyPosted: false, summaryOnly: true };
}

/** Posts pull request reviews on GitHub with the workspace's app. The sandbox never sees the token. */
export function gitHubReviewPost(app: GitHubApp, repository: SandboxRepository): ReviewPost {
	return async ({ number, commitId, summary, comments }) => {
		const token = await app.repositoryToken(repository.installationId, repository.externalId, {
			contents: "read",
			pull_requests: "write",
		});
		await createReview(token, { owner: repository.owner, name: repository.name }, number, {
			commitId,
			body: summary,
			event: "COMMENT",
			comments,
		});
	};
}
