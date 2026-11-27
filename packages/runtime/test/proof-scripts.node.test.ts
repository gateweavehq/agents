import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	CREATE_FILE_SCRIPT,
	createProofFile,
	RUN_PROOF_SCRIPT,
	readProofRun,
} from "../src/proof-scripts";

// The programs use /proc, O_DIRECTORY and process groups: they run in the sandbox's Linux image,
// and so do these tests of them. Elsewhere only the host side below runs.
const python = spawnSync("python3", [
	"-I",
	"-c",
	"import os; os.O_DIRECTORY; open('/proc/self/stat')",
]);
const linux = process.platform === "linux" && python.status === 0;

describe("the host side of creating a proof file", () => {
	it("passes the paths as argv and the content on standard input, never in the program", async () => {
		const calls: { script: string; args: string[]; input: string }[] = [];
		const result = await createProofFile(
			async (script, args, input) => {
				calls.push({ script, args, input });
				return { exitCode: 0, output: "created 12" };
			},
			"/workspace/repo",
			"test/it's a $(x).test.ts",
			"body; rm -rf /",
		);
		expect(result).toEqual({ written: 12 });
		expect(calls).toEqual([
			{
				script: CREATE_FILE_SCRIPT,
				args: ["/workspace/repo", "test/it's a $(x).test.ts"],
				input: "body; rm -rf /",
			},
		]);
		expect(CREATE_FILE_SCRIPT).not.toContain("it's a");
		expect(CREATE_FILE_SCRIPT).not.toContain("rm -rf");
	});
	it.each([
		[1, "test/a.test.ts already exists", "test/a.test.ts already exists"],
		[1, "", "the file could not be created"],
		[0, "something else", "something else"],
		[1, "Traceback\nmore", "Traceback"],
	])("answers exit code %i and output %j with an error", async (exitCode, output, error) => {
		expect(await createProofFile(async () => ({ exitCode, output }), "/r", "a", "")).toEqual({
			error,
		});
	});
	it("answers a sandbox that throws with an error", async () => {
		const failing = async () => {
			throw new Error("container gone");
		};
		expect(await createProofFile(failing, "/r", "a", "")).toEqual({
			error: "the file could not be created",
		});
	});
});

describe("reading a proof's verdict", () => {
	const verdict = JSON.stringify({ exitCode: 3, timedOut: false, left: 0 });
	it("takes the last line that carries the nonce", () => {
		expect(readProofRun("n1", `out\nn1 ${verdict}\n`, 0)).toEqual({
			exitCode: 3,
			output: "out",
			timedOut: false,
			left: 0,
		});
	});
	it("does not take a verdict with another nonce", () => {
		const run = readProofRun("n1", `out\nn2 ${verdict}\n`, 0);
		expect(run).toMatchObject({ exitCode: 0, left: null, notStarted: false });
	});
	it("says a survivor count and a timeout", () => {
		const text = `\nn ${JSON.stringify({ exitCode: 143, timedOut: true, left: 2 })}\n`;
		expect(readProofRun("n", text, 0)).toMatchObject({ timedOut: true, left: 2, exitCode: 143 });
	});
	it.each([126, 127])("says python3 did not start for exit code %i", (exitCode) => {
		expect(readProofRun("n", "python3: not found", exitCode)).toMatchObject({
			notStarted: true,
			left: 0,
		});
	});
	it("does not confirm a proof that ended without a verdict", () => {
		expect(readProofRun("n", "Traceback", 1)).toMatchObject({ left: null, notStarted: false });
		expect(readProofRun("n", "\nn {not json}\n", 0)).toMatchObject({ left: null });
		expect(readProofRun("n", `\nn ${JSON.stringify({ exitCode: "1" })}\n`, 0)).toMatchObject({
			left: null,
		});
	});
});

const directories: string[] = [];
function scratch(): string {
	const made = mkdtempSync(join(tmpdir(), "proof-scripts-"));
	directories.push(made);
	return made;
}
afterAll(() => {
	for (const made of directories) rmSync(made, { recursive: true, force: true });
});

function create(root: string, relative: string, content: string) {
	const done = spawnSync("python3", ["-I", "-c", CREATE_FILE_SCRIPT, root, relative], {
		input: content,
	});
	return { status: done.status, output: done.stdout.toString() };
}

