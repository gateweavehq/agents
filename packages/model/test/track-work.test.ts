import { describe, expect, it } from "vitest";
import {
	assigneeSkip,
	TRACK_WORK_EVENTS,
	TRACK_WORK_PROMPT,
	trackWorkInput,
	trackWorkPlan,
	triggerMessage,
} from "../src";

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

describe("Track work trigger", () => {
	const event = (type: string) =>
		JSON.stringify({
			type,
			data: {
				workspace: { id: "w-1", slug: "acme" },
				issue: { id: "issue-7", key: "ENG-7", title: "Login fails", assigneeId: "coder" },
				actor: { id: "maya", name: "Maya", type: "person" },
			},
		});

	it("tells the agent what happened to its issue, whichever event it was", () => {
		for (const type of TRACK_WORK_EVENTS) {
			expect(triggerMessage(TRACK_WORK_PROMPT, event(type))).toMatch(
				new RegExp(
					`^Track sent ${type} for the issue ENG-7, "Login fails", in the workspace "acme"\\. It is assigned to you`,
				),
			);
		}
	});

	it("takes a person's comment on an issue assigned to the agent", () => {
		expect(TRACK_WORK_EVENTS).toContain("comment.created");
		expect(assigneeSkip("coder", event("comment.created"))).toBeNull();
	});
});
