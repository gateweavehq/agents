/**
 * A repository's checks before a pull request (AGT-142). When the repository an agent works on
 * has checks, `open_pull_request` commits the work, runs each command here, in the sandbox, on
 * the tree as committed, and only then pushes and opens the pull request (`./pull-requests.ts`).
 * A check that fails stops the round, and the model reads which one, its exit code and the end
 * of its output, to fix the work and call again.
 *
 * Where each thing comes from is the point (WEB-67): the commands are the repository's settings
 * in the registry, read at each call; the section at the end of the pull request is written here,
 * from the commands, their exit codes and their durations; nothing of a command's output, and
 * nothing the model wrote, is in it. The output goes to the model alone, and never to the trace.
 *
 * The checks run on the agent's own machine, so they say what ran there. They are a first line
 * before a repository's own CI, not in place of it.
 */
import { CHECK_LIMITS, CHECKS_HEADING, SANDBOX_REPOSITORY_PATH } from "@gateweave/agents-model";
import type { OracleEdit, OracleReview } from "./oracles";
import { type CommandResult, SANDBOX_SERVER, type SandboxPort } from "./sandbox-tools";
import type { RunRecorder } from "./trace";

/** The tool the trace names for a check, under the sandbox's name like its other commands. */
export const CHECK_TOOL = "check";

/**
 * Whether the checkout still is the commit the checks are for: it is (null); it is not, with
 * what differs in git's words; or it could not be told, with why. The last two both fail a
 * round, and are kept apart so that nothing says a check changed files when nobody saw it do so.
 */
export type Comparison = null | { changed: string } | { unverified: string };

/** What runs a check: a sandbox's `run`, and its word on the checkout afterwards. */
export interface CheckRunner {
	run: SandboxPort["run"];
	/**
	 * Compares the checkout with the commit `head`. The checks run in the checkout, not on the
	 * commit itself, so it is asked after each one that passed: a check that changes a file, as a
	 * formatter does, would leave the next running on something that is not what gets pushed.
	 */
	changedSince(head: string): Promise<Comparison>;
}

/** How one check went. */
export type CheckOutcome =
	/** It exited, with this code: 0 passes, anything else fails. */
	| { kind: "exited"; exitCode: number }
	/** It was stopped at its time limit. Never a pass, whatever it had printed. */
	| { kind: "timed-out"; limitSeconds: number }
	/** The sandbox could not run it, or lost it. */
	| { kind: "sandbox-failed" }
	/** It was not started: a check before it failed, or the time for checks was used up. */
	| { kind: "not-run"; reason: string };

export interface CheckResult {
	command: string;
	outcome: CheckOutcome;
	/** How long it ran; 0 for one that was not started. */
	seconds: number;
	/** The end of its output, for the model alone; empty for one that passed or never ran. */
	tail: string;
}

/**
 * A round of checks: all passed; one did not, which stopped the round; or none could start,
 * because the run's time for checks was used up before the round began.
 */
export interface CheckRound {
	status: "passed" | "failed" | "not-run";
	results: CheckResult[];
	/**
	 * What differed in the checkout from the commit after a check that exited with 0, in git's
	 * words, which fails the round and stops it: the checks after it would have run on other
	 * files than the commit's. For the model alone, since it names files.
	 */
	changed?: string;
	/** Why the checkout could not be compared with the commit after a check, which fails the round too. */
	unverified?: string;
}

/** What a run has spent on checks so far, across its calls of `open_pull_request`. */
export interface ChecksSpent {
	failedRounds: number;
	seconds: number;
}

const EARLIER_FAILED = "an earlier check did not pass";
const EARLIER_CHANGED = "an earlier check left the repository's files different from the commit";
const EARLIER_UNVERIFIED =
	"it could not be told whether the repository's files were still the commit's";
const CALL_TIME_USED = `the ${minutes(CHECK_LIMITS.callSeconds)} minutes one call has for checks were used up`;
const RUN_TIME_USED = `the ${minutes(CHECK_LIMITS.runSeconds)} minutes a run has for checks were used up`;

function minutes(seconds: number): number {
	return Math.round(seconds / 60);
}

