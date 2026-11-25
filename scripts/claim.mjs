// Claims for `together` issues, run by .github/workflows/claim.yml and claim-sweep.yml.
//
// A contributor writes `/claim` on an issue to take it before opening a pull request, and
// `/release` to give it back. One open claim per account, or three after its first merged pull
// request. A claim lapses after seven days without a pull request that mentions the issue. A
// maintainer can claim for someone (`/claim @name`, which skips the limits and replaces the
// holder) and release anyone's claim. A maintainer's own plain `/claim` is held to the limits like
// anyone's. A claim has one holder; the sweep checks every assignee anyway. A pull request nobody claimed gets a comment and a label, and is never closed.
//
// No dependencies, GITHUB_TOKEN only, and it never reads pull request code: it runs from the
// default branch and takes everything from the event's data and the API.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const TOGETHER = "together";
export const CLAIMED = "claimed";
export const UNCLAIMED = "unclaimed";
export const LAPSE_DAYS = 7;
export const BASE_LIMIT = 1;
export const TRUSTED_LIMIT = 3;
export const UNCLAIMED_MARKER = "<!-- unclaimed-pull-request -->";

const DAY = 24 * 60 * 60 * 1000;

/** `/claim`, `/release`, or `/claim @name`: only the first line of a comment counts. */
export function parseCommand(body) {
	const first = String(body ?? "")
		.split(/\r?\n/)
		.find((line) => line.trim() !== "");
	const match = /^\/(claim|release)(?:\s+@([A-Za-z0-9][A-Za-z0-9-]{0,38}))?$/.exec(
		first?.trim() ?? "",
	);
	if (!match) return null;
	return { command: match[1], target: match[2] ?? null };
}

/** One open claim, or three once the account has a merged pull request here. */
export function claimLimit(mergedPullRequests) {
	return mergedPullRequests >= 1 ? TRUSTED_LIMIT : BASE_LIMIT;
}

const names = (list) => (list ?? []).map((item) => (typeof item === "string" ? item : item.name));
const logins = (list) => (list ?? []).map((user) => user.login);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether `actor` may claim `issue` for `target` (the actor unless a maintainer names someone).
 * `openClaims` and `mergedPullRequests` are the target's counts, not counting this issue.
 */
export function decideClaim({
	actor,
	target,
	isMaintainer,
	issue,
	openClaims,
	mergedPullRequests,
}) {
	const who = target ?? actor;
	if (target && !same(target, actor) && !isMaintainer) {
		return { ok: false, message: "Only a maintainer can claim an issue for someone else." };
	}
	if (issue.pull_request) {
		return { ok: false, message: "Claims are for issues. A pull request needs no claim." };
	}
	if (issue.state !== "open") {
		return { ok: false, message: "This issue is closed, so there is nothing to claim." };
	}
	if (!names(issue.labels).includes(TOGETHER)) {
		return { ok: false, message: `Only issues labelled \`${TOGETHER}\` can be claimed.` };
	}
	const holders = logins(issue.assignees);
	if (holders.some((login) => same(login, who))) {
		return { ok: false, message: `@${who} already holds this issue.` };
	}
	const overriding = isMaintainer && Boolean(target);
	if (holders.length > 0 && !overriding) {
		return {
			ok: false,
			message: `@${holders[0]} already holds this issue. Their claim lapses after ${LAPSE_DAYS} days without a pull request, or they can \`/release\` it.`,
		};
	}
	if (!overriding) {
		const limit = claimLimit(mergedPullRequests);
		if (openClaims >= limit) {
			const next =
				limit === BASE_LIMIT
					? ` After your first merged pull request the limit is ${TRUSTED_LIMIT}.`
					: "";
			return {
				ok: false,
				message: `@${who} already holds ${openClaims} open ${openClaims === 1 ? "claim" : "claims"}, which is the limit.${next} Open a pull request for one, or \`/release\` one first.`,
			};
		}
	}
	return {
		ok: true,
		who,
		replaces: holders,
		message: `@${who} holds this issue. Open a pull request that mentions it within ${LAPSE_DAYS} days, or the claim lapses. \`/release\` gives it back.`,
	};
}

/** Whether `actor` may release `issue`: its holder, or a maintainer. */
export function decideRelease({ actor, isMaintainer, issue }) {
	if (issue.pull_request) {
		return { ok: false, message: "Claims are for issues. A pull request needs no claim." };
	}
	const claimed = names(issue.labels).includes(CLAIMED);
	const holders = logins(issue.assignees);
	if (!claimed || holders.length === 0) {
		return { ok: false, message: "Nobody holds this issue, so there is nothing to release." };
	}
	if (!isMaintainer && !holders.some((login) => same(login, actor))) {
		return {
			ok: false,
			message: `Only @${holders[0]} or a maintainer can release this claim.`,
		};
	}
	return {
		ok: true,
		holders,
		message: `Released. The claim of @${holders.join(", @")} is gone, and anyone can \`/claim\` this issue.`,
	};
}

