// Builds the clean history the reviewer works in: two commits, the pull request's merge base and
// its `pre_fix` head. Nothing after `pre_fix` is ever fetched into it, so the fix cannot be read.
import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runCommand } from "./launcher.mjs";

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

/** The same as `git`, but the bytes as git wrote them. */
async function gitBytes(cwd, args) {
	const { stdout } = await run("git", args, {
		cwd,
		env: GIT_ENV,
		maxBuffer: 256 * 1024 * 1024,
		encoding: "buffer",
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

const gh = (args) => runCommand("gh", args, {});

/** Where the real run gets its repositories and each pull request's base: GitHub. */
export function githubSource(org) {
	return {
		cloneUrl: (repo) => `https://github.com/${repoName(repo, org)}.git`,
		/** The base revision GitHub recorded for the pull request. */
		async baseOf(repo, pr) {
			const out = await gh([
				"api",
				`repos/${repoName(repo, org)}/pulls/${pr}`,
				"--jq",
				".base.sha",
			]);
			const sha = out.split(/\r?\n/).find((line) => /^[0-9a-f]{40}$/.test(line));
			if (!sha) throw new Error(`No base revision found for ${repo}#${pr}`);
			return sha;
		},
		/** The refs of the pull requests that hold a commit: a squash-merged one is only on those. */
		async refsFor(repo, sha) {
			const out = await gh([
				"api",
				`repos/${repoName(repo, org)}/commits/${sha}/pulls`,
				"--jq",
				".[].number",
			]);
			return out
				.split(/\r?\n/)
				.filter((line) => /^\d+$/.test(line))
				.map((number) => `refs/pull/${number}/head`);
		},
	};
}

const hasCommit = (mirror, sha) =>
	git(mirror, ["cat-file", "-t", `${sha}^{commit}`]).then(
		() => true,
		() => false,
	);

const absent = async (mirror, shas) => {
	const missing = [];
	for (const sha of shas) if (!(await hasCommit(mirror, sha))) missing.push(sha);
	return missing;
};

/**
 * Makes sure every revision in `shas` is in the mirror and returns those that could not be had.
 * A commit of a pull request merged by squash is on no branch, so it is fetched by its revision,
 * then from the reviewed pull request's head, then from the head of each pull request that holds it.
 */
export async function fetchMissing({ source, mirror, repo, pr, shas }) {
	let missing = await absent(mirror, shas);
	for (const sha of missing) {
		await git(mirror, ["fetch", "--quiet", "--no-tags", "origin", sha]).catch(() => {});
	}
	missing = await absent(mirror, missing);
	if (missing.length === 0) return [];

	const refs = new Set([`refs/pull/${pr}/head`]);
	for (const sha of missing) {
		try {
			for (const ref of (await source.refsFor?.(repo, sha)) ?? []) {
				if (/^refs\/pull\/\d+\/head$/.test(ref)) refs.add(ref);
			}
		} catch {
			// No answer from the host: the refs already named are all there is to try.
		}
	}
	for (const ref of refs) {
		await git(mirror, [
			"fetch",
			"--quiet",
			"--no-tags",
			"origin",
			`+${ref}:refs/replay/${ref.replaceAll("/", "-")}`,
		]).catch(() => {});
		missing = await absent(mirror, missing);
		if (missing.length === 0) return [];
	}
	return missing;
}

/** A bare copy of the repository, kept between rows. Its path is absolute, whatever `cacheDir` is. */
export async function mirrorOf(source, cacheDir, repo) {
	const mirror = resolve(cacheDir, `${repo.replace(/[^\w.-]/g, "__")}.git`);
	if (!(await exists(mirror))) {
		await mkdir(resolve(cacheDir), { recursive: true });
		await git(resolve(cacheDir), ["clone", "--bare", "--quiet", source.cloneUrl(repo), mirror]);
		await git(mirror, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
	}
	return mirror;
}

const full = async (mirror, sha) =>
	(await git(mirror, ["rev-parse", "--verify", `${sha}^{commit}`])).trim();

// The product reads its diff with these options, and `lineOnDiff` expects what they make.
const DIFF = [
	"-c",
	"core.quotePath=false",
	"diff",
	"--no-color",
	"--no-ext-diff",
	"--find-renames",
	"--src-prefix=a/",
	"--dst-prefix=b/",
	"--unified=3",
];

/**
 * Makes `<dir>` a repository of two commits and returns the diff between them. The two commits
 * are the merge base of the pull request's recorded base and `pre_fix`, and `pre_fix`. Only the two
 * trees are fetched, with the history behind them, and that history is then pruned away.
 * Returns the diff as text and `diffBytes`, the size of the bytes git wrote for it.
 */
export async function cleanHistory({ source, cacheDir, dir, row }) {
	const recorded = await source.baseOf(row.repo, row.pr);
	const mirror = await mirrorOf(source, cacheDir, row.repo);
	const missing = await fetchMissing({
		source,
		mirror,
		repo: row.repo,
		pr: row.pr,
		shas: [recorded, row.pre_fix],
	});
	if (missing.length > 0) {
		throw new Error(`${missing.join(", ")} is not in ${row.repo}, not even on a pull request ref`);
	}
	const preFix = await full(mirror, row.pre_fix);
	// The recorded base may be the base branch's tip, ahead of or behind what the branch merged
	// from it: the pull request's own changes start at the commit they have in common.
	const baseSha = (await git(mirror, ["merge-base", await full(mirror, recorded), preFix])).trim();

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

	// The product limits the bytes the host sends and then the length of the decoded text, so both
	// are kept: `diffBytes` is what git wrote, and `diff` is what a reader of it makes of them.
	const raw = await gitBytes(dir, [...DIFF, "HEAD~1", "HEAD", "--"]);
	return { diff: raw.toString("utf8"), diffBytes: raw.length, mirror, preFix };
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

/**
 * The fix for the judge, or why there is none: a fix on a pull request ref that cannot be fetched
 * does not cost the row its findings, the judge then reads the reviewed tree and the defect alone.
 */
export async function fixPatch({ source, mirror, repo, pr, preFix, fix, alsoFix }) {
	if (!fix) return { diff: null, reason: "The row names no fix" };
	const wanted = [fix, alsoFix].filter(Boolean);
	const missing = await fetchMissing({ source, mirror, repo, pr, shas: wanted });
	if (missing.length > 0) {
		return { diff: null, reason: `The fix revision ${missing.join(", ")} could not be fetched` };
	}
	try {
		return { diff: await fixDiff(mirror, preFix, fix, alsoFix), reason: null };
	} catch {
		return { diff: null, reason: "The fix patch could not be computed" };
	}
}