/** Whether a check passed: it exited with 0, and nothing else counts. */
export function checkPassed(result: CheckResult): boolean {
	return result.outcome.kind === "exited" && result.outcome.exitCode === 0;
}

/**
 * Runs the commands in order in the repository's root, on the checkout of the commit `head`, and
 * stops at the first that does not pass, or that passes and leaves the checkout different from
 * the commit. Each gets the time `CHECK_LIMITS` leaves it: its own limit, what is left of the
 * call's, and what is left of the run's, which `spent` carries from call to call. Each is a span
 * in the run's trace, with the size of its command and of its output, and why it did not pass.
 * Throws when `signal` gives up, as a turn that is stopped does.
 */
export async function runChecks(
	commands: readonly string[],
	sandbox: CheckRunner,
	head: string,
	run: RunRecorder,
	spent: ChecksSpent,
	{ now = Date.now, signal }: { now?: () => number; signal?: AbortSignal } = {},
): Promise<CheckRound> {
	const results: CheckResult[] = [];
	let callSeconds = 0;
	let stopped: string | null = null;
	let ran = false;
	let off: Exclude<Comparison, null> | null = null;
	for (const command of commands) {
		// A turn that was stopped starts no further command; the one under way runs to its end.
		signal?.throwIfAborted();
		if (stopped !== null) {
			results.push(notRun(command, stopped));
			continue;
		}
		const callLeft = CHECK_LIMITS.callSeconds - callSeconds;
		const runLeft = CHECK_LIMITS.runSeconds - spent.seconds;
		const limitSeconds = Math.floor(Math.min(CHECK_LIMITS.commandSeconds, callLeft, runLeft));
		if (limitSeconds < 1) {
			stopped = runLeft <= callLeft ? RUN_TIME_USED : CALL_TIME_USED;
			results.push(notRun(command, stopped));
			continue;
		}
		ran = true;
		const span = run.toolStarted(SANDBOX_SERVER, CHECK_TOOL, byteLength(command));
		const started = now();
		let answer: CommandResult | null;
		let expired = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			answer = await Promise.race([
				sandbox.run(command, SANDBOX_REPOSITORY_PATH, limitSeconds),
				new Promise<null>((resolve) => {
					timer = setTimeout(
						() => {
							expired = true;
							resolve(null);
						},
						(limitSeconds + 10) * 1000,
					);
				}),
			]);
		} catch {
			answer = null;
		} finally {
			clearTimeout(timer);
		}
		const seconds = Math.max(0, (now() - started) / 1000);
		callSeconds += seconds;
		spent.seconds += seconds;
		const result = expired
			? { command, outcome: { kind: "timed-out" as const, limitSeconds }, seconds, tail: "" }
			: checkResult(command, answer, limitSeconds, seconds);
		results.push(result);
		const passed = checkPassed(result);
		run.toolEnded(span, {
			outputBytes: answer === null ? 0 : byteLength(answer.output),
			error: passed ? null : describeOutcome(result.outcome),
		});
		if (!passed) {
			stopped = EARLIER_FAILED;
			continue;
		}
		signal?.throwIfAborted();
		// After each check that passed, not only the last: one that changed a file which a later
		// one puts back would leave the checkout looking like the commit at the end.
		off = await compared(sandbox, head);
		if (off !== null) stopped = "changed" in off ? EARLIER_CHANGED : EARLIER_UNVERIFIED;
	}
	if (!ran) return { status: "not-run", results };
	return { status: stopped === null ? "passed" : "failed", results, ...off };
}

/** The sandbox's word on the checkout; when it has none, that the two could not be compared. */
async function compared(sandbox: CheckRunner, head: string): Promise<Comparison> {
	try {
		return await sandbox.changedSince(head);
	} catch {
		return { unverified: "The sandbox could not say whether the checkout is still the commit." };
	}
}

function notRun(command: string, reason: string): CheckResult {
	return { command, outcome: { kind: "not-run", reason }, seconds: 0, tail: "" };
}

