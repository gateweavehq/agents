import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLAIMED,
	checkPull,
	claimLimit,
	client,
	decideClaim,
	decideRelease,
	handleComment,
	isLapsed,
	isUnclaimed,
	mentionedIssues,
	parseCommand,
	readTimeline,
	sweep,
	TOGETHER,
	UNCLAIMED,
	UNCLAIMED_MARKER,
} from "./claim.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-03-20T12:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

const issue = (extra = {}) => ({
	number: 5,
	state: "open",
	labels: [{ name: TOGETHER }],
	assignees: [],
	...extra,
});
const claim = (extra = {}) =>
	decideClaim({
		actor: "ada",
		target: null,
		isMaintainer: false,
		issue: issue(),
		openClaims: 0,
		mergedPullRequests: 0,
		...extra,
	});

test("parseCommand reads the first line only", () => {
	assert.deepEqual(parseCommand("/claim"), { command: "claim", target: null });
	assert.deepEqual(parseCommand("\n  /release  \nthanks"), { command: "release", target: null });
	assert.deepEqual(parseCommand("/claim @grace-h"), { command: "claim", target: "grace-h" });
	assert.equal(parseCommand("please /claim"), null);
	assert.equal(parseCommand("/claimed"), null);
	assert.equal(parseCommand("hello\n/claim"), null);
	assert.equal(parseCommand(null), null);
});

test("the limit is one claim, or three after a merged pull request", () => {
	assert.equal(claimLimit(0), 1);
	assert.equal(claimLimit(1), 3);
	assert.equal(claimLimit(12), 3);
});

test("a first claim is granted", () => {
	const verdict = claim();
	assert.equal(verdict.ok, true);
	assert.equal(verdict.who, "ada");
});

test("a second open claim is refused before the first merged pull request, with the reason", () => {
	const verdict = claim({ openClaims: 1 });
	assert.equal(verdict.ok, false);
	assert.match(verdict.message, /limit/);
	assert.match(verdict.message, /first merged pull request/);
});

test("after a merged pull request the limit is three", () => {
	assert.equal(claim({ openClaims: 2, mergedPullRequests: 1 }).ok, true);
	const refused = claim({ openClaims: 3, mergedPullRequests: 1 });
	assert.equal(refused.ok, false);
	assert.doesNotMatch(refused.message, /first merged pull request/);
});

test("only issues labelled together, and only open ones, can be claimed", () => {
	assert.equal(claim({ issue: issue({ labels: [] }) }).ok, false);
	assert.equal(claim({ issue: issue({ state: "closed" }) }).ok, false);
	assert.equal(claim({ issue: issue({ pull_request: {} }) }).ok, false);
});

test("an issue somebody holds cannot be claimed, except by a maintainer's override", () => {
	const held = issue({ assignees: [{ login: "grace" }] });
	const refused = claim({ issue: held });
	assert.equal(refused.ok, false);
	assert.match(refused.message, /@grace already holds/);
	assert.equal(claim({ issue: held, actor: "grace" }).ok, false);

	const override = claim({ issue: held, actor: "boss", target: "ada", isMaintainer: true });
	assert.equal(override.ok, true);
	assert.deepEqual(override.replaces, ["grace"]);
});

test("a maintainer's claim for someone ignores the limits; anyone else's is refused", () => {
	const forced = claim({
		actor: "boss",
		target: "ada",
		isMaintainer: true,
		openClaims: 5,
	});
	assert.equal(forced.ok, true);
	assert.equal(forced.who, "ada");
	const refused = claim({ actor: "mallory", target: "ada" });
	assert.equal(refused.ok, false);
});

test("release: the holder or a maintainer, nobody else", () => {
	const held = issue({
		labels: [{ name: TOGETHER }, { name: CLAIMED }],
		assignees: [{ login: "ada" }],
	});
	assert.equal(decideRelease({ actor: "ada", isMaintainer: false, issue: held }).ok, true);
	assert.equal(decideRelease({ actor: "boss", isMaintainer: true, issue: held }).ok, true);
	const refused = decideRelease({ actor: "mallory", isMaintainer: false, issue: held });
	assert.equal(refused.ok, false);
	assert.match(refused.message, /@ada/);
	assert.equal(decideRelease({ actor: "ada", isMaintainer: false, issue: issue() }).ok, false);
});

