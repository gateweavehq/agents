import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHECK_LIMITS, CHECKS_HEADING } from "@gateweave/agents-model";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");

/** A doc as one line of text, so a sentence wrapped over two lines is still found. */
const doc = (name: string) =>
	readFileSync(resolve(ROOT, "docs", name), "utf8").replace(/\s+/g, " ");

const minutes = (seconds: number) => seconds / 60;

describe("the docs on a repository's checks (AGT-142)", () => {
	it("R8: docs/track-work.md says how to set them, with the limits the code keeps, and what the section means", () => {
		const text = doc("track-work.md");
		expect(text).toContain("## Checks before a pull request");
		// How to set them, and who may.
		expect(text).toContain("open the repository under **Repositories**");
		expect(text).toContain("Only an owner or admin of the workspace can");
		expect(text).toContain(
			`at most ${CHECK_LIMITS.commands} checks, each one line of at most ${CHECK_LIMITS.commandLength} characters`,
		);
		// The numbers are the code's: a limit changed there fails here until the docs follow.
		expect(text).toContain(`After ${CHECK_LIMITS.failedRounds} failed rounds in one run`);
		expect(text).toContain(`the last ${CHECK_LIMITS.outputBytes.toLocaleString("en-US")} bytes`);
		expect(text).toContain(
			`Each command may run for ${minutes(CHECK_LIMITS.commandSeconds)} minutes. The checks of one \`open_pull_request\` call may run for ${minutes(CHECK_LIMITS.callSeconds)} minutes together, and those of one run for ${minutes(CHECK_LIMITS.runSeconds)}.`,
		);
		// What the section in the pull request means, by the heading the tool writes.
		expect(text).toContain(`a section headed **${CHECKS_HEADING}**`);
		expect(text).toContain("Gateweave writes that section, not the agent.");
		expect(text).toContain("says `not run`, with the reason");
		// Where the commands come from, and what is not built.
		expect(text).toContain("Only from the repository's page in Agents");
		expect(text).toContain("Reading them from a file on the default branch is not supported yet.");
		expect(text).toContain("Claude Code, Codex and OpenCode");
	});

	it("R8: docs/self-hosting.md tells whoever runs a server where they are set and what they cost", () => {
		const text = doc("self-hosting.md");
		expect(text).toContain("#### Checks before a pull request");
		expect(text).toContain("They are set on the repository's page under **Repositories**");
		expect(text).toContain("no file in the repository names them yet");
		expect(text).toContain("(track-work.md#checks-before-a-pull-request)");
		expect(text).toContain(`the section **${CHECKS_HEADING}**`);
		expect(text).toContain(
			`A command may run for ${minutes(CHECK_LIMITS.commandSeconds)} minutes, the checks of one pull request call for ${minutes(CHECK_LIMITS.callSeconds)} and those of one run for ${minutes(CHECK_LIMITS.runSeconds)}.`,
		);
		expect(text).toContain("`SANDBOX_DAILY_MINUTES`");
	});
});
