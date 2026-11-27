// The two model families the gate can use, and how each one's command line is run. A reviewer and
// a judge of one family would grade their own habits, so the families are fixed here and the
// script refuses to pair them.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENGINES = {
	codex: { family: "openai" },
	openai: { family: "openai", runs: "codex" },
	claude: { family: "anthropic" },
	anthropic: { family: "anthropic", runs: "claude" },
};

/** `codex:gpt-x` is an engine and a model. The engine fixes the family. */
export function parseEngine(spec, flag) {
	const match = /^([a-z]+):(\S+)$/.exec(spec ?? "");
	const known = match ? ENGINES[match[1]] : undefined;
	if (!match || !known) {
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

/** Runs a command with the prompt on stdin. Resolves to its stdout, rejects on a non-zero exit. */
export function runCommand(command, args, { cwd, input, timeoutMs }) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			// codex and claude are .cmd shims on Windows, which only a shell starts.
			shell: process.platform === "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve(out);
			else reject(new Error(`${command} exited ${code ?? signal}: ${err.trim().slice(-500)}`));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

const TIMEOUT_MS = 20 * 60 * 1000;

/** Asks one model for a reply to `prompt`, working in `cwd`, and returns the reply's text. */
export async function ask(engine, prompt, cwd) {
	if (engine.engine === "codex") {
		const dir = await mkdtemp(join(tmpdir(), "replay-reply-"));
		const file = join(dir, "reply.txt");
		try {
			await runCommand(
				"codex",
				["exec", "-s", "read-only", "--ephemeral", "-m", engine.model, "-o", file, "-"],
				{ cwd, input: prompt, timeoutMs: TIMEOUT_MS },
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
		{ cwd, input: prompt, timeoutMs: TIMEOUT_MS },
	);
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
