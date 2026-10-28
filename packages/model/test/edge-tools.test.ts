import { expect, it } from "vitest";
import { EDGE_TOOL_NAME_LENGTH, edgeToolName, readEdgeToolName } from "../src";

it("names an edge's tool after its kind and the member, in the letters providers take", () => {
	expect(edgeToolName("delegate", "Coder")).toBe("delegate__Coder");
	expect(edgeToolName("ask", "Code reviewer (senior)")).toBe("ask__Code_reviewer__senior_");
});

it("reads the member back from the names of the team's members", () => {
	const members = ["Coder", "Code reviewer", "Tester"];
	expect(readEdgeToolName("delegate__Coder", members)).toEqual({
		kind: "delegate",
		member: "Coder",
	});
	expect(readEdgeToolName("report__Code_reviewer", members)).toEqual({
		kind: "report",
		member: "Code reviewer",
	});
});

it("reads a numbered name as the namesake's, and a long one cut to length", () => {
	// Two members whose names come out the same: the second by name gets the numbered tool.
	const [first, second] = ["Q/A", "Q&A"].sort((a, b) => a.localeCompare(b));
	expect(readEdgeToolName("ask__Q_A", ["Q/A", "Q&A"])).toEqual({ kind: "ask", member: first });
	expect(readEdgeToolName("ask__Q_A_2", ["Q/A", "Q&A"])).toEqual({ kind: "ask", member: second });
	// A member whose own name ends in a number is no namesake.
	expect(readEdgeToolName("ask__Coder_2", ["Coder", "Coder_2"])).toEqual({
		kind: "ask",
		member: "Coder_2",
	});
	const long = "A".repeat(80);
	const tool = edgeToolName("delegate", long).slice(0, EDGE_TOOL_NAME_LENGTH);
	expect(readEdgeToolName(tool, [long])).toEqual({ kind: "delegate", member: long });
	const numbered = `${tool.slice(0, EDGE_TOOL_NAME_LENGTH - 2)}_2`;
	expect(readEdgeToolName(numbered, [long])).toEqual({ kind: "delegate", member: long });
});

it("keeps the tool's own name for a member no longer in the team, and leaves other tools", () => {
	expect(readEdgeToolName("delegate__Designer", ["Coder"])).toEqual({
		kind: "delegate",
		member: "Designer",
	});
	expect(readEdgeToolName("github__create_issue", ["Coder"])).toBeNull();
	expect(readEdgeToolName("delegate", ["Coder"])).toBeNull();
});
