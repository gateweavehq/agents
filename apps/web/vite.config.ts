import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Settings Agents runs without (see src/server/env.d.ts). `secrets.required` in wrangler.jsonc
 * stops a deploy that lacks BETTER_AUTH_SECRET, but in local dev it also drops every other key
 * from .dev.vars. So in dev, these are added to the list when .dev.vars sets them.
 */
const OPTIONAL_SECRETS = [
	"BETTER_AUTH_URL",
	"GITHUB_CLIENT_ID",
	"GITHUB_CLIENT_SECRET",
	"EMAIL_FROM",
];

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	plugins: [
		devtools(),
		cloudflare({
			// At the repository root, for the "Deploy to Cloudflare" button (see wrangler.jsonc).
			configPath: "../../wrangler.jsonc",
			viteEnvironment: { name: "ssr" },
			config: (config) => {
				if (command !== "serve") return;
				const set = devVarsKeys();
				const optional = OPTIONAL_SECRETS.filter((key) => set.has(key));
				return { secrets: { required: [...(config.secrets?.required ?? []), ...optional] } };
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		rootDeployConfig(),
	],
}));

/**
 * Wrangler finds the build output through .wrangler/deploy/config.json, which the Cloudflare
 * plugin writes next to this file. Workers Builds runs the commands people do not write, like
 * `npx wrangler preview` for a branch, from the repository root, so that needs a copy too.
 */
function rootDeployConfig(): Plugin {
	return {
		name: "agents:root-deploy-config",
		apply: "build",
		applyToEnvironment: (environment) => environment.name === "ssr",
		writeBundle: {
			order: "post",
			sequential: true,
			handler() {
				const from = join(this.environment.config.root, ".wrangler", "deploy");
				const to = fileURLToPath(new URL("../../.wrangler/deploy", import.meta.url));
				const rebase = (path: string) => relative(to, resolve(from, path));
				const config = JSON.parse(readFileSync(join(from, "config.json"), "utf8"));
				config.configPath = rebase(config.configPath);
				if (config.prerenderWorkerConfigPath) {
					config.prerenderWorkerConfigPath = rebase(config.prerenderWorkerConfigPath);
				}
				config.auxiliaryWorkers = config.auxiliaryWorkers.map((worker: { configPath: string }) => ({
					configPath: rebase(worker.configPath),
				}));
				mkdirSync(to, { recursive: true });
				writeFileSync(join(to, "config.json"), JSON.stringify(config));
			},
		},
	};
}

/** The names (never the values) of the keys .dev.vars sets to something. */
function devVarsKeys(): Set<string> {
	try {
		const text = readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8");
		return new Set(
			[...text.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*\S/gm)].map((match) => match[1] ?? ""),
		);
	} catch {
		return new Set();
	}
}
