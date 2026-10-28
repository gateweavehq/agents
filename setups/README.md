# Ready-made setups

Each folder here is a setup that every workspace can add in one click from its Setups page. The
app bundles these folders into the Worker; the Durable Object stores nothing until someone adds one.

## Format

```
setups/<slug>/
  setup.json        the manifest
  AGENTS.md         the files of its assets, in any layout you like
  skills/review/    a skill is a folder, with SKILL.md at its top
  servers/acme.json an MCP server is one file
```

`setup.json` is the `setupManifest` schema in `packages/model/src/inputs.ts`:

- `name` and `description`: what the Setups page shows.
- `runtimes`: the coding agents it configures, from `claude-code`, `codex`, `gemini-cli` and
  `cursor`.
- `assets`: each has a `kind` (`instructions`, `skill` or `mcp-server` are the kinds that can be
  written), a `name`, an optional `description`, and a `path` to a file or folder relative to
  `setup.json`. The name of a library asset is unique per kind, and an asset keeps its name when
  setups share it, so give instructions a name of their own (for example "Review rules") rather
  than `AGENTS.md`, or two setups would become versions of one asset.

An MCP server is stored the way the registry stores a scanned one: values under `env` and
`headers` are `<redacted>`, and the files a setup writes then refer to an environment variable
for each (a header `Authorization` becomes the variable `AUTHORIZATION`, which holds the whole
header value, such as `Bearer <token>`). Never put a real token in a folder.

## Rules the tests enforce

`packages/adapters/test/ready-made.test.ts` reads every folder here, so a new one is tested by
adding it. For each folder:

- `readSetupFolder` accepts it.
- `writeAssets` reports no problems for its runtimes.
- Every file it writes is one the scanner reads (`wantsFile`).
- It has no dotfiles.
- `detect` finds each asset again in what it writes, for each runtime.
- The MCP configuration it writes holds no literal token.

`apps/web/src/server/ready-made.test.ts` checks that the app can load every folder.

## Propose a setup

1. Branch from `main` as `feat/setup-<slug>`.
2. Add `setups/<slug>/` as above. Write the text yourself, copy nothing you may not relicense
   under AGPL-3.0, and include no secrets.
3. Run `pnpm verify`.
4. Open a pull request (see [CONTRIBUTING.md](../CONTRIBUTING.md)) that says who the setup is for
   and why each asset is in it.
