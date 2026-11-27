// How a command line is started: found on PATH, with its arguments kept as they are. On Windows
// `codex` and `claude` may be .exe files or .cmd shims; a shell string would split an argument at
// a space, so nothing here goes through one.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";

/** An environment variable by name, ignoring case on Windows, where the names are. */
export function envGet(env, name, platform = process.platform) {
	if (platform !== "win32") return env[name];
	const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
	return key === undefined ? undefined : env[key];
}

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

/** The file `name` runs as on PATH. A .exe or .com wins over a .cmd shim in the same folder. */
export function resolveExecutable(name, env = process.env, platform = process.platform) {
	const win = platform === "win32";
	if (isAbsolute(name) || /[\\/]/.test(name)) return name;
	// Only absolute entries: a relative one would be read against whatever folder is current.
	const dirs = (envGet(env, "PATH", platform) ?? "").split(delimiter).filter(isAbsolute);
	const extensions = win
		? (envGet(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
				.split(";")
				.filter(Boolean)
				.map((ext) => ext.toLowerCase())
				.sort((a, b) => Number(/^\.(bat|cmd)$/.test(a)) - Number(/^\.(bat|cmd)$/.test(b)))
		: [""];
	for (const dir of dirs) {
		for (const ext of extensions) {
			const file = join(dir, `${name}${ext}`);
			if (!isFile(file)) continue;
			if (!win) {
				try {
					accessSync(file, constants.X_OK);
				} catch {
					continue;
				}
			}
			return resolvePath(file);
		}
	}
	throw new Error(`${name} was not found on PATH`);
}

const needsShell = (file, platform) => platform === "win32" && /\.(cmd|bat)$/i.test(file);

/** Characters cmd.exe expands even inside quotes, or that end the quoted string. */
const UNQUOTABLE = /["%\0\r\n]/;

const quoteForCmd = (arg) => {
	if (UNQUOTABLE.test(arg)) throw new Error(`An argument cannot be passed to a .cmd shim: ${arg}`);
	// A backslash before the closing quote would escape it.
	return `"${arg.replace(/(\\+)$/, "$1$1")}"`;
};

/**
 * What to hand to `spawn` so the arguments reach the program as given. A .cmd or .bat shim has to
 * run through cmd.exe, which is given one verbatim command line with every argument quoted.
 */
export function commandLine(file, args, platform = process.platform, env = process.env) {
	if (!needsShell(file, platform)) return { file, args, options: {} };
	const line = [file, ...args].map(quoteForCmd).join(" ");
	return {
		file: envGet(env, "ComSpec", platform) ?? "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		options: { windowsVerbatimArguments: true },
	};
}

// What is running right now, so that an interrupt of the replay can end it: a model process is
// detached into a group of its own on POSIX, which a Ctrl-C at the terminal does not reach.
const running = new Set();
let stopping = false;

/** Registers a way to end something that runs; returns the call that forgets it again. */
export function trackKill(kill) {
	running.add(kill);
	return () => running.delete(kill);
}

/** Ends every command that runs, and refuses to start another. Used when the replay is interrupted. */
export function terminateAll() {
	stopping = true;
	for (const kill of [...running]) {
		try {
			kill();
		} catch {}
	}
}

/** Lets commands start again (a new run in the same process, a test). */
export function resumeStarting() {
	stopping = false;
}

/**
 * Runs a command with `input` on stdin and resolves to its stdout. Rejects on a non-zero exit or
 * when `timeoutMs` passes. A timeout kills the whole process tree (a process group on POSIX,
 * taskkill /T on Windows) and rejects within `killGraceMs` even if a descendant that outlived the
 * kill keeps the output pipes open, so the caller always gets to clean up.
 */
export function runCommand(
	command,
	args,
	{
		cwd,
		input,
		timeoutMs = 10 * 60 * 1000,
		killGraceMs = 5000,
		env = process.env,
		platform = process.platform,
	},
) {
	return new Promise((resolve, reject) => {
		if (stopping) {
			reject(new Error(`${command} was not started: the replay was interrupted`));
			return;
		}
		let line;
		try {
			line = commandLine(resolveExecutable(command, env, platform), args, platform, env);
		} catch (error) {
			reject(error);
			return;
		}
		const win = platform === "win32";
		const child = spawn(line.file, line.args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			// Its own process group, so a timeout can signal the descendants too.
			detached: !win,
			...line.options,
		});
		// A stream decoder keeps a character that arrives in two chunks whole.
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let out = "";
		let err = "";
		let timedOut = false;
		let settled = false;
		let giveUp;
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			running.delete(killTree);
			clearTimeout(timer);
			clearTimeout(giveUp);
			fn(value);
		};
		const killTree = () => {
			if (win) {
				if (!child.pid) return child.kill();
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
					.on("error", () => child.kill())
					.on("exit", (code) => {
						if (code !== 0) child.kill();
					});
				return;
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		running.add(killTree);
		const failure = () =>
			new Error(`${command} timed out after ${timeoutMs} ms: ${err.trim().slice(-500)}`);
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
			// The pipes may stay open if something outlived the kill: stop waiting for them.
			giveUp = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				settle(reject, failure());
			}, killGraceMs);
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", (error) => settle(reject, error));
		child.on("close", (code, signal) => {
			if (code === 0 && !timedOut) settle(resolve, out);
			else {
				settle(
					reject,
					timedOut
						? failure()
						: new Error(`${command} exited ${code ?? signal}: ${err.trim().slice(-500)}`),
				);
			}
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}
