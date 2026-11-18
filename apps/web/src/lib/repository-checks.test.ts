import { CHECK_ONE_LINE } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";
import {
	checksOfText,
	checksProblem,
	draftAfterRefresh,
	maySaveDraft,
	saveChecksAndRefresh,
} from "./repository-checks";

describe("the form for a repository's checks", () => {
	it("R1: reads one command to a line, without blank lines or the space around each", () => {
		expect(checksOfText("")).toEqual([]);
		expect(checksOfText("  \n\n")).toEqual([]);
		expect(checksOfText("pnpm check\r\n\n  pnpm test  \n")).toEqual(["pnpm check", "pnpm test"]);
	});

	it("R1: says why a list cannot be saved, in the words the server refuses it with", () => {
		expect(checksProblem("pnpm check\npnpm test")).toBeNull();
		expect(checksProblem("")).toBeNull();
		expect(checksProblem("a\nb\nc\nd\ne\nf")).toBe("A repository has at most 5 checks");
		expect(checksProblem("x".repeat(301))).toBe("A check is at most 300 characters");
		// A line break ends a command here, so only another control character is left to refuse.
		expect(checksProblem("pnpm\ttest")).toBe(CHECK_ONE_LINE);
	});

	it("R1: keeps what someone is typing when the saved list changes under it, and follows the list when nothing was typed", () => {
		const base = "pnpm check\npnpm test";
		// Nothing changed under the form: the draft is what it was.
		expect(draftAfterRefresh({ text: "pnpm check", base }, base)).toEqual({
			text: "pnpm check",
			base,
			stale: false,
		});
		// Another admin saved while this form held no edits, or only space: it takes the new list.
		for (const text of [base, `${base}\n\n`, "  pnpm check\npnpm test  "]) {
			expect(draftAfterRefresh({ text, base }, "pnpm lint")).toEqual({
				text: "pnpm lint",
				base: "pnpm lint",
				stale: false,
			});
		}
		// The list this form's own save wrote comes back: the draft is that list, and is not stale.
		expect(draftAfterRefresh({ text: "pnpm lint\n", base }, "pnpm lint")).toEqual({
			text: "pnpm lint",
			base: "pnpm lint",
			stale: false,
		});
		// Another admin saved while this one was typing: the typing stays, and the form says that
		// the saved list is not the one it began from.
		expect(draftAfterRefresh({ text: "pnpm check\npnpm e2e", base }, "pnpm lint")).toEqual({
			text: "pnpm check\npnpm e2e",
			base,
			stale: true,
		});
	});

	it("R1: a stale draft cannot replace unseen checks or a newer saved list", () => {
		expect(maySaveDraft(false, "pnpm lint", null)).toBe(true);
		expect(maySaveDraft(true, "pnpm lint", null)).toBe(false);
		expect(maySaveDraft(true, "pnpm lint", "pnpm lint")).toBe(true);
		expect(maySaveDraft(true, "pnpm test", "pnpm lint")).toBe(false);
	});

	it("R1: waits for the refreshed saved list before a save completes", async () => {
		const events: string[] = [];
		let finishRefresh: (() => void) | undefined;
		const refresh = new Promise<void>((resolve) => {
			finishRefresh = resolve;
		});
		const saving = saveChecksAndRefresh(
			["pnpm test"],
			async (checks) => {
				events.push(`saved ${checks.join(",")}`);
			},
			async (options) => {
				events.push(`refresh ${options.sync}`);
				await refresh;
			},
		).then(() => events.push("complete"));
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["saved pnpm test", "refresh true"]);
		finishRefresh?.();
		await saving;
		expect(events).toEqual(["saved pnpm test", "refresh true", "complete"]);
	});
});
