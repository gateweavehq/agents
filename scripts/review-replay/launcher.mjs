// How a command line is started: found on PATH, with its arguments kept as they are. On Windows
// `codex` and `claude` may be .exe files or .cmd shims; a shell string would split an argument at
// a space, so nothing here goes through one.
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

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
	const dirs = (envGet(env, "PATH", platform) ?? "").split(delimiter).filter(Boolean);
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
			return file;
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

/**
 * Runs a command with `input` on stdin and resolves to its stdout. Rejects on a non-zero exit or
 * when `timeoutMs` passes, and kills the whole process tree then.
 */
export function runCommand(
	command,
	args,
	{ cwd, input, timeoutMs = 10 * 60 * 1000, env = process.env, platform = process.platform },
) {
	return new Promise((resolve, reject) => {
		let line;
		try {
			line = commandLine(resolveExecutable(command, env, platform), args, platform, env);
		} catch (error) {
			reject(error);
			return;
		}
		const child = spawn(line.file, line.args, {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			...line.options,
		});
		let out = "";
		let err = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (platform === "win32" && child.pid) {
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
					"error",
					() => child.kill(),
				);
			} else child.kill();
		}, timeoutMs);
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
			if (code === 0 && !timedOut) resolve(out);
			else
				reject(
					new Error(
						`${command} ${timedOut ? "timed out" : `exited ${code ?? signal}`}: ${err.trim().slice(-500)}`,
					),
				);
		});
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}
