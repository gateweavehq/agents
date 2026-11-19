import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundedSearchOutput, OUTPUT_LIMIT } from "../src/output";
import { type SandboxPort, sandboxFiles } from "../src/sandbox-tools";

describe("Linux ripgrep search output", () => {
	it("counts late matches after a whole-line byte boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "gateweave-search-"));
		try {
			const path = join(directory, "lines.txt");
			writeFileSync(path, Array.from({ length: 4_000 }, (_, i) => `needle é ${i}\n`).join(""));
			const stdout = execFileSync("rg", [
				"--line-number",
				"--no-heading",
				"-e",
				"needle",
				"--",
				path,
			]);
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (let start = 0; start < stdout.length; start += 7) {
						controller.enqueue(stdout.subarray(start, start + 7));
					}
					controller.close();
				},
			});
			const output = await boundedSearchOutput(stream);
			const rows = output.match(/\d+:needle é \d+\n/g) ?? [];
			const omitted = Number(/\[(\d+) more\]\n$/.exec(output)?.[1]);
			expect(rows.length + omitted).toBe(4_000);
			expect(rows[0]).toContain("1:needle é 0");
			expect(output).not.toContain("�");
			expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(OUTPUT_LIMIT);
			const sandbox: SandboxPort = {
				run: async (command, _cwd, _seconds, _capture, mode) => {
					expect(mode).toBe("search");
					const bytes = execFileSync("bash", ["-c", command]);
					return {
						exitCode: 0,
						output: await boundedSearchOutput(
							new ReadableStream({
								start(controller) {
									controller.enqueue(bytes);
									controller.close();
								},
							}),
						),
						timedOut: false,
					};
				},
				readFile: async () => ({ error: "unused" }),
				writeFile: async () => ({ error: "unused" }),
			};
			expect(
				await sandboxFiles(sandbox).search({ pattern: "needle", path, ignoreCase: false }),
			).toEqual({ found: output });
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