function checkResult(
	command: string,
	answer: CommandResult | null,
	limitSeconds: number,
	seconds: number,
): CheckResult {
	if (answer === null) return { command, outcome: { kind: "sandbox-failed" }, seconds, tail: "" };
	// The one place a command's output is taken from: its end, for the model.
	const tail = lastBytes(answer.output, CHECK_LIMITS.outputBytes);
	// A command stopped at its limit is never a pass, whatever exit code came with it.
	if (answer.timedOut) {
		return { command, outcome: { kind: "timed-out", limitSeconds }, seconds, tail };
	}
	const outcome: CheckOutcome = { kind: "exited", exitCode: answer.exitCode };
	return { command, outcome, seconds, tail: answer.exitCode === 0 ? "" : tail };
}

/** How a check went, in the words the trace and the model read. No output is in them. */
export function describeOutcome(outcome: CheckOutcome): string {
	switch (outcome.kind) {
		case "exited":
			return `It exited with code ${outcome.exitCode}`;
		case "timed-out":
			return `It timed out: it was stopped after ${outcome.limitSeconds} seconds`;
		case "sandbox-failed":
			return "The sandbox could not run it";
		case "not-run":
			return `It was not run: ${outcome.reason}`;
	}
}

/** Why the model's call opened nothing, with what it needs to fix the work and call again. */
export function describeFailedRound(round: CheckRound, spent: ChecksSpent): string {
	const failed = round.results.find(
		(result) => !checkPassed(result) && result.outcome.kind !== "not-run",
	);
	const left = CHECK_LIMITS.failedRounds - spent.failedRounds;
	return [
		"The repository's checks did not pass, so nothing was pushed and no pull request was opened or updated. Your work is committed in the sandbox.",
		failed ? describeFailedCheck(failed) : (describeChanged(round) ?? describeNotRun(round)),
		`Fix what failed and call the tool again. This was failed round ${spent.failedRounds} of ${CHECK_LIMITS.failedRounds} in this run: ${
			left === 1
				? "if the next one fails too, the pull request is opened as a draft that says which check failed."
				: `after ${CHECK_LIMITS.failedRounds} the pull request is opened as a draft that says which check failed.`
		}`,
	].join("\n\n");
}

/** What the model is told when the pull request was made although the checks did not pass. */
export function describeDraft(round: CheckRound): string {
	if (round.status === "not-run") {
		return `The repository's checks were not run: ${RUN_TIME_USED}. The pull request says so, and a new one is opened as a draft.`;
	}
	const failed = round.results.find(
		(result) => !checkPassed(result) && result.outcome.kind !== "not-run",
	);
	return [
		`The repository's checks failed in ${CHECK_LIMITS.failedRounds} rounds of this run, so the work was pushed as it is. The pull request says which check failed, and a new one is opened as a draft.`,
		failed ? describeFailedCheck(failed) : (describeChanged(round) ?? describeNotRun(round)),
	].join("\n\n");
}

/**
 * What the model is told of a round that a check ended by exiting with 0 and leaving the checkout
 * different from the commit, or impossible to compare with it; null for any other round.
 */
function describeChanged(round: CheckRound): string | null {
	const last = round.results.findLast((result) => result.outcome.kind !== "not-run");
	const which = last ? code(last.command) : "A check";
	if (round.changed !== undefined) {
		return `${which} exited with 0, but after it the repository's files were not the commit's any more, so the checks would not all have run on what gets pushed. git says:\n\n${round.changed}\n\nIf a check changes files on purpose, as a formatter that fixes them does, call the tool again: it commits what changed and checks that commit. If not, undo the changes first.`;
	}
	if (round.unverified !== undefined) {
		return `${which} exited with 0, but whether the repository's files were still the commit's after it could not be told, so the round does not count as passed. ${round.unverified} Call the tool again.`;
	}
	return null;
}

function describeFailedCheck(result: CheckResult): string {
	const how = `${code(result.command)}: ${describeOutcome(result.outcome)}, after ${duration(result.seconds)}.`;
	return result.tail.trim() === ""
		? `${how} It printed nothing.`
		: `${how} The end of its output:\n\n${result.tail}`;
}

function describeNotRun(round: CheckRound): string {
	const [first] = round.results.filter((result) => result.outcome.kind === "not-run");
	return first ? `${code(first.command)}: ${describeOutcome(first.outcome)}.` : "";
}

/**
 * The section at the end of a pull request's body, in the tool's own words: each command, its
 * exit code and its duration, on the commit they ran on. `draft` adds why the pull request is one.
 */
