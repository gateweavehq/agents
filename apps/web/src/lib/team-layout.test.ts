import { describe, expect, it } from "vitest";
import { layoutTeam, NODE } from "./team-layout";

const member = (id: string) => ({ id, name: id });

describe("layoutTeam", () => {
	it("puts the lead on top and each member below the nearest one that reaches it", () => {
		const layout = layoutTeam(
			["lead", "coder", "tester", "loner", "fixer"].map(member),
			[
				{ from: "lead", to: "coder", kind: "delegate" },
				{ from: "coder", to: "fixer", kind: "delegate" },
				{ from: "lead", to: "tester", kind: "ask" },
				// Back up to the lead, which stays on top.
				{ from: "fixer", to: "lead", kind: "report" },
			],
			"lead",
		);
		const row = (id: string) => layout.members.get(id)?.row;
		expect(["lead", "coder", "tester", "fixer", "loner"].map(row)).toEqual([0, 1, 1, 2, 3]);
		// Rows are centered, the widest one setting the width.
		const lead = layout.members.get("lead");
		const coder = layout.members.get("coder");
		expect(lead?.x).toBe(16 + (2 * NODE.width + 24 - NODE.width) / 2);
		expect(coder?.x).toBe(16);
		expect(layout.width).toBe(2 * 16 + 2 * NODE.width + 24);
		expect(layout.height).toBe(16 + 4 * NODE.height + 3 * 72 + 48);
	});

	it("orders a row by the members that reach it, then by name", () => {
		const layout = layoutTeam(
			["lead", "b", "a", "under-b", "under-a"].map(member),
			[
				{ from: "lead", to: "b", kind: "delegate" },
				{ from: "lead", to: "a", kind: "delegate" },
				{ from: "b", to: "under-b", kind: "delegate" },
				{ from: "a", to: "under-a", kind: "delegate" },
			],
			"lead",
		);
		const x = (id: string) => layout.members.get(id)?.x ?? 0;
		expect(x("a")).toBeLessThan(x("b"));
		expect(x("under-a")).toBeLessThan(x("under-b"));
	});

	it("draws edges down, up and between members of a row, apart when they share two members", () => {
		const layout = layoutTeam(
			["lead", "coder", "tester"].map(member),
			[
				{ from: "lead", to: "coder", kind: "delegate" },
				{ from: "coder", to: "lead", kind: "report" },
				{ from: "lead", to: "tester", kind: "ask" },
				{ from: "coder", to: "tester", kind: "ask" },
			],
			"lead",
		);
		const edge = (from: string, to: string) =>
			layout.edges.find((one) => one.from === from && one.to === to);
		const lead = layout.members.get("lead");
		const coder = layout.members.get("coder");
		if (!lead || !coder) throw new Error("not placed");
		const middle = lead.x + NODE.width / 2;

		// Down from the bottom of the lead's box, and back up from the top of the coder's, 12 apart.
		expect(edge("lead", "coder")?.path).toMatch(
			new RegExp(`^M ${middle - 6},${lead.y + NODE.height} `),
		);
		expect(edge("coder", "lead")?.path).toMatch(
			new RegExp(` ${middle + 6},${lead.y + NODE.height}$`),
		);
		// Within a row, out from the bottom and back.
		expect(edge("coder", "tester")?.path).toMatch(
			new RegExp(
				`^M ${coder.x + NODE.width / 2},${coder.y + NODE.height} C \\S+,${coder.y + NODE.height + 36}`,
			),
		);
		// The arrow's tip is where the edge ends.
		const end = edge("lead", "tester")?.path.split(" ").at(-1);
		expect(edge("lead", "tester")?.arrow.startsWith(`${end} `)).toBe(true);
	});

	it("lays out a team of one", () => {
		const layout = layoutTeam([member("lead")], [], "lead");
		expect(layout.members.get("lead")).toEqual({ x: 16, y: 16, row: 0 });
		expect(layout.edges).toEqual([]);
	});
});
