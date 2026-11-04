import { describe, expect, it } from "vitest";
import { copilot } from "../src/copilot";
import { agentOf, assetOf, expectValid, repo } from "./support";

const TS_RULES = `---
applyTo: "**/*.ts,**/*.tsx"
excludeAgent: "code-review"
---
Use strict TypeScript.
`;

const PROMPT = `---
description: Write a component test
agent: agent
model: GPT-5
tools: ['search', 'edit']
---
Write a test for the selected component.
`;

const REVIEWER = `---
name: Reviewer
description: Reviews pull requests for security
tools: ['read', 'search']
mcp-servers:
  tracker:
    type: http
    url: https://mcp.example.com
    headers:
      Authorization: Bearer agentHeaderSecret
---
You review code.
`;

describe("copilot adapter", () => {
	it("reads repository-wide and path-specific instructions", () => {
		const detection = copilot.detect(
			repo({
				".github/copilot-instructions.md": "Use tabs.\n",
				".github/instructions/frontend/ts.instructions.md": TS_RULES,
				".github/instructions/notes.md": "Not an instructions file.",
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(assetOf(detection, ".github/copilot-instructions.md")).toMatchObject({
			kind: "instructions",
			files: [{ path: "copilot-instructions.md", content: "Use tabs.\n" }],
		});
		expect(assetOf(detection, ".github/instructions/frontend/ts.instructions.md")).toMatchObject({
			kind: "instructions",
			name: "frontend/ts",
			metadata: { applyTo: ["**/*.ts", "**/*.tsx"], excludeAgent: "code-review" },
		});
		expect(detection.assets.map((asset) => asset.key)).not.toContain(
			".github/instructions/notes.md",
		);
		expect(agentOf(detection)).toMatchObject({
			runtime: "copilot",
			name: "GitHub Copilot",
			assets: [
				".github/copilot-instructions.md",
				".github/instructions/frontend/ts.instructions.md",
			],
		});
	});

	it("reads prompt files, custom agents and chat modes", () => {
		const detection = copilot.detect(
			repo({
				".github/prompts/component-test.prompt.md": PROMPT,
				".github/agents/reviewer.agent.md": REVIEWER,
				".github/agents/planner.md": "---\ndescription: Plans work\n---\nPlan first.\n",
				".github/chatmodes/explain.chatmode.md": "---\ndescription: Explains code\n---\nExplain.\n",
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(assetOf(detection, ".github/prompts/component-test.prompt.md")).toMatchObject({
			kind: "prompt",
			name: "component-test",
			description: "Write a component test",
			metadata: { agent: "agent", model: "GPT-5", tools: ["search", "edit"] },
		});
		expect(assetOf(detection, ".github/agents/reviewer.agent.md")).toMatchObject({
			kind: "instructions",
			name: "Reviewer",
			description: "Reviews pull requests for security",
			metadata: { tools: ["read", "search"], mcpServers: ["tracker"] },
		});
		expect(assetOf(detection, ".github/agents/planner.md")).toMatchObject({ name: "planner" });
		expect(assetOf(detection, ".github/chatmodes/explain.chatmode.md")).toMatchObject({
			name: "explain",
			description: "Explains code",
		});
	});

	it("keeps the credentials of a custom agent's MCP servers out", () => {
		const detection = copilot.detect(repo({ ".github/agents/reviewer.agent.md": REVIEWER }));
		expectValid(detection);
		expect(JSON.stringify(detection)).not.toContain("agentHeaderSecret");
		const [file] = assetOf(detection, ".github/agents/reviewer.agent.md").files;
		expect(file?.content).toContain("You review code.");
		expect(file?.content).toContain("https://mcp.example.com");
	});

	it("reads .vscode/mcp.json, whose servers are under `servers`, without secrets", () => {
		const detection = copilot.detect(
			repo({
				".vscode/mcp.json": JSON.stringify({
					inputs: [{ id: "token", type: "promptString", password: true }],
					servers: {
						github: {
							type: "http",
							url: "https://api.githubcopilot.com/mcp",
							headers: { Authorization: "Bearer vscodeHeaderSecret" },
						},
						local: {
							type: "stdio",
							command: "npx",
							args: ["server"],
							env: { KEY: "vscodeEnvSecret" },
						},
					},
				}),
			}),
		);
		expectValid(detection);
		expect(detection.problems).toEqual([]);
		expect(assetOf(detection, ".vscode/mcp.json#github")).toMatchObject({
			kind: "mcp-server",
			metadata: { type: "http", headers: ["Authorization"] },
		});
		expect(assetOf(detection, ".vscode/mcp.json#local")).toMatchObject({
			metadata: { type: "stdio", env: ["KEY"] },
		});
		const text = JSON.stringify(detection);
		expect(text).not.toContain("vscodeHeaderSecret");
		expect(text).not.toContain("vscodeEnvSecret");
	});

	it("reads skills, and other agents' files only once Copilot is there", () => {
		const shared = {
			"AGENTS.md": "Shared instructions.\n",
			"packages/api/AGENTS.md": "API instructions.\n",
			"CLAUDE.md": "Claude's.\n",
			".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Reviews\n---\nReview.\n",
		};
		expect(copilot.detect(repo(shared)).agents).toEqual([]);

		const detection = copilot.detect(
			repo({
				...shared,
				".github/skills/release/SKILL.md":
					"---\nname: release\ndescription: Releases\n---\nShip.\n",
			}),
		);
		expectValid(detection);
		expect(agentOf(detection).assets).toEqual(
			expect.arrayContaining([
				"AGENTS.md",
				"packages/api/AGENTS.md",
				"CLAUDE.md",
				expect.stringContaining(".github/skills/release"),
				expect.stringContaining(".claude/skills/review"),
			]),
		);
	});

	it("reports broken files and skips them", () => {
		const detection = copilot.detect(
			repo({
				".github/copilot-instructions.md": "Fine.\n",
				".vscode/mcp.json": "{ not json",
				".github/prompts/binary.prompt.md": null,
			}),
		);
		expectValid(detection);
		expect(detection.problems.map((problem) => problem.path).sort()).toEqual([
			".github/prompts/binary.prompt.md",
			".vscode/mcp.json",
		]);
		expect(agentOf(detection).assets).toEqual([".github/copilot-instructions.md"]);
	});

	it("wants only Copilot's files and the ones it shares", () => {
		for (const path of [
			".github/copilot-instructions.md",
			".github/instructions/a/b.instructions.md",
			".github/prompts/x.prompt.md",
			".github/agents/x.agent.md",
			".github/chatmodes/x.chatmode.md",
			".github/skills/x/SKILL.md",
			".vscode/mcp.json",
			"docs/AGENTS.md",
			"CLAUDE.md",
		]) {
			expect(copilot.wants(path), path).toBe(true);
		}
		for (const path of [
			".github/workflows/ci.yml",
			".github/instructions/notes.md",
			".github/prompts/x.md",
			".vscode/settings.json",
			"docs/CLAUDE.md",
			"README.md",
		]) {
			expect(copilot.wants(path), path).toBe(false);
		}
	});
});