export function checksSection(
	round: CheckRound,
	head: string,
	draft: boolean,
	review: OracleReview | null = null,
): string {
	const lines = round.results.map((result) => `- ${code(result.command)}: ${line(result)}`);
	const about =
		round.status === "not-run"
			? `Checks: not run (${RUN_TIME_USED}).`
			: `Gateweave Agents ran these commands in the agent's sandbox on commit ${head.slice(0, 7)}, before pushing it.`;
	return section([
		about,
		lines.join("\n"),
		round.changed !== undefined
			? CHANGED_LINE
			: round.unverified !== undefined
				? UNVERIFIED_LINE
				: null,
		draft ? draftLine(round) : null,
		...oracleLines(review),
		WRITTEN_BY,
	]);
}

/** Whether a review is a reason for a draft: an edit to an oracle, or no way to tell. */
export function reviewFlagged(review: OracleReview | null): boolean {
	return review !== null && ("unverified" in review || review.edits.length > 0);
}

/**
 * What the section says of the files that decide whether the checks pass: which were
 * modified or deleted, from GitHub's list of what the branch changes, and not from anything the
 * agent wrote. A branch that touched none says nothing.
 */
function oracleLines(review: OracleReview | null): string[] {
	if (review === null) return [];
	if ("unverified" in review) {
		return [
			`Gateweave could not tell whether this pull request edits the files its checks rely on (${review.unverified}), so it makes the pull request a draft, converting one that was open already.`,
		];
	}
	if (review.edits.length === 0) return [];
	return [
		"This pull request modifies or deletes files that decide whether its own checks pass, so passing checks prove less. Gateweave makes it a draft, converting one that was open already, until a person has read these changes:",
		review.edits.map((edit) => `- ${code(edit.path)}: ${edit.change} (${edit.kind})`).join("\n"),
	];
}

/** What the model is told when a pull request is a draft for what it edited. */
export function describeEdits(review: OracleReview | null): string | null {
	if (review === null || !reviewFlagged(review)) return null;
	if ("unverified" in review) {
		return `Gateweave could not tell whether the work edits the files its checks rely on (${review.unverified}), so the pull request is opened as a draft.`;
	}
	const listed = review.edits.map((edit: OracleEdit) => `${edit.path} (${edit.change})`);
	return `The work modifies or deletes files that decide whether its checks pass: ${listed.join(", ")}. The pull request lists them and is made a draft. Adding tests is not flagged; change these only when the task needs it, and say why in the description.`;
}

/**
 * The section of a pull request whose repository has no checks, when the branch still edits what
 * checks would rely on. Null when it does not: such a pull request has no section.
 */
export function editsSection(review: OracleReview | null): string | null {
	return reviewFlagged(review) ? section([...oracleLines(review), WRITTEN_BY]) : null;
}

/**
 * What the section says of a round that a check ended by exiting with 0 and changing the
 * repository's files. Which files is not said here: their names are the agent's to choose.
 */
const CHANGED_LINE =
	"A check exited with 0 but left the repository's files different from this commit, so the checks did not all run on it as it is. That counts as a failed round.";

/** The same for a round after which the checkout could not be compared with the commit. */
const UNVERIFIED_LINE =
	"A check exited with 0, but Gateweave could not make sure that the repository's files were still this commit's afterwards. That counts as a failed round.";

/** The section of a pull request whose checks are set but had nowhere to run. */
export function checksNotRunSection(reason: string, review: OracleReview | null = null): string {
	return section([`Checks: not run (${reason}).`, ...oracleLines(review), WRITTEN_BY]);
}

/**
 * How every section ends. It says where the section stands, since that is what a reader can
 * rely on: the tool appends it after everything the model wrote, whatever the model wrote.
 */
const WRITTEN_BY =
	"The commands are set on the repository's page in Gateweave Agents. Gateweave wrote this section, not the agent: it is always the last one, and what stands above it is the agent's.";

/** Why a turn that works on files without a sandbox runs no checks. */
export const NO_SANDBOX = "no sandbox in this run";

function section(parts: (string | null)[]): string {
	return [`## ${CHECKS_HEADING}`, ...parts.filter((part) => part !== null)].join("\n\n");
}

