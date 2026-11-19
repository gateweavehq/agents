import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CheckoutCommand,
	commitEnvironment,
	commitWork,
	disclosureModel,
	pushArguments,
} from "../src/git-work";

const BOT = { name: "Builder", email: "bot@users.noreply.github.com" };
const MODEL = "example/model";
const TRAILER = "Assisted-by: Gateweave Agents:example/model";

let directory: string;
let checkout: string;
let remote: string;

function run(args: string[], env: Record<string, string> = {}, executable = "git") {
	const result = spawnSync(executable, args, {
		cwd: checkout,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: join(directory, "no-global-config"),
			GIT_CONFIG_NOSYSTEM: "1",
			XDG_CONFIG_HOME: directory,
			...env,
		},
	});
	if (result.error) throw result.error;
	return {
		exitCode: result.status ?? 1,
		output: result.stdout + result.stderr,
		timedOut: false,
	};
}

const runCheckout: CheckoutCommand = async ([executable = "git", ...args], _seconds, env) =>
	run(args, env, executable);

function command(...args: string[]): string {
	const result = run(args);
	expect(result.exitCode, result.output).toBe(0);
	return result.output.trim();
}

function stage(file: string) {
	writeFileSync(join(checkout, file), file);
	command("add", file);
}

function authored(file: string) {
	stage(file);
	command("commit", "--quiet", "-m", file);
	return command("rev-parse", "HEAD");
}

function expectMarked(ref = "HEAD", trailer = TRAILER) {
	expect(command("show", "-s", "--format=%(trailers:key=Assisted-by)", ref)).toBe(trailer);
	expect(command("show", "-s", "--format=%an <%ae>%n%cn <%ce>", ref)).toBe(
		"Builder <bot@users.noreply.github.com>\nBuilder <bot@users.noreply.github.com>",
	);
}

function mark(lastPushed: string | null = null, model = MODEL) {
	return commitWork(runCheckout, "main", "Agent work", BOT, model, lastPushed);
}

