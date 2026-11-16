// Records what the sandbox's own ripgrep answers, for `../ripgrep-recorded.test.ts`.
//
// It writes a small repository to /workspace/repo, runs the two command lines `sandboxFiles`
// writes (`../../src/sandbox-tools.ts`) through bash in /workspace, as the sandbox does, and
// keeps each one's exit code and output in `recorded.json`, with the files it ran over. Run it
// in the sandbox's image, so that the ripgrep is the one a conversation's commands meet:
//
//   docker build -t gateweave-sandbox sandbox
//   docker run --rm -v "$PWD/packages/runtime/test/ripgrep:/rec" gateweave-sandbox node /rec/record.mjs
//
// Then `pnpm format`, which lays the JSON out as the rest of the repository is. Run it again
// when the image's ripgrep changes, or when a case is added here. The test fails if the command
// lines here are no longer the ones `sandboxFiles` writes.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = "/workspace";

/** A line that holds the word and is `bytes` long, its end not counted. */
function line(bytes, fill = "x") {
	const word = " needle";
	return `${fill.repeat((bytes - word.length) / Buffer.byteLength(fill))}${word}`;
}

/** The files, by path from /workspace. Text only: a JSON file holds them. */
const tree = {
	"repo/README.md": "# Site\n\nA needle in the readme.\n",
	"repo/docs/guide.md": "# Guide\n\nFirst line.\nSecond needle line.\n",
	"repo/docs/api/reference.md": "# Reference\n",
	"repo/src/index.ts": 'export const name = "site";\n',
	"repo/src/util/text.ts": "export function trim(text: string) {\n\treturn text.trim();\n}\n",
	"repo/src/util.ts": "export * from './util/text';\n",
	"repo/src/Big.ts": "// NEEDLE in capitals\n",
	"repo/src/pages/[id].tsx": "export const page = 1;\n",
	"repo/src/pages/index.tsx": "export const index = 1;\n",
	"repo/a-b/x.txt": "x\n",
	"repo/.github/CODEOWNERS": "* @acme/needle-team\n",
	"repo/windows.txt": "one\r\ntwo needle\r\n",
	"repo/marked.txt": "\uFEFFneedle after a mark\n",
	"repo/zero.dat": "a needle\u0000 and a NUL\n",
	// How long a matching line may be before its text is left out: around 500 bytes, counted
	// with and without what ends the line, in bytes and not in characters.
	"repo/lengths/lf.txt": `${line(498)}\n${line(499)}\n${line(500)}\n${line(501)}\n`,
	"repo/lengths/crlf.txt": `${line(497)}\r\n${line(498)}\r\n${line(499)}\r\n${line(500)}\r\n`,
	"repo/lengths/last-499.txt": line(499),
	"repo/lengths/last-500.txt": line(500),
	"repo/lengths/euro.txt": `${line(499, "€")}\n${line(502, "€")}\n${"€".repeat(170)} needle\n`,
};

/** A second repository, for what `.gitignore` does: a tracked file a rule names, and one not. */
const ignoring = {
	"repo/.gitignore": "*.log\nbuild/\n",
	"repo/kept.txt": "a needle\n",
	"repo/debug.log": "a needle in a log\n",
	"repo/build/out.txt": "a needle in a build\n",
};