test("a claim lapses after seven days without a pull request", () => {
	assert.equal(isLapsed({ claimedAt: ago(6.9), hasPullRequest: false, now: NOW }), false);
	assert.equal(isLapsed({ claimedAt: ago(7), hasPullRequest: false, now: NOW }), true);
	assert.equal(isLapsed({ claimedAt: ago(30), hasPullRequest: true, now: NOW }), false);
	assert.equal(isLapsed({ claimedAt: null, hasPullRequest: false, now: NOW }), false);
});

test("readTimeline takes the latest claim and counts only the holder's live pull requests", () => {
	const pullEvent = (login, extra = {}, at = ago(2)) => ({
		event: "cross-referenced",
		created_at: at,
		source: { issue: { user: { login }, state: "open", pull_request: {}, ...extra } },
	});
	const labeled = (at) => ({ event: "labeled", label: { name: CLAIMED }, created_at: at });
	const base = [
		labeled(ago(20)),
		{ event: "unlabeled", label: { name: CLAIMED } },
		labeled(ago(8)),
	];
	assert.equal(readTimeline(base, "ada").claimedAt, ago(8));
	assert.equal(readTimeline([...base, pullEvent("ada")], "ada").hasPullRequest, true);
	assert.equal(readTimeline([...base, pullEvent("ADA")], "ada").hasPullRequest, true);
	assert.equal(readTimeline([...base, pullEvent("grace")], "ada").hasPullRequest, false);
	const abandoned = pullEvent("ada", { state: "closed", pull_request: { merged_at: null } });
	assert.equal(readTimeline([...base, abandoned], "ada").hasPullRequest, false);
	const merged = pullEvent("ada", { state: "closed", pull_request: { merged_at: ago(1) } });
	assert.equal(readTimeline([...base, merged], "ada").hasPullRequest, true);
	// Pull request first, claim second: an open or merged pull request counts whatever its date.
	assert.equal(readTimeline([...base, pullEvent("ada", {}, ago(15))], "ada").hasPullRequest, true);
	const oldMerged = pullEvent("ada", { state: "closed", pull_request: { merged_at: ago(14) } });
	assert.equal(
		readTimeline([...base, { ...oldMerged, created_at: ago(15) }], "ada").hasPullRequest,
		true,
	);
	// One closed unmerged never counts, however old or new.
	const oldAbandoned = { ...abandoned, created_at: ago(15) };
	assert.equal(readTimeline([...base, oldAbandoned], "ada").hasPullRequest, false);
	// Every holder is checked, not only the first.
	assert.equal(readTimeline([...base, pullEvent("grace")], ["ada", "grace"]).hasPullRequest, true);
	assert.equal(
		readTimeline([...base, pullEvent("mallory")], ["ada", "grace"]).hasPullRequest,
		false,
	);
});

test("mentionedIssues finds issue numbers, not the pull request's own or a path", () => {
	const numbers = mentionedIssues({
		number: 9,
		title: "Fix #12",
		body: "Closes #5. Same as #9. See org/repo#77 and a#8.",
	});
	assert.deepEqual(numbers.sort(), [12, 5]);
});

test("a pull request is unclaimed unless its author holds a mentioned issue", () => {
	const held = [{ assignees: [{ login: "Ada" }] }];
	assert.equal(
		isUnclaimed({ author: "ada", isMaintainer: false, isBot: false, mentioned: held }),
		false,
	);
	assert.equal(
		isUnclaimed({ author: "ada", isMaintainer: false, isBot: false, mentioned: [] }),
		true,
	);
	assert.equal(
		isUnclaimed({ author: "grace", isMaintainer: false, isBot: false, mentioned: held }),
		true,
	);
	assert.equal(
		isUnclaimed({ author: "boss", isMaintainer: true, isBot: false, mentioned: [] }),
		false,
	);
	assert.equal(
		isUnclaimed({ author: "bot", isMaintainer: false, isBot: true, mentioned: [] }),
		false,
	);
});

