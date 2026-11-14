import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { startAgents } from "./agents-worker";

type Agents = Awaited<ReturnType<typeof startAgents>>;

/**
 * The URL of one of the app's server functions. TanStack Start names them by a hash, which the
 * build's resolver maps to their names.
 */
function serverFnUrl(origin: string, name: string) {
	const assets = join(resolve(import.meta.dirname, ".."), "dist/server/assets");
	const resolver = readdirSync(assets).find((file) =>
		/^__23tanstack-start-server-fn-resolver-.*\.js$/.test(file),
	);
	const source = resolver ? readFileSync(join(assets, resolver), "utf8") : "";
	const id = new RegExp(
		`"([0-9a-f]{64})": \\{\\s*functionName: "${name}_createServerFn_handler"`,
	).exec(source)?.[1];
	if (!id) throw new Error(`No server function ${name} in the build`);
	return `${origin}/_serverFn/${id}`;
}

/** A plain object of strings and objects as the client serializes it (seroval's JSON). */
function serialized(data: Record<string, unknown>) {
	let next = 0;
	const node = (value: unknown): unknown => {
		if (typeof value === "string") return { t: 1, s: value };
		const object = value as Record<string, unknown>;
		const keys = Object.keys(object);
		return { t: 10, i: next++, p: { k: keys, v: keys.map((key) => node(object[key])) }, o: 0 };
	};
	return { t: node({ data }), f: 127, m: [] };
}

/** Calls a server function as the page does. A thrown error still answers 200, in the body. */
export async function callServerFn(
	agents: Agents,
	origin: string,
	name: string,
	{ data, cookie, client }: { data: Record<string, unknown>; cookie: string; client: string },
) {
	const response = await agents.fetch(serverFnUrl(origin, name), {
		method: "POST",
		headers: {
			origin,
			cookie,
			"cf-connecting-ip": client,
			"x-tsr-serverFn": "true",
			accept: "application/json",
			"content-type": "application/json",
		},
		body: JSON.stringify(serialized(data)),
	});
	const text = await response.text();
	return { response, text, failed: text.includes('"k":["error"]') };
}
