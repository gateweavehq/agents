// Builds the clean history the reviewer works in: two commits, the pull request's merge base and
// its `pre_fix` head. Nothing after `pre_fix` is ever fetched into it, so the fix cannot be read.
import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "replay",
	GIT_AUTHOR_EMAIL: "replay@example.invalid",
	GIT_COMMITTER_NAME: "replay",
	GIT_COMMITTER_EMAIL: "replay@example.invalid",
	GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export async function git(cwd, args) {
	const { stdout } = await run("git", args, {
		cwd,
		env: GIT_ENV,
		maxBuffer: 256 * 1024 * 1024,
	});
	return stdout;
}

const exists = (path) =>
	access(path).then(
		() => true,
		() => false,
	);

/** `agents` is `<org>/agents`; a full `owner/name` is left as it is. */
export function repoName(repo, org) {
	return repo.includes("/") ? repo : `${org}/${repo}`;
}

/** Where the real run gets its repositories and each pull request's merge base: GitHub. */
export function githubSource(org) {
	return {
		cloneUrl: (repo) => `https://github.com/${repoName(repo, org)}.git`,
		async baseOf(repo, pr) {
			// The first commit of the pull request's own list, then its parent: the merge base the
			// pull request was opened from. Asking git alone cannot tell it after a rebase merge.
			const { stdout } = await run(
				"gh",
				[
					"api",
					`repos/${repoName(repo, org)}/pulls/${pr}/commits`,
					"--paginate",
					"--jq",
					".[0].parents[0].sha",
				],
				{ maxBuffer: 16 * 1024 * 1024, shell: process.platform === "win32" },
			);
			const sha = stdout.split(/\r?\n/).find((line) => /^[0-9a-f]{40}$/.test(line));
			if (!sha) throw new Error(`No merge base found for ${repo}#${pr}`);
			return sha;
		},
	};
}

/** A bare copy of the repository, kept between rows, with the pull request's own commits in it. */
export async function mirrorOf(source, cacheDir, repo, pr, shas) {
	const mirror = join(cacheDir, `${repo.replace(/[^\w.-]/g, "__")}.git`);
	if (!(await exists(mirror))) {
		await mkdir(cacheDir, { recursive: true });
		await git(cacheDir, ["clone", "--bare", "--quiet", source.cloneUrl(repo), mirror]);
		await git(mirror, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
	}
	const missing = async () => {
		for (const sha of shas) {
			if (
				!(await git(mirror, ["cat-file", "-t", `${sha}^{commit}`]).then(
					() => true,
					() => false,
				))
			)
				return true;
		}
		return false;
	};
	if (await missing()) {
		// A pull request merged by squash leaves its commits on no branch, only here.
		await git(mirror, ["fetch", "--quiet", "origin", `+refs/pull/${pr}/head:refs/replay/pr-${pr}`]);
	}
	return mirror;
}

const full = async (mirror, sha) =>
	(await git(mirror, ["rev-parse", "--verify", `${sha}^{commit}`])).trim();

/**
 * Makes `<dir>` a repository of two commits and returns the diff between them. Only the two trees
 * are fetched, with the history behind them, and that history is then pruned away.
 */
export async function cleanHistory({ source, cacheDir, dir, row }) {
	const base = await source.baseOf(row.repo, row.pr);
	const mirror = await mirrorOf(source, cacheDir, row.repo, row.pr, [base, row.pre_fix]);
	const baseSha = await full(mirror, base);
	const preFix = await full(mirror, row.pre_fix);

	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	await git(dir, ["init", "--quiet", "--initial-branch=main"]);
	await git(dir, ["fetch", "--quiet", "--no-tags", mirror, baseSha, preFix]);
	const baseCommit = (
		await git(dir, ["commit-tree", `${baseSha}^{tree}`, "-m", "merge base"])
	).trim();
	const head = (
		await git(dir, ["commit-tree", `${preFix}^{tree}`, "-p", baseCommit, "-m", "head"])
	).trim();
	await git(dir, ["update-ref", "refs/heads/main", head]);
	await git(dir, ["reset", "--hard", "--quiet"]);
	await rm(join(dir, ".git", "FETCH_HEAD"), { force: true });
	await git(dir, ["reflog", "expire", "--expire=now", "--all"]);
	await git(dir, ["gc", "--prune=now", "--quiet"]);

	const diff = await git(dir, ["diff", "--no-color", "--no-ext-diff", "HEAD~1", "HEAD"]);
	return { diff, mirror, preFix };
}

/** What the fix commit or commits changed, for the judge only. */
export async function fixDiff(mirror, preFix, fix, alsoFix) {
	const steps = [[preFix, fix]];
	if (alsoFix) steps.push([fix, alsoFix]);
	const parts = [];
	for (const [from, to] of steps) {
		parts.push(
			await git(mirror, [
				"diff",
				"--no-color",
				"--no-ext-diff",
				await full(mirror, from),
				await full(mirror, to),
			]),
		);
	}
	return parts.join("\n");
}
