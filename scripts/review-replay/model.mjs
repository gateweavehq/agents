// The product's own review instructions, schema, ranking and bar, and the diff reader that decides
// whether a finding sits on the diff. The packages are TypeScript with extensionless imports,
// which Node does not load, so they are bundled in memory first.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let loaded;

export function loadModel() {
	loaded ??= (async () => {
		const entry = fileURLToPath(import.meta.resolve("@gateweave/agents-model"));
		const reviewGit = fileURLToPath(
			new URL("../../packages/runtime/src/review-git.ts", import.meta.url),
		);
		const from = (path) => JSON.stringify(path.replaceAll("\\", "/"));
		const { outputFiles } = await build({
			stdin: {
				contents: `
					import { z } from "zod";
					import { reviewInput } from ${from(entry)};
					export * from ${from(entry)};
					export { lineOnDiff, parseDiff } from ${from(reviewGit)};
					// What the submit_review tool takes, as a JSON Schema, from the schema the tool validates with.
					export const reviewJsonSchema = z.toJSONSchema(reviewInput, { io: "input" });
				`,
				resolveDir: dirname(entry),
				sourcefile: "replay-model.ts",
				loader: "ts",
			},
			bundle: true,
			write: false,
			format: "esm",
			platform: "node",
			target: "node22",
			logLevel: "silent",
		});
		const code = outputFiles[0]?.text ?? "";
		return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	})();
	return loaded;
}
