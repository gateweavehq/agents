// The two model families the gate can use, and how each one's command line is run. A reviewer and
// a judge of one family would grade their own habits, so the families are fixed here and the
// script refuses to pair them.
//
// The reviewer runs in a boundary of its own (`reviewerLaunch`): an environment that holds only an
// allowlist, a home folder that holds only the engine's login, the engine's own confinement of file
// reads to the replay checkout, and no tool that reaches the network. The judge sees the answers
// anyway and runs as the user does.
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { envGet, runCommand } from "./launcher.mjs";

export { runCommand };

const ENGINES = {
	codex: { family: "openai" },
	openai: { family: "openai", runs: "codex" },
	claude: { family: "anthropic" },
	anthropic: { family: "anthropic", runs: "claude" },
};

// A model name goes onto a command line, and through cmd.exe for a .cmd shim.
const MODEL = /^[\w.:/@+-]+(\[\w+\])?$/;

/** `codex:gpt-x` is an engine and a model. The engine fixes the family. */
export function parseEngine(spec, flag) {
	const match = /^([a-z]+):(\S+)$/.exec(spec ?? "");
	const known = match ? ENGINES[match[1]] : undefined;
	if (!match || !known || !MODEL.test(match[2] ?? "")) {
		throw new Error(`${flag} must be <codex|openai|claude|anthropic>:<model>, got "${spec ?? ""}"`);
	}
	return {
		spec,
		engine: known.runs ?? match[1],
		model: match[2],
		family: known.family,
	};
}

export function checkFamilies(reviewer, judge) {
	if (reviewer.family === judge.family) {
		throw new Error(
			`The judge must be from another model family than the reviewer: both are ${reviewer.family}.`,
		);
	}
}

/**
 * Whether this engine can keep the reviewer's reads inside the replay checkout on this system.
 * Codex restricts reads with a permissions profile, which its Windows sandbox cannot enforce (it
 * needs read access to the whole disk), so there the reviewer must be claude.
 */
export function checkReviewerBoundary(reviewer, platform = process.platform) {
	if (reviewer.engine === "codex" && platform === "win32") {
		throw new Error(
			"A codex reviewer cannot be confined to the replay checkout on Windows. Use --reviewer claude:<model> with --judge codex:<model>, or run on Linux or macOS.",
		);
	}
}

const BASE_ENV = [
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"LANG",
	"LC_ALL",
	"TERM",
	"TZ",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"CLAUDE_CODE_GIT_BASH_PATH",
];
// The only secrets the reviewer's process gets: the login of the engine it runs.
const ENGINE_ENV = {
	codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
	claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
};

/** The reviewer's environment: the allowlist, and a home, temp and config folder inside `home`. */
export function reviewerEnv(engine, host, home, platform = process.platform) {
	const env = {};
	const allowed = new Set([...BASE_ENV, ...(ENGINE_ENV[engine] ?? [])]);
	for (const [key, value] of Object.entries(host)) {
		const name = key.toUpperCase();
		// Windows names ignore case; elsewhere only NAME and name (for the proxy variables) count.
		const spelled = platform === "win32" || key === name || key === name.toLowerCase();
		if (value !== undefined && allowed.has(name) && spelled) env[key] = value;
	}
	Object.assign(env, {
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: join(home, ".config"),
		TMPDIR: join(home, "tmp"),
		TEMP: join(home, "tmp"),
		TMP: join(home, "tmp"),
		CODEX_HOME: join(home, ".codex"),
		CLAUDE_CONFIG_DIR: join(home, ".claude"),
		// No git settings of the user, and nothing to ask for a password.
		GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	});
	return env;
}

const TIMEOUT_MS = 20 * 60 * 1000;

/** The file that holds an engine's login, in the user's own configuration folder. */
function loginOf(engine, host, platform) {
	if (engine === "codex") {
		return {
			from: join(envGet(host, "CODEX_HOME", platform) ?? join(homedir(), ".codex"), "auth.json"),
			dir: ".codex",
			name: "auth.json",
		};
	}
	return {
		from: join(
			envGet(host, "CLAUDE_CONFIG_DIR", platform) ?? join(homedir(), ".claude"),
			".credentials.json",
		),
		dir: ".claude",
		name: ".credentials.json",
	};
}

