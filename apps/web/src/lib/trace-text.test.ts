import { describe, expect, it } from "vitest";
import { edgeCallTitle, MEMBER_GONE } from "./trace-text";

const REVIEWER = "95a8ca61-fe52-4637-9967-acac9bcffc44";
const RUN = "0b6f3c0e-5a55-4a7e-9f0a-3f1f1f6a2c11";

describe("the title of a call over a team's edge", () => {
	it("names the member the runtime recorded, for each kind of edge", () => {
		const to = (edge: "delegate" | "ask" | "report") =>
			edgeCallTitle({ edge, to: "Code reviewer", childRunId: RUN }, []);
		expect(to("delegate")).toEqual({ call: "Delegate to", member: "Code reviewer" });
		expect(to("ask")).toEqual({ call: "Ask", member: "Code reviewer" });
		expect(to("report")).toEqual({ call: "Report to", member: "Code reviewer" });
	});

	it("keeps the name the call was made with, whoever answered", () => {
		// A call to a team is answered by its lead, and the call still went to the team.
		expect(
			edgeCallTitle({ edge: "delegate", to: "Builders", childRunId: RUN }, [
				{ id: RUN, agentName: "Planner" },
			]),
		).toEqual({ call: "Delegate to", member: "Builders" });
	});

	it("names a member recorded by id after the run the call started", () => {
		expect(
			edgeCallTitle({ edge: "delegate", to: REVIEWER, childRunId: RUN }, [
				{ id: "another-run", agentName: "Docs writer" },
				{ id: RUN, agentName: "Code reviewer" },
			]),
		).toEqual({ call: "Delegate to", member: "Code reviewer" });
	});

	it("never shows an id: with no run to name the member, it has no name", () => {
		// The registry refused the call, so it started no run.
		expect(edgeCallTitle({ edge: "delegate", to: REVIEWER, childRunId: null }, [])).toEqual({
			call: "Delegate to",
			member: null,
		});
		// The run it started is not among those the page has.
		expect(
			edgeCallTitle({ edge: "ask", to: REVIEWER.toUpperCase(), childRunId: RUN }, [
				{ id: "another-run", agentName: "Docs writer" },
			]),
		).toEqual({ call: "Ask", member: null });
		expect(MEMBER_GONE).toBe("an agent that is gone");
	});
});