// A recording stand-in for the GitHub client.
function fake({
	issues = {},
	pulls = {},
	maintainers = [],
	counts = {},
	timelines = {},
	comments = {},
}) {
	const calls = [];
	const record =
		(name) =>
		async (...args) => {
			calls.push([name, ...args]);
		};
	return {
		calls,
		issue: async (n) => issues[n] ?? null,
		pull: async (n) => pulls[n] ?? null,
		timeline: async (n) => timelines[n] ?? [],
		comments: async (n) => comments[n] ?? [],
		openIssues: async () => Object.values(issues).filter((i) => i.state === "open"),
		openPulls: async () => Object.values(pulls),
		isMaintainer: async (login) => maintainers.includes(login),
		count: async (query) => counts[query] ?? 0,
		openClaims: async (login) => counts[`claims:${login}`] ?? 0,
		comment: record("comment"),
		addLabel: record("addLabel"),
		removeLabel: record("removeLabel"),
		assign: record("assign"),
		unassign: record("unassign"),
	};
}

const commentEvent = (body, login = "ada") => ({
	action: "created",
	issue: { number: 5 },
	comment: { body, user: { login, type: "User" } },
});

test("/claim assigns, labels and answers", async () => {
	const gh = fake({ issues: { 5: issue() } });
	await handleComment(gh, commentEvent("/claim"));
	assert.deepEqual(
		gh.calls.map((c) => c[0]),
		["assign", "addLabel", "comment"],
	);
	assert.deepEqual(gh.calls[0].slice(1), [5, ["ada"]]);
});

test("a maintainer's override labels the issue afresh, so the new claim starts its own seven days", async () => {
	const held = issue({
		labels: [{ name: TOGETHER }, { name: CLAIMED }],
		assignees: [{ login: "grace" }],
	});
	const gh = fake({ issues: { 5: held }, maintainers: ["boss"] });
	await handleComment(gh, commentEvent("/claim @ada", "boss"));
	assert.deepEqual(
		gh.calls.map((c) => c[0]),
		["unassign", "assign", "removeLabel", "addLabel", "comment"],
	);

	// The timeline that produces, on day 6 of grace's claim, read by the sweep on day 8.
	const timeline = [
		{ event: "labeled", label: { name: CLAIMED }, created_at: ago(8) },
		{ event: "unlabeled", label: { name: CLAIMED }, created_at: ago(2) },
		{ event: "labeled", label: { name: CLAIMED }, created_at: ago(2) },
	];
	const taken = issue({
		labels: [{ name: CLAIMED }],
		assignees: [{ login: "ada" }],
	});
	const sweeper = fake({ issues: { 5: taken }, timelines: { 5: timeline } });
	assert.deepEqual(await sweep(sweeper, NOW), []);
	assert.deepEqual(sweeper.calls, []);
});

test("a first claim on an issue without the label does not remove it first", async () => {
	const gh = fake({ issues: { 5: issue() } });
	await handleComment(gh, commentEvent("/claim"));
	assert.equal(
		gh.calls.some((c) => c[0] === "removeLabel"),
		false,
	);
});

test("the open-claim count is read through the issues endpoint, not the search index", async () => {
	const requests = [];
	const gh = client({
		token: "t",
		repo: "o/r",
		api: "https://api.example.test",
		fetchImpl: async (url) => {
			requests.push(String(url));
			return {
				ok: true,
				status: 200,
				json: async () => [{ number: 1 }, { number: 2, pull_request: {} }],
			};
		},
	});
	assert.equal(await gh.openClaims("Ada"), 1);
	assert.match(requests[0], /\/repos\/o\/r\/issues\?state=open&labels=claimed&assignee=Ada/);
	assert.equal(
		requests.some((url) => url.includes("/search/")),
		false,
	);
});

test("a claim whose pull request came first is kept by the sweep", async () => {
	const held = issue({ labels: [{ name: CLAIMED }], assignees: [{ login: "ada" }] });
	const timeline = [
		{
			event: "cross-referenced",
			created_at: ago(12),
			source: { issue: { user: { login: "ada" }, state: "open", pull_request: {} } },
		},
		{ event: "labeled", label: { name: CLAIMED }, created_at: ago(9) },
	];
	const gh = fake({ issues: { 5: held }, timelines: { 5: timeline } });
	assert.deepEqual(await sweep(gh, NOW), []);
	assert.deepEqual(gh.calls, []);
});

