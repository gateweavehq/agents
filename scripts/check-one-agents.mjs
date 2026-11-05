// `agents` and the chat agent built on it must resolve once. pnpm makes a copy for each set of peers
// a package sees, and a second copy does not always show as a type error: it can go into the Worker
// with module state of its own. Every package with `agents` depends on its peers to prevent that;
// see `pnpm-workspace.yaml`. `node scripts/check-one-agents.mjs [lockfile]`
import { readFileSync } from "node:fs";

const SINGLE = ["agents", "@cloudflare/ai-chat"];
const file = process.argv[2] ?? "pnpm-lock.yaml";
const lines = readFileSync(file, "utf8").split(/\r?\n/);

/** What a lockfile's key for a package says of its peers, as `name@version` pieces. */
const peersOf = (key) => new Set(key.match(/@?[a-z0-9][\w./-]*@\d[^()]*/gi) ?? []);

const problems = SINGLE.flatMap((name) => {
	const copies = lines
		.filter((line) => line.startsWith(`  ${name}@`) || line.startsWith(`  '${name}@`))
		.filter((line) => line.includes("("));
	if (copies.length <= 1) return [];
	const [first = new Set(), ...others] = copies.map(peersOf);
	const differ = others.flatMap((other) => [
		...[...first].filter((piece) => !other.has(piece)),
		...[...other].filter((piece) => !first.has(piece)),
	]);
	return [
		`${name} resolves to ${copies.length} copies, which differ in: ${[...new Set(differ)].join(", ")}`,
	];
});

if (problems.length > 0) {
	for (const problem of problems) console.error(problem);
	console.error(
		"Give those packages one version in the catalog of pnpm-workspace.yaml, and make every package with agents depend on them.",
	);
	process.exit(1);
}
console.log(`One copy each of ${SINGLE.join(" and ")}.`);
