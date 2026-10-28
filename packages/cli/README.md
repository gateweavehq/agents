# @gateweave/agents

The command line for [Gateweave Agents](https://github.com/gateweavehq/agents). It writes a
setup's files into a repository the way the app's pull request would, and checks in CI that the
repository still holds them.

A setup is a folder with a `setup.json` and the files of its assets: instructions, skills and
MCP servers, for Claude Code, Codex, Gemini CLI and Cursor. The CLI also carries the ready-made
setups from the repository's `setups/` folder, so a name is enough.

## Usage

```sh
gateweave-agents list                    # the ready-made setups
gateweave-agents apply <setup>           # write the setup into the current folder
gateweave-agents apply <setup> --dry-run # say what would be written, write nothing
gateweave-agents check <setup>           # exit 1 when the files no longer match the setup
```

`<setup>` is a folder (`./agents-setup`) or a ready-made setup's name. `--dir <path>` points at
a working tree other than the current folder.

What it writes and what it leaves alone are decided by the same code as the app's pull requests:

- The setup owns the files it writes, except the MCP configuration files (`.mcp.json`,
  `.cursor/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`). Only its own servers are
  merged into those, and every other server and setting stays as it was.
- A symlink, or a file or folder in the way, is never written through or replaced. The CLI says
  which paths it left alone and why, without failing, since a repository may keep `CLAUDE.md` as
  a symlink to `AGENTS.md` on purpose.
- Files are written with LF line endings, and a checkout with CRLF counts as holding the same
  text.

Exit codes: `0` for success, `1` when `check` finds files that differ, `2` when the command could
not run (a wrong argument, or a setup that cannot be read).

## In CI

```yaml
- uses: actions/checkout@v6
- uses: actions/setup-node@v6
  with:
    node-version: 24
- run: npx @gateweave/agents check ./agents-setup
```

## Setup folders

```json
{
	"name": "Baseline",
	"description": "House rules, a review skill and the GitHub MCP server",
	"runtimes": ["claude-code", "codex"],
	"assets": [
		{ "kind": "instructions", "name": "AGENTS.md", "path": "AGENTS.md" },
		{ "kind": "skill", "name": "review", "path": "skills/review" },
		{ "kind": "mcp-server", "name": "github", "path": "servers/github.json" }
	]
}
```

Each asset's `path` is a file or a folder next to `setup.json`. An MCP server is one server's
JSON (`{ "type": "http", "url": "…" }`, or a `command` with `args`). In its `env` and `headers`,
a value written as `${NAME}` becomes each agent's own way of reading that environment variable,
so secrets never go in the files.

## License

[AGPL-3.0](../../LICENSE).