/** TOML literal strings cannot hold a quote or a line break. */
const tomlPath = (path) => {
	if (/['\r\n]/.test(path))
		throw new Error(`The replay folder cannot be named in a profile: ${path}`);
	return `'${path.replaceAll("\\", "/")}'`;
};

/**
 * The command, arguments and environment that run `engine` as the reviewer in `cwd`. Pure: nothing
 * is started or written. `file` is where codex writes its reply.
 */
export function reviewerLaunch(engine, { cwd, home, file, host = process.env, platform }) {
	const system = platform ?? process.platform;
	checkReviewerBoundary(engine, system);
	const env = reviewerEnv(engine.engine, host, home, system);
	if (engine.engine === "codex") {
		return {
			command: "codex",
			env,
			args: [
				"exec",
				"--ephemeral",
				"-m",
				engine.model,
				"-C",
				cwd,
				"-o",
				file,
				// Reads: the system paths a program needs and the replay checkout, nothing else. No network.
				"-c",
				'default_permissions="replay"',
				"-c",
				`permissions.replay.filesystem={":minimal"="read", ${tomlPath(cwd)}="read"}`,
				"-c",
				"permissions.replay.network.enabled=false",
				"-",
			],
		};
	}
	return {
		command: "claude",
		env,
		args: [
			"-p",
			"--model",
			engine.model,
			"--no-session-persistence",
			// The file tools stay inside the working folder, user settings and MCP servers are ignored,
			// and nothing that runs a command or reaches the network is on.
			"--restricted",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--tools",
			"Read,Grep,Glob",
			"--allowedTools",
			"Read,Grep,Glob",
		],
	};
}

/** Asks one model for a reply to `prompt`, working in `cwd`, and returns the reply's text. */
export async function ask(
	engine,
	prompt,
	cwd,
	{ role = "judge", host = process.env, platform } = {},
) {
	if (role === "reviewer") return askReviewer(engine, prompt, cwd, host, platform);
	if (engine.engine === "codex") {
		const dir = await mkdtemp(join(tmpdir(), "replay-reply-"));
		const file = join(dir, "reply.txt");
		try {
			await runCommand(
				"codex",
				["exec", "-s", "read-only", "--ephemeral", "-m", engine.model, "-o", file, "-"],
				{ cwd, input: prompt, timeoutMs: TIMEOUT_MS, env: host, platform },
			);
			return await readFile(file, "utf8");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
	return runCommand(
		"claude",
		[
			"-p",
			"--model",
			engine.model,
			"--no-session-persistence",
			"--tools",
			"Read,Grep,Glob",
			"--allowedTools",
			"Read,Grep,Glob",
		],
		{ cwd, input: prompt, timeoutMs: TIMEOUT_MS, env: host, platform },
	);
}

async function askReviewer(engine, prompt, cwd, host, platform) {
	const system = platform ?? process.platform;
	checkReviewerBoundary(engine, system);
	// A folder of its own, outside the replay checkout, that holds the login and nothing else.
	const home = await mkdtemp(join(tmpdir(), "replay-home-"));
	try {
		const login = loginOf(engine.engine, host, system);
		await mkdir(join(home, login.dir), { recursive: true });
		await mkdir(join(home, "tmp"), { recursive: true });
		await copyFile(login.from, join(home, login.dir, login.name)).catch((error) => {
			// An API key in the environment is a login too.
			if (error?.code !== "ENOENT") throw error;
		});
		const file = join(home, "tmp", "reply.txt");
		const launch = reviewerLaunch(engine, { cwd, home, file, host, platform: system });
		const out = await runCommand(launch.command, launch.args, {
			cwd,
			input: prompt,
			timeoutMs: TIMEOUT_MS,
			env: launch.env,
			platform: system,
		});
		return engine.engine === "codex" ? await readFile(file, "utf8") : out;
	} finally {
		await rm(home, { recursive: true, force: true, maxRetries: 3 });
	}
}

/** The first JSON object in a reply, however much prose or fencing surrounds it. */
export function jsonIn(text) {
	const start = text.indexOf("{");
	for (
		let end = text.lastIndexOf("}");
		end > start && start >= 0;
		end = text.lastIndexOf("}", end - 1)
	) {
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			// Try a shorter slice: the reply may hold a second brace after the object.
		}
	}
	throw new Error("The reply holds no JSON object");
}