describe.skipIf(!linux)("CREATE_FILE_SCRIPT in the sandbox's image", () => {
	it("creates the file and the directories it needs, with the content as given", () => {
		const root = scratch();
		const content = "héllo\n\u{1F600} \\n $(x) '";
		expect(create(root, "test/deep/a.test.ts", content)).toEqual({
			status: 0,
			output: `created ${Buffer.byteLength(content)}`,
		});
		expect(readFileSync(join(root, "test/deep/a.test.ts"), "utf8")).toBe(content);
	});
	it("takes a name with shell characters as it is", () => {
		const root = scratch();
		expect(create(root, "test/it's $(touch pwned).test.ts", "x").status).toBe(0);
		expect(existsSync(join(root, "pwned"))).toBe(false);
		expect(existsSync(join(root, "test/it's $(touch pwned).test.ts"))).toBe(true);
	});
	it("never writes over an existing file", () => {
		const root = scratch();
		mkdirSync(join(root, "test"));
		writeFileSync(join(root, "test/a.test.ts"), "tracked");
		const done = create(root, "test/a.test.ts", "proposed");
		expect(done).toEqual({ status: 1, output: "test/a.test.ts already exists" });
		expect(readFileSync(join(root, "test/a.test.ts"), "utf8")).toBe("tracked");
	});
	it("never writes through a symlink as the file, even a dangling one", () => {
		const root = scratch();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/app.ts"), "tracked application code");
		symlinkSync(join(root, "src/app.ts"), join(root, "helper.js"));
		symlinkSync(join(root, "nowhere"), join(root, "dangling.js"));
		expect(create(root, "helper.js", "proposed").status).toBe(1);
		expect(create(root, "dangling.js", "proposed").status).toBe(1);
		expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe("tracked application code");
		expect(existsSync(join(root, "nowhere"))).toBe(false);
	});
	it("never writes through a symlinked parent, to a folder outside the root or inside it", () => {
		const root = scratch();
		const outside = scratch();
		mkdirSync(join(root, "real"));
		symlinkSync(outside, join(root, "out"));
		symlinkSync(join(root, "real"), join(root, "link"));
		expect(create(root, "out/a.test.ts", "x")).toMatchObject({ status: 1 });
		expect(create(root, "link/a.test.ts", "x")).toMatchObject({ status: 1 });
		expect(create(root, "link/deeper/a.test.ts", "x")).toMatchObject({ status: 1 });
		expect(existsSync(join(outside, "a.test.ts"))).toBe(false);
		expect(existsSync(join(root, "real/a.test.ts"))).toBe(false);
	});
	it("refuses a file in the way of a folder", () => {
		const root = scratch();
		writeFileSync(join(root, "test"), "a file");
		expect(create(root, "test/a.test.ts", "x")).toMatchObject({ status: 1 });
		expect(readFileSync(join(root, "test"), "utf8")).toBe("a file");
	});
});

interface Verdict {
	exitCode: number;
	timedOut: boolean;
	left: number;
	output: string;
	seconds: number;
}

/** Runs a command as the sandbox does: python3 with the program, in the folder `cwd`. */
async function prove(command: string, seconds: number, cwd: string): Promise<Verdict> {
	const nonce = crypto.randomUUID();
	const started = Date.now();
	const child = spawn("python3", ["-I", "-c", RUN_PROOF_SCRIPT, String(seconds), command, nonce], {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	const exitCode = await new Promise<number>((resolve) =>
		child.on("close", (code) => resolve(code ?? -1)),
	);
	const run = readProofRun(nonce, output, exitCode);
	return {
		exitCode: run.exitCode,
		timedOut: run.timedOut,
		left: run.left ?? -1,
		output: run.output,
		seconds: (Date.now() - started) / 1000,
	};
}

function alive(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat[stat.lastIndexOf(")") + 2] !== "Z";
	} catch {
		return false;
	}
}

describe.skipIf(!linux)("RUN_PROOF_SCRIPT in the sandbox's image", () => {
	it("reports the exit code and the output of a command that returns", async () => {
		const cwd = scratch();
		expect(await prove("echo before; echo oops >&2; exit 3", 20, cwd)).toMatchObject({
			exitCode: 3,
			timedOut: false,
			left: 0,
			output: "before\noops\n",
		});
		expect(await prove("true", 20, cwd)).toMatchObject({ exitCode: 0, left: 0 });
	});
	it("runs the command in the folder it is given and takes it as one argument", async () => {
		const cwd = scratch();
		const done = await prove("pwd; echo \"$0\" '$(touch pwned)' | cat", 20, cwd);
		expect(done.output.split("\n")[0]).toBe(cwd);
		expect(existsSync(join(cwd, "pwned"))).toBe(false);
	});
	it("ends a command that never returns by the proof's own deadline, kill-after included", async () => {
		const cwd = scratch();
		const done = await prove("sleep 300", 5, cwd);
		expect(done).toMatchObject({ timedOut: true, left: 0 });
		expect(done.seconds).toBeLessThan(5.5);
	});
	it("ends a command that ignores SIGTERM by the same deadline", async () => {
		const cwd = scratch();
		const pids = join(cwd, "pids");
		const done = await prove(
			`trap '' TERM; (trap '' TERM; echo $BASHPID >> ${pids}; while :; do sleep 0.2; done) & echo $! >> ${pids}; while :; do sleep 0.2; done`,
			6,
			cwd,
		);
		expect(done).toMatchObject({ timedOut: true, left: 0 });
		expect(done.seconds).toBeLessThan(6.5);
		for (const pid of readFileSync(pids, "utf8").split("\n").filter(Boolean))
			expect(alive(Number(pid))).toBe(false);
	});
	it("ends a background process the command left behind, and reports none left", async () => {
		const cwd = scratch();
		const pids = join(cwd, "pids");
		const done = await prove(`sleep 300 & echo $! > ${pids}; exit 1`, 20, cwd);
		expect(done).toMatchObject({ exitCode: 1, timedOut: false, left: 0 });
		expect(alive(Number(readFileSync(pids, "utf8")))).toBe(false);
	});
	it("counts a process that left the session as still alive", async () => {
		const cwd = scratch();
		const pids = join(cwd, "pids");
		const done = await prove(
			`setsid sleep 300 > /dev/null 2>&1 & echo $! > ${pids}; sleep 0.3; exit 1`,
			5,
			cwd,
		);
		const survivor = Number(readFileSync(pids, "utf8"));
		try {
			expect(done.left).toBeGreaterThanOrEqual(1);
			expect(done.seconds).toBeLessThan(5.5);
		} finally {
			try {
				process.kill(survivor, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});
});
