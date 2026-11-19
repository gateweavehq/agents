import {
	type Agent,
	type AgentDefinition,
	type Asset,
	agentDefinitionInput,
	agentDefinitionUpdate,
} from "@gateweave/agents-model";
import { expect, it } from "vitest";
import { formInput, inputOf } from "#/lib/agent-input";

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
	// Never with a sandbox, so this one is at its default here and away from it below.
	files: false,
	outsideTasks: false,
};

/** An agent that works on its repository's files without a sandbox (AGT-122). */
const onFiles: AgentDefinition = {
	...definition,
	sandbox: false,
	engine: "gateweave",
	files: true,
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
		files: false,
		outsideTasks: false,
	});
	// What the server's validator makes of it is the same: nothing was filled in.
	expect(agentDefinitionUpdate.parse(input)).toEqual(input);
});

it("carries files away from its default, with the repository", () => {
	const input = inputOf(agent, onFiles);
	expect(input).toMatchObject({ files: true, sandbox: false, repositoryId: "r-1" });
	expect(agentDefinitionUpdate.parse(input)).toEqual(input);
});

/** What the form's controls hold when it opens on an agent and nothing is changed. */
const untouched = (shown: AgentDefinition) => {
	const { files: _files, ...whole } = inputOf(agent, shown);
	return whole;
};

it("keeps files and the repository when the form saves an agent that has them", () => {
	// The form has no control for `files`, and shows the repository only beside a sandbox.
	const saved = formInput({ agent, definition: onFiles }, { ...untouched(onFiles), name: "Fixer" });
	expect(saved).toEqual({ ...inputOf(agent, onFiles), name: "Fixer" });
	expect(saved).toMatchObject({ files: true, sandbox: false, repositoryId: "r-1" });
	expect(agentDefinitionUpdate.safeParse(saved).success).toBe(true);
});

it("turns files off when the form gives the agent a sandbox, which keeps the repository", () => {
	const saved = formInput({ agent, definition: onFiles }, { ...untouched(onFiles), sandbox: true });
	expect(saved).toMatchObject({ files: false, sandbox: true, repositoryId: "r-1" });
	expect(agentDefinitionUpdate.safeParse(saved).success).toBe(true);
});

it("sends a repository only with a sandbox or files, and never turns files on", () => {
	// An agent without either: the repository last chosen in the form does not go with it.
	const plain = { ...definition, sandbox: false, engine: "gateweave" as const };
	expect(
		formInput({ agent, definition: plain }, { ...untouched(plain), repositoryId: "r-1" }),
	).toMatchObject({ files: false, sandbox: false, repositoryId: null });
	// An agent with a sandbox is saved as it was.
	expect(formInput({ agent, definition }, untouched(definition))).toEqual(
		inputOf(agent, definition),
	);
	// A new agent has no `files` to keep.
	expect(formInput(null, untouched(definition))).toMatchObject({ files: false, sandbox: true });
	expect(formInput(null, untouched(plain))).toMatchObject({ files: false, repositoryId: null });
});
