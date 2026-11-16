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

/**
 * Plain data (strings, numbers, booleans, null, lists and objects of them), as the client
 * serializes it (seroval).
 */
function serialized(data: unknown) {
	let next = 0;
	const node = (value: unknown): unknown => {
		if (typeof value === "string") return { t: 1, s: value };
		if (typeof value === "number") return { t: 0, s: value };
		// seroval's constants: 0 is null, 2 is true, 3 is false.
		if (value === null) return { t: 2, s: 0 };
		if (typeof value === "boolean") return { t: 2, s: value ? 2 : 3 };
		if (Array.isArray(value)) return { t: 9, i: next++, a: value.map(node), o: 0 };
		const object = value as Record<string, unknown>;
		const keys = Object.keys(object);
		return { t: 10, i: next++, p: { k: keys, v: keys.map((key) => node(object[key])) }, o: 0 };
	};
	return { t: node({ data }), f: 127, m: [] };
}

/**
 * A request to one of the app's server functions as the client makes it, with only the headers
 * given beside the ones every such call has: nothing here says which page it comes from. One that
 * reads (`GET`) takes its data in the address, as the client sends it.
 */
export function serverFnRequest(
	origin: string,
	name: string,
	{
		data,
		headers,
		method = "POST",
	}: { data: unknown; headers: Record<string, string>; method?: "GET" | "POST" },
) {
	const payload = JSON.stringify(serialized(data));
	const common = { "x-tsr-serverFn": "true", accept: "application/json", ...headers };
	return method === "GET"
		? new Request(`${serverFnUrl(origin, name)}?payload=${encodeURIComponent(payload)}`, {
				headers: common,
			})
		: new Request(serverFnUrl(origin, name), {
				method: "POST",
				headers: { ...common, "content-type": "application/json" },
				body: payload,
			});
}

/**
 * Calls a server function as the app's own page does, which names the app's origin. A thrown
 * error still answers 200, in the body.
 */
export async function callServerFn(
	agents: Agents,
	origin: string,
	name: string,
	{
		data,
		cookie,
		client,
		method,
	}: { data: Record<string, unknown>; cookie: string; client: string; method?: "GET" | "POST" },
) {
	const response = await agents.fetch(
		serverFnRequest(origin, name, {
			data,
			method,
			headers: { origin, cookie, "cf-connecting-ip": client },
		}),
	);
	const text = await response.text();
	return { response, text, failed: text.includes('"k":["error"]') };
}
