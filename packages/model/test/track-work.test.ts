import { describe, expect, it } from "vitest";
import { trackWorkInput, trackWorkPlan } from "../src";

const KEY = `gwt_${"a".repeat(43)}`;
const INPUT = {
	trackUrl: "https://track.gateweave.com/acme/issue/ENG-1",
	agentKey: KEY,
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	engine: "claude-code",
	repositoryId: "repo-1",
} as const;

describe("Track work input", () => {
	it("keeps where Track is, and names the agent Coder unless told otherwise", () => {
		expect(trackWorkInput.parse(INPUT)).toMatchObject({
			trackUrl: "https://track.gateweave.com",
			name: "Coder",
			engine: "claude-code",
		});
	});

	it("needs a repository, an engine and a whole Track key", () => {
		expect(trackWorkInput.safeParse({ ...INPUT, repositoryId: "" }).error?.issues[0]?.message).toBe(
			"Choose the repository it works in",
		);
		expect(trackWorkInput.safeParse({ ...INPUT, engine: "cursor" }).success).toBe(false);
		expect(trackWorkInput.safeParse({ ...INPUT, agentKey: "sk-ant-x" }).success).toBe(false);
	});

	it("takes the member's id as Track gives it, for the trigger's assignee", () => {
		const plan = { ...INPUT, instructions: "Work on it.", memberId: "Ab3_x-9" };
		expect(trackWorkPlan.parse(plan).memberId).toBe("Ab3_x-9");
		expect(trackWorkPlan.safeParse({ ...plan, memberId: "" }).success).toBe(false);
		expect(trackWorkPlan.safeParse({ ...plan, memberId: null }).success).toBe(false);
	});
});
