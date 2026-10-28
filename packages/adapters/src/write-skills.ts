/**
 * Skills. Docs, checked 2026-10-28:
 * - https://code.claude.com/docs/en/skills (`.claude/skills/<name>/SKILL.md`)
 * - https://learn.chatgpt.com/docs/build-skills (Codex scans `.agents/skills` from the working
 *   directory up to the repository root)
 * - https://geminicli.com/docs/cli/skills/ (workspace skills in `.gemini/skills` or its alias
 *   `.agents/skills`)
 * - https://cursor.com/docs/skills (`.cursor/skills`, `.agents/skills`, `.claude/skills`)
 *
 * A skill is a folder, the same for every agent. Claude Code gets `.claude/skills`; Codex, Gemini
 * CLI and Cursor all read `.agents/skills`, so that one copy serves them (Cursor would read
 * `.claude/skills` too, but a second copy for it alone would only drift).
 */
import type { RepositoryRuntime } from "@gateweave/agents-model";
import { canonicalJson } from "./redaction";
import { compare, isEnvFile } from "./util";
import type { AssetToWrite } from "./write";
import { isSafePath, type Output } from "./write-output";

const CLAUDE_ROOT = ".claude/skills";
const SHARED_ROOT = ".agents/skills";
/** A folder name, which is also what the agents show as the skill's name. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function writeSkills(
	assets: readonly AssetToWrite[],
	targets: ReadonlySet<RepositoryRuntime>,
	output: Output,
): void {
	const roots: string[] = [];
	if (targets.has("claude-code")) roots.push(CLAUDE_ROOT);
	if (targets.has("codex") || targets.has("gemini-cli") || targets.has("cursor")) {
		roots.push(SHARED_ROOT);
	}
	const written = new Map<string, string>();

	for (const asset of assets) {
		const files = readable(asset, output);
		if (!files) continue;
		const identity = canonicalJson(files);
		const known = written.get(asset.name);
		if (known !== undefined) {
			if (known !== identity) output.problem(asset.name, "Another skill has the same name");
			continue;
		}
		written.set(asset.name, identity);
		for (const root of roots) {
			for (const file of files)
				output.add(`${root}/${asset.name}/${file.path}`, file.content, asset.name);
		}
	}
}

/** Every file with its text, or null with a problem: a skill is written whole or not at all. */
function readable(asset: AssetToWrite, output: Output): { path: string; content: string }[] | null {
	if (!SKILL_NAME.test(asset.name)) {
		output.problem(asset.name, "The name cannot be a folder name");
		return null;
	}
	const files: { path: string; content: string }[] = [];
	for (const file of [...asset.files].sort((a, b) => compare(a.path, b.path))) {
		if (file.content === null) {
			output.problem(asset.name, `The registry did not keep the text of ${file.path}`);
			return null;
		}
		if (!isSafePath(file.path) || isEnvFile(file.path)) {
			output.problem(asset.name, `${file.path} is not a path a skill may write`);
			return null;
		}
		files.push({ path: file.path, content: file.content });
	}
	if (!files.some((file) => file.path === "SKILL.md")) {
		output.problem(asset.name, "The skill has no SKILL.md");
		return null;
	}
	return files;
}
