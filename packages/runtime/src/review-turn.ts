/**
 * What a review turn is given before its run begins: the pull request as GitHub has it now, and
 * the message made of its diff and its criteria (`reviewMessage`). Nothing of the builder's
 * conversation, of its review threads or of memory reaches it: the registry hands over a
 * repository, a pull request number and a head, and the rest is read from GitHub.
 *
 * A pull request that is closed, whose head is not the one reviewed, or whose diff is too large
 * is `skipped`, and no run begins for it.
 */
import {
	type GitHubApp,
	pullRequestDiff,
	pullRequest as readPullRequest,
} from "@gateweave/agents-github";
import {
	REVIEW_INSTRUCTIONS,
	REVIEW_LIMITS,
	REVIEW_MESSAGE_LIMIT,
	REVIEW_SKIPPED,
	type ReviewCounts,
	type ReviewOutcome,
	reviewMessage,
	SANDBOX_REPOSITORY_PATH,
	type SandboxRepository,
} from "@gateweave/agents-model";
import { withoutChecksSection, withoutDisclosure } from "./checks";

/** The pull request as a review reads it. */
export interface ReviewedPullRequest {
	state: "open" | "closed" | "merged";
	/** The commit its branch is at now. */
	head: string;
	/** The branch it is to be merged into, which is not always the repository's default one. */
	base: string;
	/** Whether GitHub says it is a draft. */
	draft: boolean;
	title: string;
	body: string;
}

/** Where a review reads the pull request from: GitHub, or a stand-in in a test. */
export interface ReviewSource {
	/** Null when there is no such pull request. */
	pullRequest(number: number): Promise<ReviewedPullRequest | null>;
	/** The diff, up to `limit` bytes; `tooLarge` when it is longer; null when there is no such pull request. */
	diff(number: number, limit: number): Promise<{ diff: string } | { tooLarge: true } | null>;
}

/** Pull requests read with the workspace's GitHub App, as the tools that open them are. */
export function gitHubReviewSource(app: GitHubApp, repository: SandboxRepository): ReviewSource {
	const name = { owner: repository.owner, name: repository.name };
	const token = () =>
		app.repositoryToken(repository.installationId, repository.externalId, {
			contents: "read",
			pull_requests: "read",
		});
	return {
		async pullRequest(number) {
			const found = await readPullRequest(await token(), name, number);
			return (
				found && {
					state: found.state,
					head: found.head,
					// An answer that does not name its base is read against the default branch.
					base: found.baseRef ?? repository.defaultBranch,
					draft: found.draft === true,
					title: found.title,
					body: found.body ?? "",
				}
			);
		},
		async diff(number, limit) {
			return pullRequestDiff(await token(), name, number, limit);
		},
	};
}

/**
 * What the pull request is meant to do: its title and its description without Gateweave's own
 * sections, which are not the author's claim: the checks section and the AI disclosure. Both are
 * kept whole: a requirement at the end of a long description is as much a criterion as the first.
 * The registry's limit on the review's message (`REVIEW_MESSAGE_LIMIT`) allows all that GitHub
 * lets a title and a description hold.
 */
export function reviewCriteria(title: string, body: string): string[] {
	const description = withoutChecksSection(withoutDisclosure(body)).trim();
	return [title.trim(), description].filter((criterion) => criterion !== "");
}

/**
 * A review's message, and what the turn needs to know of the pull request besides: the branch it
 * is based on, from which the findings are checked against the same diff the model reads, and
 * whether GitHub says it is a draft.
 */
export type PreparedReview =
	| { message: string; base: string; draft: boolean }
	| { skipped: string };

/**
 * The message a review's turn starts with, or why there is nothing to review. The head must still
 * be the pull request's: a review of a commit nobody can see on GitHub is no review.
 */
export async function prepareReview(
	source: ReviewSource,
	{ number, head }: { number: number; head: string },
): Promise<PreparedReview> {
	const pull = await source.pullRequest(number);
	if (!pull) return { skipped: "The pull request was not found on GitHub" };
	if (pull.state !== "open") return { skipped: REVIEW_SKIPPED.closed };
	if (pull.head !== head) return { skipped: REVIEW_SKIPPED.headGone };
	const read = await source.diff(number, REVIEW_LIMITS.diffBytes);
	if (!read) return { skipped: "The pull request was not found on GitHub" };
	if ("tooLarge" in read) return { skipped: REVIEW_SKIPPED.tooLarge };
	const message = reviewMessage(read.diff, reviewCriteria(pull.title, pull.body));
	// The limit holds all that a diff within `REVIEW_LIMITS.diffBytes` and a pull request's words
	// can make; one over it is a message the registry would refuse.
	if (message.length > REVIEW_MESSAGE_LIMIT) return { skipped: REVIEW_SKIPPED.tooLarge };
	return { message, base: pull.base, draft: pull.draft };
}

/** What a review found, as the registry keeps it: counts only. */
export function reviewCountsOf({ findings }: Pick<ReviewOutcome, "findings">): ReviewCounts {
	return {
		found: findings.length,
		// Those a comment can sit on: a finding outside the diff is kept and not shown inline.
		shown: findings.filter((finding) => !finding.offDiff).length,
		proven: findings.filter((finding) => finding.proof.proven).length,
	};
}

/** What the review's system prompt adds to the agent's own instructions. */
export function reviewNote(
	repository: SandboxRepository,
	{ number, head }: { number: number; head: string },
): string {
	return [
		`Your sandbox has the repository ${repository.owner}/${repository.name} at ${SANDBOX_REPOSITORY_PATH}, at the head ${head} of pull request #${number}, detached.`,
		REVIEW_INSTRUCTIONS,
	].join("\n\n");
}
