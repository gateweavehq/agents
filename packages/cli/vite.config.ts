import { defineConfig } from "vite";

// One file for Node with everything bundled in, the workspace packages and the ready-made setups
// alike, so the published package has no dependencies to install.
export default defineConfig({
	build: {
		ssr: "src/main.ts",
		outDir: "dist",
		target: "node22",
		emptyOutDir: true,
		rolldownOptions: {
			output: { entryFileNames: "main.js", banner: "#!/usr/bin/env node" },
		},
	},
	ssr: { noExternal: true },
});