function draftLine(round: CheckRound): string {
	const why =
		round.status === "not-run"
			? "The checks could not run"
			: `The checks failed in ${CHECK_LIMITS.failedRounds} rounds of this run`;
	return `${why}, so Gateweave opens the pull request as a draft. One that was open already stays as it was.`;
}

function line({ outcome, seconds }: CheckResult): string {
	switch (outcome.kind) {
		case "exited":
			return `${outcome.exitCode === 0 ? "passed" : "failed"}, exit code ${outcome.exitCode}, ${duration(seconds)}`;
		case "timed-out":
			return `timed out, no exit code, stopped after ${duration(seconds)} (limit ${outcome.limitSeconds} s)`;
		case "sandbox-failed":
			return `failed, no exit code: the sandbox could not run it, ${duration(seconds)}`;
		case "not-run":
			return `not run (${outcome.reason})`;
	}
}

function duration(seconds: number): string {
	return `${seconds.toFixed(1)} s`;
}

/**
 * A command as Markdown shows it, as it is: a code span fenced by more backticks than the
 * command has in a row, so nothing in it ends the span or is read as Markdown.
 */
function code(command: string): string {
	let longest = 0;
	for (const run of command.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(longest + 1);
	return longest === 0 ? `${fence}${command}${fence}` : `${fence} ${command} ${fence}`;
}

/**
 * The model's body without any section under the tool's heading, so the only one a reader finds
 * is the one the tool wrote. A line counts as the heading by its letters alone, whatever marks it
 * up: `#` signs, emphasis, a quote, HTML tags, a link, character references, a colon, another
 * case. The section goes from there to the next `#` heading, or to the end. A body without the
 * heading comes back as it is.
 *
 * This takes out the copies a model is likely to write, not every string a page would show as
 * those words: that would take a Markdown renderer. What holds whatever the model wrote is the
 * section's place, which the section states: the tool's is the last one.
 */
export function withoutChecksSection(body: string): string {
	const kept: string[] = [];
	let forged = false;
	let removed = false;
	for (const each of body.split("\n")) {
		if (isChecksHeading(each)) {
			forged = true;
			removed = true;
			continue;
		}
		if (forged && /^\s{0,3}#{1,6}(\s|$)/.test(each)) forged = false;
		if (!forged) kept.push(each);
	}
	return removed ? kept.join("\n").trimEnd() : body;
}

function isChecksHeading(text: string): boolean {
	return plain(text) === PLAIN_HEADING;
}

/** A line's letters and digits as a page shows them, in lower case: its words and no more. */
function plain(text: string): string {
	return shown(text)
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]/gu, "")
		.toLowerCase();
}

/**
 * A line without what a page does not show of it: its HTML tags, the target of a link, and
 * character references, a numbered one as the character it stands for. It is not a renderer:
 * it only keeps the ways of writing the heading's words that come to mind from getting past
 * `withoutChecksSection`, which is why the tool's section also says that it comes last.
 */
function shown(text: string): string {
	return withoutLinkTargets(withoutTags(text)).replace(
		/&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});|&[A-Za-z][A-Za-z0-9]{1,31};/g,
		(_reference, decimal?: string, hex?: string) => {
			// A named reference is a space, a mark or a letter of another alphabet: never one of
			// the heading's own, so it is dropped as any mark is.
			if (decimal === undefined && hex === undefined) return "";
			const code = decimal === undefined ? Number.parseInt(hex ?? "", 16) : Number(decimal);
			const character = code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
			return character ? String.fromCodePoint(code) : "";
		},
	);
}

/**
 * `text` without the targets of its Markdown links, which follow a link's text as `](…)` or
 * `][…]`. Read once from left to right, like `withoutTags`: a body can be made of thousands of
 * openers and no closer.
 */
