import { describe, expect, it } from "vitest";
import { compareDrift, type DriftInput } from "../src/drift";
import { textBlobId } from "../src/hash";

const GUIDE = "# Guide\n";
const NEWER = "# Guide\n\nRun the tests.\n";
const EDITED = "# Our guide\n";
const SKILL = ".claude/skills/review/SKILL.md";

const mcp = (servers: Record<string, unknown>) =>
	`${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
const GITHUB = { command: "npx", args: ["-y", "@acme/github-mcp"] };
const OTHER = { command: "other" };

/** A repository's files from their texts, and the lookup for the texts kept by blob id. */
function repository(texts: Record<string, string>) {
	const kept = new Map(Object.values(texts).map((text) => [textBlobId(text), text]));
	return {
		files: new Map(
			Object.entries(texts).map(([path, text]) => [
				path,
				{ blob: textBlobId(text), symlink: false },
			]),
		),
		textOf: (blob: string) => kept.get(blob) ?? null,
	};
}

function compare(
	written: Record<string, string>,
	applied: Record<string, string>,
	now: Pick<DriftInput, "files" | "textOf">,
) {
	return compareDrift({
		written: Object.entries(written).map(([path, content]) => ({ path, content })),
		applied: Object.entries(applied).map(([path, text]) => ({ path, blob: textBlobId(text) })),
		...now,
	});
}

// Paths sort as Git sorts them: ".claude/…" comes before "AGENTS.md".
describe("drift", () => {
	it("is in sync while the repository holds what the setup writes", () => {
		const now = repository({ "AGENTS.md": GUIDE, "README.md": "hi\n" });
		expect(compare({ "AGENTS.md": GUIDE }, { "AGENTS.md": GUIDE }, now)).toEqual({
			state: "in_sync",
			files: [],
		});
	});

	it("is behind when the setup now writes something else, or another file", () => {
		const now = repository({ "AGENTS.md": GUIDE });
		expect(
			compare({ "AGENTS.md": NEWER, [SKILL]: "Look.\n" }, { "AGENTS.md": GUIDE }, now),
		).toEqual({
			state: "behind",
			files: [
				{ path: SKILL, state: "behind" },
				{ path: "AGENTS.md", state: "behind" },
			],
		});
	});

	it("is changed when the repository edited a file, whatever the setup did since", () => {
		const now = repository({ "AGENTS.md": EDITED });
		const changed = { state: "changed", files: [{ path: "AGENTS.md", state: "changed" }] };
		expect(compare({ "AGENTS.md": GUIDE }, { "AGENTS.md": GUIDE }, now)).toEqual(changed);
		expect(compare({ "AGENTS.md": NEWER }, { "AGENTS.md": GUIDE }, now)).toEqual(changed);
	});

	it("is in sync when the repository was edited to what the setup writes now", () => {
		const now = repository({ "AGENTS.md": NEWER });
		expect(compare({ "AGENTS.md": NEWER }, { "AGENTS.md": GUIDE }, now).state).toBe("in_sync");
	});

	it("is missing when a file the setup owned is gone, before anything else", () => {
		const now = repository({ [SKILL]: "Edited.\n" });
		expect(
			compare(
				{ "AGENTS.md": GUIDE, [SKILL]: "Look.\n" },
				{ "AGENTS.md": GUIDE, [SKILL]: "Look.\n" },
				now,
			),
		).toEqual({
			state: "missing",
			files: [
				{ path: SKILL, state: "changed" },
				{ path: "AGENTS.md", state: "missing" },
			],
		});
	});

	it("counts a file the setup owned that became a symlink as changed", () => {
		const now = {
			files: new Map([["AGENTS.md", { blob: textBlobId("README.md"), symlink: true }]]),
			textOf: () => null,
		};
		expect(compare({ "AGENTS.md": GUIDE }, { "AGENTS.md": GUIDE }, now)).toEqual({
			state: "changed",
			files: [{ path: "AGENTS.md", state: "changed" }],
		});
	});

	it("follows only the setup's servers in a shared configuration file", () => {
		const written = { ".mcp.json": mcp({ github: GITHUB }) };
		const merged = mcp({ github: GITHUB, other: OTHER });
		const applied = { ".mcp.json": merged };

		// Someone added or changed another server: nothing the setup wrote moved.
		const added = repository({ ".mcp.json": mcp({ github: GITHUB, other: OTHER, more: OTHER }) });
		expect(compare(written, applied, added).state).toBe("in_sync");

		const removed = repository({ ".mcp.json": mcp({ other: OTHER }) });
		expect(compare(written, applied, removed).state).toBe("changed");

		const untouched = repository({ ".mcp.json": merged });
		const newer = {
			".mcp.json": mcp({ github: { ...GITHUB, args: ["-y", "@acme/github-mcp@2"] } }),
		};
		expect(compare(newer, applied, untouched).state).toBe("behind");

		const broken = repository({ ".mcp.json": "{ not json" });
		expect(compare(written, applied, broken).state).toBe("changed");
	});

	it("does not call a shared file changed when only its text was not kept", () => {
		const merged = mcp({ github: GITHUB, other: OTHER });
		const { files } = repository({ ".mcp.json": merged });
		const now = { files, textOf: () => null };
		expect(compare({ ".mcp.json": mcp({ github: GITHUB }) }, { ".mcp.json": merged }, now)).toEqual(
			{
				state: "in_sync",
				files: [],
			},
		);
	});
});