/** A claim lapses seven days after it was made unless a pull request by its holder mentions it. */
export function isLapsed({ claimedAt, hasPullRequest, now }) {
	if (hasPullRequest || !claimedAt) return false;
	return now - new Date(claimedAt).getTime() >= LAPSE_DAYS * DAY;
}

/** The issue numbers a pull request's title or description mentions, not its own. */
export function mentionedIssues(pull) {
	const text = `${pull.title ?? ""}\n${pull.body ?? ""}`;
	const found = new Set();
	for (const match of text.matchAll(/(?:^|[^\w/])#(\d+)\b/g)) {
		const number = Number(match[1]);
		if (number !== pull.number) found.add(number);
	}
	return [...found];
}

/** A pull request from outside the team is unclaimed when no issue it mentions is held by its author. */
export function isUnclaimed({ author, isMaintainer, isBot, mentioned }) {
	if (isMaintainer || isBot) return false;
	return !mentioned.some((issue) => logins(issue.assignees).some((login) => same(login, author)));
}

/**
 * From an issue's timeline: when the current claim was labelled, and whether a pull request by one
 * of the `holders` mentions the issue and is open or merged. The pull request's date does not
 * matter: opening it before the `/claim` (the path the unclaimed comment suggests) counts, and one
 * closed unmerged never does.
 */
export function readTimeline(timeline, holders) {
	const who = [holders].flat();
	let claimedAt = null;
	for (const event of timeline) {
		if (event.event === "labeled" && event.label?.name === CLAIMED) claimedAt = event.created_at;
		if (event.event === "unlabeled" && event.label?.name === CLAIMED) claimedAt = null;
	}
	const hasPullRequest = timeline.some((event) => {
		if (event.event !== "cross-referenced") return false;
		const source = event.source?.issue;
		if (!source?.pull_request || !source.user) return false;
		if (!who.some((login) => same(source.user.login, login))) return false;
		return source.state === "open" || Boolean(source.pull_request.merged_at);
	});
	return { claimedAt, hasPullRequest };
}

// ---- GitHub ----------------------------------------------------------------------------------

export function client({
	token,
	repo,
	api = "https://api.github.com",
	fetchImpl = globalThis.fetch,
}) {
	async function call(method, path, body) {
		const response = await fetchImpl(`${api}${path}`, {
			method,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
				"user-agent": "gateweave-claims",
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (response.status === 404 && method === "GET") return null;
		if (!response.ok) {
			throw new Error(`${method} ${path.split("?")[0]} answered ${response.status}`);
		}
		return response.status === 204 ? null : response.json();
	}
	async function pages(path) {
		const items = [];
		const join = path.includes("?") ? "&" : "?";
		for (let page = 1; page <= 20; page++) {
			const part = await call("GET", `${path}${join}per_page=100&page=${page}`);
			if (!part?.length) break;
			items.push(...part);
			if (part.length < 100) break;
		}
		return items;
	}
	const base = `/repos/${repo}`;
	return {
		issue: (number) => call("GET", `${base}/issues/${number}`),
		pull: (number) => call("GET", `${base}/pulls/${number}`),
		timeline: (number) => pages(`${base}/issues/${number}/timeline`),
		comments: (number) => pages(`${base}/issues/${number}/comments`),
		openIssues: (label) => pages(`${base}/issues?state=open&labels=${encodeURIComponent(label)}`),
		openPulls: () => pages(`${base}/pulls?state=open`),
		// The issues endpoint is read-after-write consistent, unlike the search index, so a claim made
		// a moment ago is counted. It lists pull requests too, which are no claims.
		async openClaims(login) {
			const path = `${base}/issues?state=open&labels=${CLAIMED}&assignee=${encodeURIComponent(login)}`;
			return (await pages(path)).filter((item) => !item.pull_request).length;
		},
		comment: (number, body) => call("POST", `${base}/issues/${number}/comments`, { body }),
		addLabel: (number, label) =>
			call("POST", `${base}/issues/${number}/labels`, { labels: [label] }),
		removeLabel: (number, label) =>
			call("DELETE", `${base}/issues/${number}/labels/${encodeURIComponent(label)}`).catch(
				() => null,
			),
		assign: (number, users) =>
			call("POST", `${base}/issues/${number}/assignees`, { assignees: users }),
		unassign: (number, users) =>
			call("DELETE", `${base}/issues/${number}/assignees`, { assignees: users }),
		async count(query) {
			const q = encodeURIComponent(`repo:${repo} ${query}`);
			const result = await call("GET", `/search/issues?per_page=1&q=${q}`);
			return result?.total_count ?? 0;
		},
		async isMaintainer(login) {
			const path = `${base}/collaborators/${encodeURIComponent(login)}/permission`;
			const result = await call("GET", path);
			return ["admin", "maintain", "write"].includes(result?.permission);
		},
	};
}

export async function handleComment(gh, event) {
	if (event.action !== "created" || event.comment.user.type === "Bot") return;
	const parsed = parseCommand(event.comment.body);
	if (!parsed) return;
	const number = event.issue.number;
	const actor = event.comment.user.login;
	const issue = await gh.issue(number);
	if (!issue) return;
	const isMaintainer = await gh.isMaintainer(actor);

	if (parsed.command === "release") {
		const verdict = decideRelease({ actor, isMaintainer, issue });
		if (verdict.ok) {
			await gh.unassign(number, verdict.holders);
			await gh.removeLabel(number, CLAIMED);
		}
		await gh.comment(number, verdict.message);
		return;
	}

	const who = parsed.target ?? actor;
	const [openClaims, mergedPullRequests] = await Promise.all([
		gh.openClaims(who),
		gh.count(`is:pr is:merged author:${who}`),
	]);
	const verdict = decideClaim({
		actor,
		target: parsed.target,
		isMaintainer,
		issue,
		openClaims,
		mergedPullRequests,
	});
	if (verdict.ok) {
		if (verdict.replaces.length) await gh.unassign(number, verdict.replaces);
		await gh.assign(number, [verdict.who]);
		// Adding a label the issue already has records no event, and the sweep dates a claim by its
		// latest `labeled` event: an override would inherit the old claim's days. Label it afresh.
		if (names(issue.labels).includes(CLAIMED)) await gh.removeLabel(number, CLAIMED);
		await gh.addLabel(number, CLAIMED);
	}
	await gh.comment(number, verdict.message);
}

export async function checkPull(gh, number) {
	const pull = await gh.pull(number);
	if (pull?.state !== "open") return;
	const author = pull.user.login;
	const mentioned = [];
	for (const issueNumber of mentionedIssues(pull)) {
		const found = await gh.issue(issueNumber);
		if (found && !found.pull_request) mentioned.push(found);
	}
	const unclaimed = isUnclaimed({
		author,
		isMaintainer: await gh.isMaintainer(author),
		isBot: pull.user.type === "Bot",
		mentioned,
	});
	const labelled = names(pull.labels).includes(UNCLAIMED);
	if (!unclaimed) {
		if (labelled) await gh.removeLabel(number, UNCLAIMED);
		return;
	}
	if (!labelled) await gh.addLabel(number, UNCLAIMED);
	const comments = await gh.comments(number);
	if (comments.some((comment) => comment.body?.includes(UNCLAIMED_MARKER))) return;
	await gh.comment(
		number,
		`${UNCLAIMED_MARKER}\nThanks for the pull request. It does not mention an issue that you hold, so it is labelled \`${UNCLAIMED}\`. It stays open. To claim the work, write \`/claim\` on its issue (issues labelled \`${TOGETHER}\` can be claimed) and mention the issue here. A maintainer will look at it either way.`,
	);
}

export async function sweep(gh, now = Date.now()) {
	const released = [];
	for (const issue of await gh.openIssues(CLAIMED)) {
		if (issue.pull_request) continue;
		const holders = logins(issue.assignees);
		const timeline = await gh.timeline(issue.number);
		const { claimedAt, hasPullRequest } = readTimeline(timeline, holders);
		if (!isLapsed({ claimedAt, hasPullRequest, now })) continue;
		if (holders.length) await gh.unassign(issue.number, holders);
		await gh.removeLabel(issue.number, CLAIMED);
		const who = holders.length ? ` of @${holders.join(", @")}` : "";
		await gh.comment(
			issue.number,
			`The claim${who} lapsed after ${LAPSE_DAYS} days without a pull request, and the issue is free again. Anyone can \`/claim\` it.`,
		);
		released.push(issue.number);
	}
	// A pull request labelled before its author claimed the issue loses the label here.
	for (const pull of await gh.openPulls()) {
		if (names(pull.labels).includes(UNCLAIMED)) await checkPull(gh, pull.number);
	}
	return released;
}

export async function main(env = process.env) {
	const gh = client({
		token: env.GITHUB_TOKEN,
		repo: env.GITHUB_REPOSITORY,
		api: env.GITHUB_API_URL,
	});
	const name = env.GITHUB_EVENT_NAME;
	if (name === "schedule" || name === "workflow_dispatch") {
		const released = await sweep(gh);
		console.log(`Released ${released.length} lapsed claim(s).`);
		return;
	}
	const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
	if (name === "issue_comment") await handleComment(gh, event);
	else if (name === "pull_request_target") await checkPull(gh, event.pull_request.number);
	else console.log(`Nothing to do for ${name}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