function hook(name: string, script: string, path = ".git/hooks") {
	const hooks = join(checkout, path);
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(hooks, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "agents-git-work-"));
	checkout = directory;
	remote = join(directory, "remote.git");
	command("init", "--bare", "--initial-branch=main", remote);
	checkout = join(directory, "repo");
	mkdirSync(checkout);
	command("init", "--initial-branch=main");
	command("config", "user.name", "Colleague");
	command("config", "user.email", "colleague@example.com");
	command("config", "core.autocrlf", "false");
	authored("base");
	command("remote", "add", "origin", remote);
	command("push", "--quiet", "origin", "main");
	command("switch", "--quiet", "-c", "agent");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("marking real commits before proposing them", () => {
	it("R8/R15: marks the commit Agents makes with the selected model", async () => {
		stage("agent-file");
		const marked = await mark();
		expect(marked).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked();
	});

	it("R8/R9: marks an engine commit and resets both identities to the bot", async () => {
		const original = authored("engine-file");
		expect(command("show", "-s", "--format=%an", original)).toBe("Colleague");
		const marked = await mark(null, "codex");
		expect(marked).toEqual({ head: command("rev-parse", "HEAD") });
		expect(marked).not.toEqual({ head: original });
		expectMarked("HEAD", "Assisted-by: Gateweave Agents:codex");
	});

	it("R8: marks a merge and keeps both parents", async () => {
		command("switch", "--quiet", "-c", "side");
		authored("side-file");
		command("switch", "--quiet", "agent");
		authored("agent-file");
		command("merge", "--quiet", "--no-ff", "-m", "Merge side", "side");
		const tree = command("rev-parse", "HEAD^{tree}");
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expect(command("rev-parse", "HEAD^{tree}")).toBe(tree);
		expect(command("show", "-s", "--format=%P", "HEAD").split(" ")).toHaveLength(2);
		for (const ref of ["HEAD", "HEAD^1", "HEAD^2"]) expectMarked(ref);
	});

	it("R8: marks a merge and keeps edits made in the merge itself", async () => {
		command("switch", "--quiet", "-c", "side");
		authored("side-file");
		command("switch", "--quiet", "agent");
		authored("agent-file");
		command("merge", "--quiet", "--no-commit", "--no-ff", "side");
		stage("merge-edit");
		command("commit", "--quiet", "-m", "Merge with a manual edit");
		const tree = command("rev-parse", "HEAD^{tree}");
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expect(command("rev-parse", "HEAD^{tree}")).toBe(tree);
		expect(command("show", "-s", "--format=%P", "HEAD").split(" ")).toHaveLength(2);
		for (const ref of ["HEAD", "HEAD^1", "HEAD^2"]) expectMarked(ref);
		expect(command("show", "HEAD:merge-edit")).toBe("merge-edit");
	});

	it("R8: marks a manually resolved conflict and preserves the exact merge tree and parents", async () => {
		command("switch", "--quiet", "-c", "side");
		writeFileSync(join(checkout, "base"), "side\n");
		command("commit", "--quiet", "-am", "Change on side");
		command("switch", "--quiet", "agent");
		writeFileSync(join(checkout, "base"), "agent\n");
		command("commit", "--quiet", "-am", "Change on agent");
		expect(run(["merge", "--no-ff", "side"]).output).toContain("CONFLICT");
		writeFileSync(join(checkout, "base"), "manual resolution\n");
		command("add", "base");
		command("commit", "--quiet", "-m", "Resolve conflicting edits");
		const trees = ["HEAD", "HEAD^1", "HEAD^2"].map((ref) => command("rev-parse", `${ref}^{tree}`));
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		for (const [index, ref] of ["HEAD", "HEAD^1", "HEAD^2"].entries()) {
			expectMarked(ref);
			expect(command("rev-parse", `${ref}^{tree}`)).toBe(trees[index]);
		}
		expect(command("show", "-s", "--format=%P", "HEAD").split(" ")).toHaveLength(2);
	});

	it("R8: fetches main and keeps a merged colleague's published hash and author", async () => {
		const pushed = authored("agent-file");
		command("push", "--quiet", "origin", "agent");
		authored("later-work");
		command("switch", "--quiet", "main");
		const colleague = authored("colleague-file");
		command("push", "--quiet", "origin", "main");
		command("switch", "--quiet", "agent");
		command("merge", "--quiet", "--no-ff", "-m", "Merge main", "origin/main");
		// Simulate a merge from an independently fetched ref while origin/main is stale.
		command("update-ref", "refs/remotes/origin/main", command("rev-parse", `${colleague}^`));
		expect(await mark(pushed)).toEqual({ head: command("rev-parse", "HEAD") });
		expect(command("rev-parse", "origin/main")).toBe(colleague);
		expect(command("rev-parse", "HEAD^2")).toBe(colleague);
		expect(command("show", "-s", "--format=%an <%ae>", "HEAD^2")).toBe(
			"Colleague <colleague@example.com>",
		);
		expectMarked();
		expectMarked("HEAD^1");
	});

	it("R8: marks work with cached refs when the default branch fetch cannot reach the remote", async () => {
		const colleague = authored("colleague-file");
		command("update-ref", "refs/remotes/origin/colleague", colleague);
		authored("engine-file");
		command("remote", "set-url", "origin", join(directory, "unavailable.git"));
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked();
		expect(command("rev-parse", "HEAD^")).toBe(colleague);
		expect(command("show", "-s", "--format=%an", "HEAD^")).toBe("Colleague");
	});

	it("R8: makes the last pushed head an ancestor and leaves it untouched", async () => {
		const pushed = authored("earlier-work");
		command("push", "--quiet", "origin", "agent");
		command("update-ref", "-d", "refs/remotes/origin/agent");
		authored("later-work");
		expect(await mark(pushed)).toEqual({ head: command("rev-parse", "HEAD") });
		expect(command("rev-parse", "HEAD^")).toBe(pushed);
		expect(command("show", "-s", "--format=%an", pushed)).toBe("Colleague");
		expect(command("show", "-s", "--format=%(trailers)", pushed)).toBe("");
		expectMarked();
	});

	it("R8: runs the original commit-msg hook and bypasses it while marking", async () => {
		hook("commit-msg", 'if grep -q Assisted-by "$1"; then exit 1; fi\ntouch .git/commit-msg-ran');
		stage("agent-file");
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked();
		expect(command("status", "--porcelain")).toBe("");
		expect(existsSync(join(checkout, ".git", "commit-msg-ran"))).toBe(true);
	});

	it("R8: leaves an already marked commit unchanged on a second call", async () => {
		stage("engine-file");
		const committed = run(["commit", "-m", `Original\n\n${TRAILER}`], {
			...commitEnvironment(BOT),
			GIT_COMMITTER_DATE: "2025-01-01T12:00:00Z",
		});
		expect(committed.exitCode, committed.output).toBe(0);
		const original = command("rev-parse", "HEAD");
		const first = await mark();
		expect(first).toEqual({ head: original });
		expect(await mark()).toEqual(first);
		expect(await mark(original, "other-model")).toEqual(first);
		expectMarked();
		expect(await mark(null, "other-model")).toEqual({ head: command("rev-parse", "HEAD") });
		expect(command("rev-parse", "HEAD")).not.toBe(original);
		expectMarked("HEAD", `${TRAILER}\nAssisted-by: Gateweave Agents:other-model`);
	});

	it("R8: updates a marked child when its parent is rewritten", async () => {
		const parent = authored("engine-file");
		stage("child-file");
		const committed = run(["commit", "-m", `Child\n\n${TRAILER}`], commitEnvironment(BOT));
		expect(committed.exitCode, committed.output).toBe(0);
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expect(command("rev-parse", "HEAD^")).not.toBe(parent);
		expectMarked();
		expectMarked("HEAD^");
	});

	it.each(["Other Tool:model", "Gateweave Agents:example/model"])(
		"R8/R9: keeps the Assisted-by trailer %s and uses the bot identities",
		async (value) => {
			stage("engine-file");
			const other = `Assisted-by: ${value}`;
			command("commit", "--quiet", "-m", `Subject\n\nDetails\n\n${other}`);
			const trailers = other === TRAILER ? TRAILER : `${other}\n${TRAILER}`;
			expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
			expectMarked("HEAD", trailers);
			expect(command("show", "-s", "--format=%B", "HEAD")).toBe(
				`Subject\n\nDetails\n\n${trailers}`,
			);
		},
	);

	it("R8: adds the exact trailer when the existing trailer key is lowercase", async () => {
		stage("engine-file");
		const lowercase = TRAILER.replace("Assisted-by", "assisted-by");
		const committed = run(["commit", "-m", `Original\n\n${lowercase}`], commitEnvironment(BOT));
		expect(committed.exitCode, committed.output).toBe(0);
		const marked = await mark();
		expect(marked).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked("HEAD", `${lowercase}\n${TRAILER}`);
		expect(await mark()).toEqual(marked);
	});

	it.each([
		"prepare-commit-msg",
		"post-commit",
		"pre-rebase",
		"post-checkout",
		"post-rewrite",
		"reference-transaction",
	])("R8: marks and pushes through core.hooksPath with a failing %s hook", async (name) => {
		authored("engine-file");
		command("config", "core.hooksPath", ".git/custom-hooks");
		const fail = "touch .git/hook-ran\nexit 1";
		// The refresh can update a remote ref. Only observe transactions touching the agent branch.
		const script =
			name === "reference-transaction" ? `grep -q ' refs/heads/agent$' || exit 0\n${fail}` : fail;
		hook(name, script, ".git/custom-hooks");
		const head = await mark();
		const id = command("rev-parse", "HEAD");
		expect(head).toEqual({ head: id });
		expectMarked();
		expect(existsSync(join(checkout, ".git", "hook-ran"))).toBe(false);
		command(...pushArguments("agent", id));
		expect(command("rev-parse", "origin/agent")).toBe(id);
	});

	it("R8: marks an existing commit when the repository requires GPG signing", async () => {
		authored("engine-file");
		command("config", "commit.gpgsign", "true");
		command("config", "gpg.program", "missing-gpg-command");
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked();
	});

	it("R8: reports a marking failure when the branch is locked and keeps the original head", async () => {
		const original = authored("engine-file");
		writeFileSync(join(checkout, ".git", "refs", "heads", "agent.lock"), "");
		expect(await mark()).toEqual({
			error: expect.stringMatching(
				/The work's commits could not be marked as written by an agent\.\s[\s\S]*cannot lock ref/,
			),
		});
		expect(command("rev-parse", "HEAD")).toBe(original);
		expect(command("branch", "--show-current")).toBe("agent");
	});

	it("R8: marks the commit and leaves a file a hook made where it was", async () => {
		hook("post-commit", "echo generated > generated.txt");
		stage("agent-file");
		expect(await mark()).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked();
		expect(command("status", "--porcelain")).toBe("?? generated.txt");
	});

	it("R8: puts the trailer at the end of a message with a --- line, once", async () => {
		stage("engine-file");
		command("commit", "--quiet", "-m", "Subject\n\nBody\n---\nAfter the line");
		const marked = await mark();
		expect(marked).toEqual({ head: command("rev-parse", "HEAD") });
		expectMarked();
		expect(command("show", "-s", "--format=%B", "HEAD")).toBe(
			`Subject\n\nBody\n---\nAfter the line\n\n${TRAILER}`,
		);
		expect(await mark()).toEqual(marked);
	});

	it("R8: marks several commits in a row and keeps their order and trees", async () => {
		const first = authored("first");
		const second = authored("second");
		const third = authored("third");
		const marked = await mark();
		expect(marked).toEqual({ head: command("rev-parse", "HEAD") });
		for (const ref of ["HEAD", "HEAD^", "HEAD^^"]) expectMarked(ref);
		expect(command("rev-list", "--count", "HEAD")).toBe("4");
		expect(command("show", "-s", "--format=%s", "HEAD~3")).toBe("base");
		for (const [ref, original] of [
			["HEAD", third],
			["HEAD^", second],
			["HEAD^^", first],
		]) {
			expect(command("rev-parse", `${ref}^{tree}`)).toBe(
				command("rev-parse", `${original}^{tree}`),
			);
		}
	});

	it("R8: refuses to overwrite a commit made concurrently", async () => {
		authored("engine-file");
		let concurrent = "";
		const racing: CheckoutCommand = (args, seconds, env) => {
			if (args[0] === "bash") {
				command("commit", "--allow-empty", "-m", "Concurrent commit");
				concurrent = command("rev-parse", "HEAD");
			}
			return runCheckout(args, seconds, env);
		};
		expect(await commitWork(racing, "main", "Agent work", BOT, MODEL)).toEqual({
			error: expect.stringContaining("cannot lock ref"),
		});
		expect(command("rev-parse", "HEAD")).toBe(concurrent);
	});

	it("R8/R9: strips model controls and uses the engine for empty model IDs", async () => {
		authored("engine-file");
		expect(await mark(null, "example/\u202emodel\r\n\u2028\u2029")).toEqual({
			head: command("rev-parse", "HEAD"),
		});
		expectMarked();
		expect(disclosureModel("", "claude-code")).toBe("claude-code");
		expect(disclosureModel("\u202e\u0000\u2028\u2029", "codex")).toBe("codex");
	});
});
