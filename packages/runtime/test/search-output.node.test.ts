import { describe, expect, it } from "vitest";
import { boundedSearchOutput, OUTPUT_LIMIT } from "../src/output";
import { type SandboxPort, sandboxFiles } from "../src/sandbox-tools";

describe("sandbox search output", () => {
	it("counts late matches after a whole-line byte boundary", async () => {
		const path = "/workspace/repo/lines.txt";
		const rows = Array.from({ length: 4_000 }, (_, i) => `${i + 1}:needle é ${i}\n`);
		const encoder = new TextEncoder();
		const stdout = encoder.encode(rows.join(""));
		const sandbox: SandboxPort = {
			run: async (command, _cwd, _seconds, capture, mode) => {
				expect(command).toContain(`-e 'needle' -- '${path}'`);
				expect(capture).toBe(false);
				expect(mode).toBe("search");
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (let start = 0; start < stdout.length; start += 7) {
							controller.enqueue(stdout.subarray(start, start + 7));
						}
						controller.close();
					},
				});
				return { exitCode: 0, output: await boundedSearchOutput(stream), timedOut: false };
			},
			readFile: async () => ({ error: "unused" }),
			writeFile: async () => ({ error: "unused" }),
		};
		const result = await sandboxFiles(sandbox).search({
			pattern: "needle",
			path,
			ignoreCase: false,
		});
		const output = "found" in result ? (result.found ?? "") : "";
		const shown = output.match(/\d+:needle é \d+\n/g) ?? [];
		const omitted = Number(/\[(\d+) more\]\n$/.exec(output)?.[1]);
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.length + omitted).toBe(rows.length);
		expect(output).toBe(`${rows.slice(0, shown.length).join("")}[${omitted} more]\n`);
		expect(encoder.encode(output).length).toBeLessThanOrEqual(OUTPUT_LIMIT);
	});
});