function withoutLinkTargets(text: string): string {
	let kept = "";
	let at = 0;
	// Once a closer is looked for and not found, there is none further on either.
	const none = { ")": false, "]": false };
	for (let next = text.indexOf("]"); next !== -1; next = text.indexOf("]", at)) {
		const after = text[next + 1];
		const closer = after === "(" ? ")" : after === "[" ? "]" : null;
		const end = closer === null || none[closer] ? -1 : text.indexOf(closer, next + 2);
		if (closer !== null && end === -1) none[closer] = true;
		// With a target, the text up to the `]` stays and the target goes; without, the `]` stays.
		kept += text.slice(at, end === -1 ? next + 1 : next);
		at = end === -1 ? next + 1 : end + 1;
	}
	return kept + text.slice(at);
}

/**
 * `text` without its tags, read once from left to right: what stands between a `<` and the `>`
 * that closes it is left out, tags inside tags too, so that taking one out never leaves another
 * (`<<b>h2>`). A `<` that nothing closes is text, as a page shows it.
 */
function withoutTags(text: string): string {
	let kept = "";
	// What has been left out since the outermost `<`, in case nothing closes it.
	let tag = "";
	let depth = 0;
	for (const character of text) {
		if (character === "<") depth += 1;
		if (depth === 0) kept += character;
		else tag += character;
		if (character === ">" && depth > 0) {
			depth -= 1;
			if (depth === 0) tag = "";
		}
	}
	return kept + tag;
}

/** The heading as `plain` leaves it, which a line is compared with. */
const PLAIN_HEADING = plain(CHECKS_HEADING);

/** The body with the tool's section after it. */
export function withChecksSection(body: string, section: string): string {
	const before = closed(withoutChecksSection(body).trimEnd());
	return before === "" ? section : `${before}\n\n${section}`;
}

/**
 * GitHub's limit on a body, in characters. It is measured with a string's length, in UTF-16
 * units, which are never fewer than code points: the bound holds whichever of the two GitHub
 * counts.
 */
const BODY_LIMIT = 65_536;

/** The line that ends the model's part when it was cut to make room for the tool's section. */
export const SHORTENED =
	"_The description above was shortened to fit GitHub's length limit for a pull request._";

/** The body without the AI disclosure `pullRequestBody` writes: its comment and its byline. */
export function withoutDisclosure(body: string): string {
	return body
		.replace(/<!--\s*AI-Disclosure:[\s\S]*?-->/gi, "")
		.replace(
			/^[ \t]*Written and opened by (?:[^\r\n]+, )?an AI agent in Gateweave Agents\.[ \t]*\r?(?:\n|$)/gm,
			"",
		);
}

/**
 * Keep the checks and disclosure whole, shortening only the model's part at a code point.
 */
