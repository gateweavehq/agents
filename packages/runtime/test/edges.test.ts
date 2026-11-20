import type { TurnEdge } from "@gateweave/agents-model";
import { expect, it } from "vitest";
import { edgeTools } from "../src/edges";

import type { RunRecorder } from "../src/trace";

const run = {
	targets: { tainted: true, trusted: new Set(["coder.example"]) },
	edgeStarted: () => "span",
} as unknown as RunRecorder;

const CODER: TurnEdge = {
	kind: "delegate",
	team: "core",
	to: "agent-1",
	name: "Coder",
	description: null,
	lead: null,
};

it("names each call to take by its tool's name, as the chat will know it", async () => {
	const calls: { text: string; call: { toolCallId: string; toolName: string } }[] = [];
	const tools = edgeTools(run, [CODER], async (_edge, text, call) => {
		calls.push({ text, call });
		return "done";
	});
	const tool = tools["delegate__Coder"];
	if (!tool?.execute) throw new Error("there is no delegate__Coder");
	await tool.execute(
		{ task: "Fix https://coder.example" },
		{ toolCallId: "call-1", messages: [], abortSignal: undefined, context: undefined },
	);
	expect(calls).toEqual([
		{
			text: "Fix https://coder.example",
			call: { toolCallId: "call-1", toolName: "delegate__Coder", span: "span" },
		},
	]);
});

it("gives a namesake's call the number its tool's name has", async () => {
	const names: string[] = [];
	const tools = edgeTools(
		run,
		[
			{ ...CODER, to: "agent-1", name: "C o" },
			{ ...CODER, to: "agent-2", name: "C_o" },
		],
		async (_edge, _text, call) => {
			names.push(call.toolName);
			return "done";
		},
	);
	for (const tool of [tools["delegate__C_o"], tools["delegate__C_o_2"]]) {
		if (!tool?.execute) throw new Error("a namesake's tool is missing");
		await tool.execute(
			{ task: "Hi" },
			{ toolCallId: crypto.randomUUID(), messages: [], abortSignal: undefined, context: undefined },
		);
	}
	expect(names).toEqual(["delegate__C_o", "delegate__C_o_2"]);
});
