import {
	type Agent,
	type AgentDefinition,
	type Asset,
	agentDefinitionInput,
} from "@gateweave/agents-model";
import { expect, it } from "vitest";
import { inputOf } from "#/lib/agent-input";

const asset = (id: string, kind: Asset["kind"], version: number): Asset => ({
	id,
	repositoryId: null,
	kind,
	key: id,
	name: id,
	description: null,
	path: null,
	metadata: {},
	version,
	hash: id,
	createdAt: 1,
	updatedAt: 1,
});

const agent: Agent = {
	id: "a-1",
	repositoryId: null,
	runtime: "gateweave",
	key: "a-1",
	name: "Coder",
	description: "Writes the code.",
	model: "claude-sonnet-5-5",
	path: null,
	metadata: {},
	assetIds: ["rules", "production", "tracker"],
	createdAt: 1,
	updatedAt: 1,
};

/** An agent with nothing at its default: what a save must hand back unchanged. */
const definition: AgentDefinition = {
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	instructions: { asset: asset("rules", "instructions", 3), version: 2, removed: false },
	environment: { asset: asset("production", "env-set", 4), version: 4, removed: false },
	mcpServers: [
		{
			asset: asset("tracker", "mcp-server", 2),
			version: 1,
			removed: false,
			connection: { transport: "http", url: "https://tracker.example/mcp" },
			variables: [],
			tools: ["search_issues"],
		},
	],
	sandbox: true,
	repository: { id: "r-1", owner: "acme", name: "shop", removed: false },
	engine: "claude-code",
	memory: true,
};

it("carries every field an agent's definition has", () => {
	// A field added to the schema and not to `inputOf` fails here: a save would reset it.
	expect(Object.keys(inputOf(agent, definition)).sort()).toEqual(
		Object.keys(agentDefinitionInput.shape).sort(),
	);
});

it("leaves no field to its default", () => {
	const input = inputOf(agent, definition);
	expect(input).toEqual({
		name: "Coder",
		description: "Writes the code.",
		provider: "anthropic",
		model: "claude-sonnet-5-5",
		instructions: { assetId: "rules", version: 2 },
		environment: { assetId: "production", version: 4 },
		mcpServers: [{ assetId: "tracker", version: 1, tools: ["search_issues"] }],
		sandbox: true,
		repositoryId: "r-1",
		engine: "claude-code",
		memory: true,
	});
	// What the server's validator makes of it is the same: nothing was filled in.
	expect(agentDefinitionInput.parse(input)).toEqual(input);
});