export function pullRequestBody(body: string, section: string | null, agentName: string): string {
	// A code span also prevents GitHub from linking names that look like mentions or URLs.
	const name = Array.from(agentName.replace(/[`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim())
		.slice(0, 100)
		.join("")
		.trimEnd();
	const byline = name ? `\`${name}\`, an AI agent` : "an AI agent";
	const disclosure = `Written and opened by ${byline} in Gateweave Agents.\n<!-- AI-Disclosure: mode=machine-generated -->`;
	const suffix = section === null ? disclosure : `${section}\n\n${disclosure}`;
	const description = withoutDisclosure(body);
	const model = withoutChecksSection(description === body ? description : description.trimEnd());
	const before = closed(section === null ? model : model.trimEnd());
	const full = before === "" ? suffix : `${before}\n\n${suffix}`;
	if (full.length <= BODY_LIMIT) return full;
	const shortened = (model: string) => {
		const before = closed(model.trimEnd());
		return `${before === "" ? "" : `${before}\n\n`}${SHORTENED}\n\n${suffix}`;
	};
	const characters = Array.from(model);
	let low = 0;
	let high = characters.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (shortened(characters.slice(0, middle).join("")).length <= BODY_LIMIT) low = middle;
		else high = middle - 1;
	}
	return shortened(characters.slice(0, low).join(""));
}

/**
 * The model's body with what it left open closed: a code block, an HTML comment or another of
 * the blocks Markdown hands to HTML until their end mark, a folded `<details>`. Left open, each
 * would take in whatever follows, and the tool's section would be shown as code, or not shown
 * at all, under a body that claims what it likes.
 *
 * It is not a renderer, and where the two differ it closes once too often rather than once too
 * seldom: a closer too many leaves a stray line or shows the section as code, both in plain
 * sight, which is the side to err on.
 */
function closed(model: string): string {
	// A body this tool wrote before, which the model may send back, ends with the line; it is put
	// back below. One with closers after it stays where it is: it ends the tag that those closers
	// would otherwise fall inside.
	let body = model;
	while (body.trimEnd().endsWith(TAG_CLOSER)) {
		const kept = body.trimEnd().slice(0, -TAG_CLOSER.length);
		if (kept !== "" && !kept.endsWith("\n")) break;
		body = kept.replace(/\n$/, "");
	}
	const closers: string[] = [];
	// A fence is closed by a line of the same character, at least as long, with nothing after.
	let fence: string | null = null;
	// A comment that begins a line outside a fence runs to the line with its end mark, and a line
	// of backticks inside it is the comment's own: closing it would open a fence after the comment.
	let comment = false;
	for (const line of body.split("\n")) {
		if (comment) {
			comment = !line.includes("-->");
			continue;
		}
		if (fence === null && /^ {0,3}<!--/.test(line)) {
			comment = !line.includes("-->", line.indexOf("<!--") + 4);
			continue;
		}
		const marks = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (!marks) continue;
		const [, run = "", rest = ""] = marks;
		if (fence === null) fence = run;
		else if (run.startsWith(fence) && rest.trim() === "") fence = null;
	}
	if (fence !== null) closers.push(fence);
	for (const [opener, closer] of HTML_UNTIL) {
		if (body.lastIndexOf(opener) > body.lastIndexOf(closer)) closers.push(closer);
	}
	// A declaration, such as `<!DOCTYPE`, runs to the next `>`: one after the last `>` is open.
	if (/<![A-Za-z]/.test(body.slice(body.lastIndexOf(">") + 1))) closers.push(">");
	if (/<\/?[A-Za-z]/.test(body)) closers.push(TAG_CLOSER);
	const opened = body.match(/<details[\s>]/gi)?.length ?? 0;
	const ended = body.match(/<\/details\s*>/gi)?.length ?? 0;
	for (let left = Math.min(opened - ended, MAX_FOLDS); left > 0; left -= 1) {
		closers.push("</details>");
	}
	for (const tag of ["pre", "script", "style", "textarea"]) {
		let open = false;
		const tags = new RegExp(`<${tag}(?=[\\s>]|$)|</${tag}\\s*>`, "gi");
		for (const [matched] of body.matchAll(tags)) {
			open = !matched.startsWith("</");
		}
		if (open) closers.push(`</${tag}>`);
	}
	return closers.length === 0 ? body : `${body}\n${closers.join("\n")}`;
}

/**
 * What starts a block that Markdown passes on as HTML until its end mark, or to the end of the
 * text when there is none (CommonMark's HTML blocks 2, 3 and 5), each with that mark: a comment,
 * a processing instruction, and CDATA. A page shows nothing of what is inside one.
 */
const HTML_UNTIL: readonly (readonly [string, string])[] = [
	["<!--", "-->"],
	["<?", "?>"],
	["<![CDATA[", "]]>"],
];

/**
 * A line that ends a tag a page may still be inside where the model's text ends, and shows
 * nothing otherwise. Markdown passes on as they are the lines of an HTML block, and a tag left
 * unfinished in one, such as `<div title="cut`, would take what follows into an attribute: the
 * section and the disclosure. Whether a page is inside a tag there depends on which lines Markdown
 * passes on, in lists and quotes too, which this does not work out, so the line follows any text
 * with a tag in it. In a double-quoted value its `"` ends the value, in a single-quoted one its
 * `'`, and then, as in a tag outside any value, the `>` ends the tag. Where no tag is open it is a
 * comment, which Markdown passes on as a block of its own.
 */
const TAG_CLOSER = `<!-- " ' -->`;

/** Most `<details>` the tool closes after a body, which no body a person reads comes near. */
const MAX_FOLDS = 50;

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/** The last `limit` bytes of `text`, starting at a whole character. */
export function lastBytes(text: string, limit: number): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= limit) return text;
	let start = bytes.length - limit;
	// A byte of the form 10xxxxxx continues a character that began earlier.
	while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return new TextDecoder().decode(bytes.subarray(start));
}