function quote(word) {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

// The two command lines, as `sandboxFiles` writes them.
function listing(pattern, directory) {
	return `rg --files --hidden --sort path --glob '!.git' --glob ${quote(pattern)} -- ${quote(directory)}`;
}

function searching({ pattern, path, glob, ignoreCase }) {
	return [
		"rg --line-number --no-heading --color never --hidden --max-columns 500 --glob '!.git'",
		ignoreCase ? "--ignore-case" : "",
		glob ? `--glob ${quote(glob)}` : "",
		`-e ${quote(pattern)} -- ${quote(path)}`,
	]
		.filter(Boolean)
		.join(" ");
}

const REPO = `${ROOT}/repo`;

const finds = [
	["*.md", ROOT],
	["*.md", REPO],
	["**/*.ts", `${REPO}/src`],
	["CODE*", ROOT],
	["repo/src/*.ts", ROOT],
	["/repo/src/*.ts", ROOT],
	["src/*.ts", ROOT],
	["src/*.ts", REPO],
	["src/**/*.tsx", REPO],
	["*.ts", `${REPO}/src/util`],
	["util/*.ts", `${REPO}/src`],
	["{index,util}.ts", ROOT],
	["*.{ts,tsx}", ROOT],
	["{README}.md", ROOT],
	["util", ROOT],
	["src", ROOT],
	["repo/src/", ROOT],
	["*.rs", ROOT],
	["*", ROOT],
	["**", `${REPO}/docs`],
	["**/api/**", ROOT],
	["repo/**", ROOT],
	["**/src/**", ROOT],
	["?.txt", ROOT],
	["[ab]*.txt", ROOT],
	["[!x].txt", ROOT],
	["[A-C]*.ts", ROOT],
	["\\[id\\].tsx", ROOT],
	["[id].tsx", ROOT],
	["[[]id].tsx", ROOT],
	["*.TS", ROOT],
	["big.ts", ROOT],
	["it's.md", ROOT],
	["*", `${REPO}/absent`],
	["README.md", `${REPO}/README.md`],
	["*.ts", `${REPO}/README.md`],
];

const searches = [
	{ pattern: "needle", path: ROOT },
	{ pattern: "needle", path: `${REPO}/docs` },
	{ pattern: "needle", path: ROOT, glob: "*.md" },
	{ pattern: "needle", path: ROOT, glob: "*.rs" },
	{ pattern: "haystack", path: ROOT },
	{ pattern: "needle-team", path: ROOT },
	{ pattern: "needle", path: `${REPO}/src` },
	{ pattern: "needle", path: `${REPO}/src`, ignoreCase: true },
	{ pattern: "needle", path: `${REPO}/windows.txt` },
	{ pattern: "needle", path: `${REPO}/marked.txt` },
	{ pattern: "needle", path: `${REPO}/README.md` },
	{ pattern: "needle", path: `${REPO}/README.md`, glob: "*.ts" },
	{ pattern: "needle", path: `${REPO}/lengths` },
	{ pattern: "needle", path: `${REPO}/lengths/lf.txt` },
	{ pattern: "needle", path: `${REPO}/lengths/crlf.txt` },
	{ pattern: "needle", path: `${REPO}/lengths/last-499.txt` },
	{ pattern: "needle", path: `${REPO}/lengths/last-500.txt` },
	{ pattern: "needle", path: `${REPO}/lengths/euro.txt` },
	{ pattern: "needle", path: `${REPO}/zero.dat` },
	{ pattern: "needle", path: `${REPO}/absent` },
	{ pattern: "export", path: ROOT, glob: "*.{ts,tsx}" },
	{ pattern: "Site", path: REPO },
];

function write(files) {
	rmSync(ROOT, { recursive: true, force: true });
	for (const [path, content] of Object.entries(files)) {
		const file = join(ROOT, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	// A checkout is a git repository, which is what makes ripgrep read `.gitignore`.
	execFileSync("git", ["init", "--quiet", REPO]);
}

function run(command) {
	const ran = spawnSync("bash", ["-c", command], { cwd: ROOT, encoding: "utf8" });
	// The sandbox gives a command's stdout and stderr together.
	return { command, exitCode: ran.status, output: `${ran.stdout}${ran.stderr}` };
}

function record(files) {
	write(files);
	return {
		tree: files,
		finds: finds.map(([pattern, directory]) => ({
			pattern,
			directory,
			...run(listing(pattern, directory)),
		})),
		searches: searches.map((query) => ({ query, ...run(searching(query)) })),
	};
}

const recorded = {
	ripgrep: execFileSync("rg", ["--version"], { encoding: "utf8" }).split("\n")[0],
	...record(tree),
	ignoring: (() => {
		write(ignoring);
		return {
			tree: ignoring,
			finds: [{ pattern: "*", directory: ROOT, ...run(listing("*", ROOT)) }],
			searches: [
				{
					query: { pattern: "needle", path: ROOT },
					...run(searching({ pattern: "needle", path: ROOT })),
				},
			],
		};
	})(),
};

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "recorded.json"), `${JSON.stringify(recorded, null, "\t")}\n`);
console.log(
	`${recorded.ripgrep}: ${recorded.finds.length} listings, ${recorded.searches.length} searches`,
);