test("/claim over the limit changes nothing and says why", async () => {
	const gh = fake({
		issues: { 5: issue() },
		counts: { "claims:ada": 1 },
	});
	await handleComment(gh, commentEvent("/claim"));
	assert.deepEqual(
		gh.calls.map((c) => c[0]),
		["comment"],
	);
	assert.match(gh.calls[0][2], /limit/);
});

test("/release by the holder unassigns and removes the label", async () => {
	const held = issue({ labels: [{ name: CLAIMED }], assignees: [{ login: "ada" }] });
	const gh = fake({ issues: { 5: held } });
	await handleComment(gh, commentEvent("/release"));
	assert.deepEqual(
		gh.calls.map((c) => c[0]),
		["unassign", "removeLabel", "comment"],
	);
});

test("a bot's comment and an ordinary comment are ignored", async () => {
	const gh = fake({ issues: { 5: issue() } });
	const bot = commentEvent("/claim");
	bot.comment.user.type = "Bot";
	await handleComment(gh, bot);
	await handleComment(gh, commentEvent("looks good"));
	assert.deepEqual(gh.calls, []);
});

test("the sweep releases only claims past seven days with no pull request", async () => {
	const claimed = (n) =>
		issue({ number: n, labels: [{ name: CLAIMED }], assignees: [{ login: "ada" }] });
	const labeled = (at) => [{ event: "labeled", label: { name: CLAIMED }, created_at: at }];
	const withPull = [
		...labeled(ago(10)),
		{
			event: "cross-referenced",
			created_at: ago(3),
			source: { issue: { user: { login: "ada" }, state: "open", pull_request: {} } },
		},
	];
	const gh = fake({
		issues: { 1: claimed(1), 2: claimed(2), 3: claimed(3) },
		timelines: { 1: labeled(ago(8)), 2: labeled(ago(3)), 3: withPull },
	});
	const released = await sweep(gh, NOW);
	assert.deepEqual(released, [1]);
	const names = gh.calls.map((c) => c[0]);
	assert.deepEqual(names, ["unassign", "removeLabel", "comment"]);
	assert.match(gh.calls[2][2], /lapsed after 7 days/);
});

test("an unclaimed pull request is labelled and commented once, and stays open", async () => {
	const pull = {
		number: 9,
		state: "open",
		title: "Fix a thing",
		body: "No issue",
		user: { login: "newcomer", type: "User" },
		labels: [],
	};
	const gh = fake({ pulls: { 9: pull } });
	await checkPull(gh, 9);
	assert.deepEqual(
		gh.calls.map((c) => c[0]),
		["addLabel", "comment"],
	);
	assert.equal(gh.calls[0][2], UNCLAIMED);
	assert.ok(gh.calls[1][2].startsWith(UNCLAIMED_MARKER));
	// Nothing in the flow can close it: the client has no such call.
	assert.equal(typeof gh.close, "undefined");

	const again = fake({
		pulls: { 9: { ...pull, labels: [{ name: UNCLAIMED }] } },
		comments: { 9: [{ body: `${UNCLAIMED_MARKER}\nearlier` }] },
	});
	await checkPull(again, 9);
	assert.deepEqual(again.calls, []);
});

test("a pull request whose author holds the issue is not labelled, and loses a stale label", async () => {
	const pull = {
		number: 9,
		state: "open",
		title: "Fix",
		body: "Closes #5",
		user: { login: "ada", type: "User" },
		labels: [{ name: UNCLAIMED }],
	};
	const gh = fake({
		pulls: { 9: pull },
		issues: { 5: issue({ assignees: [{ login: "ada" }] }) },
	});
	await checkPull(gh, 9);
	assert.deepEqual(
		gh.calls.map((c) => c.slice(0, 3)),
		[["removeLabel", 9, UNCLAIMED]],
	);
});

test("a maintainer's pull request is never unclaimed", async () => {
	const pull = {
		number: 9,
		state: "open",
		title: "Chore",
		body: "",
		user: { login: "boss", type: "User" },
		labels: [],
	};
	const gh = fake({ pulls: { 9: pull }, maintainers: ["boss"] });
	await checkPull(gh, 9);
	assert.deepEqual(gh.calls, []);
});
