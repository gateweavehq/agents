/**
 * The two small Python programs the sandbox runs for a review's proofs, and how the host reads
 * what they print. Each is a constant: paths, commands and file content reach it as argv or on
 * its standard input, never inside shell or Python source. The sandbox image has `python3`.
 */

import type { CommandResult, WriteResult } from "./sandbox-tools";

/**
 * Creates one file under the repository root, once and without following a symlink. Every parent
 * is opened from the root with `O_DIRECTORY | O_NOFOLLOW` through the descriptor of the one before
 * it, a missing one is made with `os.mkdir(dir_fd=...)`, and the file is created with
 * `O_EXCL | O_NOFOLLOW`. There is no gap between a check and the write for a path to change in.
 * argv: the root, the path below it. Standard input: the file's content.
 */
export const CREATE_FILE_SCRIPT = `
import os, sys
root, relative = sys.argv[1], sys.argv[2]
data = sys.stdin.buffer.read()
def refuse(text):
    sys.stdout.write(text)
    sys.exit(1)
parts = relative.split("/")
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
for index, part in enumerate(parts[:-1]):
    shown = "/".join(parts[: index + 1])
    try:
        try:
            child = os.open(part, flags, dir_fd=fd)
        except FileNotFoundError:
            os.mkdir(part, 0o755, dir_fd=fd)
            child = os.open(part, flags, dir_fd=fd)
    except OSError:
        refuse(shown + " is a symlink or not a directory, or could not be made")
    os.close(fd)
    fd = child
try:
    made = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
except FileExistsError:
    refuse(relative + " already exists")
except OSError as error:
    refuse(relative + " could not be created: " + str(error.strerror))
with os.fdopen(made, "wb") as out:
    out.write(data)
sys.stdout.write("created " + str(len(data)))
`;

/** What `CREATE_FILE_SCRIPT` needs of a sandbox: run python3 with these arguments and this input. */
export type PythonRunner = (
	script: string,
	args: string[],
	input: string,
) => Promise<{ exitCode: number; output: string }>;

/** Creates the proof's file with `CREATE_FILE_SCRIPT`; `relative` is a plain path inside `root`. */
export async function createProofFile(
	python: PythonRunner,
	root: string,
	relative: string,
	content: string,
): Promise<WriteResult> {
	try {
		const { exitCode, output } = await python(CREATE_FILE_SCRIPT, [root, relative], content);
		const made = /^created (\d+)$/.exec(output.trim());
		if (exitCode === 0 && made) return { written: Number(made[1]) };
		const reason = output.trim().split("\n")[0]?.slice(0, 200);
		return { error: reason || "the file could not be created" };
	} catch {
		return { error: "the file could not be created" };
	}
}

/**
 * Runs a proof's command in a session of its own and keeps it to its deadline. argv: the seconds
 * it may take in all, the command, a nonce. It ends the command's whole process group, first
 * with SIGTERM and then SIGKILL, when the command returns or runs out of time, so that its own
 * kill and its grace period are over by the deadline. Then it compares the process ids with those
 * from before the command, ignoring zombies, and reports what is still alive. The last line of
 * its output carries the nonce and a JSON verdict.
 */
export const RUN_PROOF_SCRIPT = `
import json, os, signal, subprocess, sys, time
seconds, command, nonce = float(sys.argv[1]), sys.argv[2], sys.argv[3]
deadline = time.monotonic() + seconds
grace = min(1.5, seconds / 3)
me = os.getpid()
def alive():
    found = set()
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open("/proc/" + name + "/stat") as stat:
                text = stat.read()
        except OSError:
            continue
        if text[text.rindex(")") + 2] != "Z":
            found.add(int(name))
    return found
def end(group, number):
    try:
        os.killpg(group, number)
    except ProcessLookupError:
        pass
def wait(child, until):
    try:
        return child.wait(timeout=max(0.0, until - time.monotonic()))
    except subprocess.TimeoutExpired:
        return None
before = alive()
child = subprocess.Popen(["bash", "-c", command], start_new_session=True, stdin=subprocess.DEVNULL)
code = wait(child, deadline - 2 * grace)
timed_out = code is None
if timed_out:
    end(child.pid, signal.SIGTERM)
    code = wait(child, deadline - grace)
end(child.pid, signal.SIGKILL)
if code is None:
    code = wait(child, deadline - grace / 2)
left = set()
settle = min(deadline, time.monotonic() + 1.0)
while True:
    left = alive() - before - {me}
    if not left or time.monotonic() >= settle:
        break
    time.sleep(0.05)
if code is None:
    code = -signal.SIGKILL
sys.stdout.write("\\n" + nonce + " " + json.dumps({
    "exitCode": 128 - code if code < 0 else code,
    "timedOut": timed_out,
    "left": len(left),
}) + "\\n")
sys.stdout.flush()
`;

/** A proof's command result, and how many processes it left running (null: not confirmed). */
export interface ProofRun extends CommandResult {
	left: number | null;
}

/** Reads the verdict `RUN_PROOF_SCRIPT` printed last, or says why there is none. */
export function readProofRun(nonce: string, output: string, exitCode: number): ProofRun {
	const at = output.lastIndexOf(`\n${nonce} `);
	if (at !== -1) {
		try {
			const verdict: unknown = JSON.parse(output.slice(at + nonce.length + 2));
			if (typeof verdict === "object" && verdict !== null) {
				const { exitCode: code, timedOut, left } = verdict as Record<string, unknown>;
				if (typeof code === "number" && typeof timedOut === "boolean" && typeof left === "number")
					return { exitCode: code, output: output.slice(0, at), timedOut, left };
			}
		} catch {
			// Treated as no verdict.
		}
	}
	// python3 itself did not run (126, 127), or the supervisor ended before it could report.
	const notStarted = exitCode === 126 || exitCode === 127;
	return { exitCode, output, timedOut: false, notStarted, left: notStarted ? 0 : null };
}
