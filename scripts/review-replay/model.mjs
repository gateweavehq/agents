// The product's own review instructions, schema, ranking and bar. The model package is TypeScript
// with extensionless imports, which Node does not load, so it is bundled in memory first.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let loaded;

export function loadModel() {
	loaded ??= (async () => {
		const entry = import.meta.resolve("@gateweave/agents-model");
		const { outputFiles } = await build({
			entryPoints: [fileURLToPath(entry)],
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
