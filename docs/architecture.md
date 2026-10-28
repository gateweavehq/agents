# Architecture

How Gateweave Agents is built today. [spec.md](spec.md) describes where it is going; this file
changes with the code.

## One Worker

The UI, the API and auth ship as one Worker (`apps/web`), the same shape as Gateweave Track:

- **TanStack Start** renders pages on the server and hydrates them in the browser. Server
  functions are the API: each one checks the session and, for workspace data, the caller's
  membership before doing anything.
- **Better Auth** owns accounts, sessions, workspaces (its organizations), members, roles and
  invitations, stored in **D1**. There is one Better Auth instance per isolate, built on first
  use, because workerd forbids I/O in global scope.
- **Rate limits** on sign-in, password reset, invitations and email are counted in a
  `RateLimiter` Durable Object per client address or recipient, so they hold across isolates and
  locations. Everything else is limited in memory per isolate.
- **Email** goes through Cloudflare Email Service when `EMAIL_FROM` is set: password reset,
  verification and invitations. Without it, invitations are links to share.

## The registry

Each workspace's registry is a Durable Object with its own SQLite database (`RegistryDO` in
`packages/registry`, named by the workspace id). Pages read it through server functions; it is
not synced to the browser yet (see "Decisions" in the spec).

- **Access.** The registry has no route. A server function checks the caller's session and D1
  membership (`currentMember`), then calls the workspace's registry over RPC. Deleting a
  workspace deletes its registry too.
- **Data.** Projects group repositories, and a repository can be in several. Repositories are
  matched by the provider's own id, so a rename keeps their history. A scan of one repository at
  one commit lists the agents configured in it (Claude Code, Codex, and so on, and their
  subagents) and the assets they read: instructions, prompts, skills, plugins, scripts, MCP
  servers and settings. `packages/model` defines that contract, and the registry validates
  every call against it.
- **Content.** Files are stored once, by Git blob id, in a `blobs` table; files over 256 KiB keep
  their id and size but not their text. An asset's hash covers its files' paths, relative to the
  asset, and their blob ids, so the same skill or `CLAUDE.md` has the same hash in every
  repository. That is how drift shows: compare hashes. An asset gets a new version only when its
  hash changes, and each version records the commit it was found at.
- **Scans replace.** Applying a scan makes the repository's agents and assets match it, in one
  transaction. What it no longer finds is marked removed rather than deleted, and comes back
  with the same id if a later scan finds it. A scan older than the last one applied is ignored,
  so webhooks that arrive out of order cannot roll a repository back. A failed scan is recorded
  without touching what earlier scans found.
- **Room for the runtime.** Agents and assets may have no repository: those are agents defined
  in the app and assets in the library (phases 2 and 3). Setups, teams and runs come as tables
  of their own when those phases start.

## GitHub

A workspace reads its repositories through a GitHub App ([github-app.md](github-app.md) sets one
up). `packages/github` is the app's client: a JWT signed with WebCrypto, installation tokens
cached per isolate, the OAuth web flow with PKCE, and webhook signatures. It needs nothing but
`fetch` and `crypto.subtle`, so it runs in workerd without Node polyfills.

- **Linking.** A `github_installation` row in D1 links an installation to one workspace. An
  admin links it through install, setup and callback (`apps/web/src/server/github/flow.ts`).
  The installation id that GitHub's setup redirect carries is not trusted: the link is made only
  after a user token shows that this person can reach the installation on GitHub. The token is
  not kept.
- **Staying in step.** Linking, and webhooks for installation and repository changes, list the
  installation's repositories and reconcile them into the registry: new ones appear, renamed ones
  keep their history (they are matched by GitHub's id), and ones the app no longer reaches are
  marked removed. Uninstalling the app, or disconnecting it, removes them all. Webhooks are
  verified with the app's secret; deliveries for installations no workspace linked are
  acknowledged and dropped.

## Format adapters

`packages/adapters` turns a repository's files into the agents and assets of a scan. It is pure
TypeScript with no I/O, so it runs in the Worker. The scanner lists the repository's tree, asks
`wantsFile` which paths it needs, downloads those, and calls `detect`.

- **One adapter per coding agent** (Claude Code, Codex, Gemini CLI, Cursor), each knowing only its
  own files, so a repository with just `AGENTS.md` has a Codex agent and nothing else. The
  vendor's documentation is linked at the top of each adapter.
- **Shared files are shared assets.** `detect` merges what the adapters find by asset key, so
  `AGENTS.md` or a `.agents/skills` folder is one asset that several agents read.
- **Secrets stay in the adapters.** Settings and MCP configuration are stored as canonical JSON
  (or TOML) with every value under `env` or `headers`, and anything that looks like a credential,
  replaced by `<redacted>`. Metadata carries the names of variables and headers, never values.
- **A Claude Code plugin is its root folder**, the parent of `.claude-plugin/`, because its
  commands, agents, skills and hooks live beside the manifest and a change to them must change
  the asset. Files are given by blob and size; only `.claude-plugin/*.json`, `.mcp.json` and
  `hooks/hooks.json` keep their (redacted) text. Another plugin's folder is never part of a
  plugin, and a plugin at the repository root takes only the documented component locations (and
  the paths its manifest names), not the whole repository. A root plugin is keyed
  `.claude-plugin`, since a path cannot be empty.
- **Problems, not exceptions.** A file that is missing its text or does not parse becomes a
  `ScanProblem` and is skipped; the rest of the scan goes on.
- **Writers are the reverse of `detect`.** `writeAssets(assets, runtimes)` turns library assets
  into the files to put in a repository, in each agent's own format. It is pure and
  byte-stable: sorted keys, `\n` newlines, one trailing newline, files sorted by path, and the
  same output whatever order the input came in, so drift detection can compare Git blob ids with
  a later scan. It returns `{ files, problems }`; an asset it cannot write whole is reported and
  skipped, never written in part.
  - _Instructions_ go back to the path in their name. Per folder, the shared text is combined in
    name order into `AGENTS.md` (Codex, Cursor). `CLAUDE.md` and `GEMINI.md` import it
    (`@AGENTS.md`, `@./AGENTS.md`) when another agent reads `AGENTS.md` too, and hold the text
    themselves otherwise. Cursor rules (`alwaysApply` in the metadata) become `.cursor/rules/*.mdc`
    and `.claude/rules` files stay Claude Code's; other runtimes ignore both.
  - _Skills_ go to `.claude/skills` for Claude Code and `.agents/skills` for Codex, Gemini CLI and
    Cursor, in a folder named after the `name` in `SKILL.md`, so a library can call a skill anything.
  - _MCP servers_ go to `.mcp.json`, `.codex/config.toml`, `.gemini/settings.json` and
    `.cursor/mcp.json`. A stored server is converted between formats. The registry keeps
    `<redacted>` where a secret was, so the writer writes a reference to an environment variable
    instead (`${NAME}`, `${env:NAME}`, Codex's `env_vars` and `env_http_headers`), named after the
    `env` entry or header. A `<redacted>` anywhere else has no name to point at, so that server is
    reported and left out. No file ever contains `<redacted>`.
  - _Not written_ (reported as problems): `settings`, `prompt`, `script`, `env-set` and `plugin`.

## Scans

Each workspace's `RegistryDO` scans its own repositories. Requests wait in its SQLite database
(`scan_requests`), and its alarm works through them a few at a time.

- **What asks for a scan.** A push to a repository's default branch (the webhook), and a
  reconcile that finds a repository new, back after removal, on another default branch or never
  scanned. Asking again while a request waits moves it to the front.
- **What a scan reads.** The default branch's head and its whole tree, then the text of the
  files the adapters want (`wantsFile`), fifty blobs per GraphQL request. Texts the registry
  already holds, by blob id, are not downloaded again, so a scan after a push downloads what the
  push changed. A wanted symlink, such as `CLAUDE.md` pointing to `AGENTS.md`, is read as its
  target. A head the last successful scan already read is not scanned again, unless a member
  asks with "Scan now", which forces a read for after the adapters learn something new.
- **Writes stay synchronous.** A scan awaits GitHub outside any transaction, then validates the
  result like any other scan and applies it in one. A failure is recorded on the repository and
  tried again after a minute, ten minutes and an hour; what earlier scans found stays.

## The library

The library is the workspace's own copy of the skills, prompts and configuration it wants to
keep: assets with no repository (`packages/registry/src/library.ts`).

- **Adding.** An owner or admin adds a repository asset's current content, as a new library asset
  or as the next version of one of the same kind. Content the library asset already has as its
  latest version adds nothing. A library asset is keyed by its kind and name, and a name is
  unique among the library's live assets of that kind.
- **Writing.** An owner or admin can also type a library asset in the app: an `instructions`,
  `prompt` or `skill`, one text file each. The file is named as a scan names the same file
  (`AGENTS.md`, `SKILL.md`, and `<prompt name>.md`), and its blob id and the asset hash are computed
  the way a scan does, so a repository carrying that text counts as a use.
- **Editing.** On a library asset's page, an owner or admin edits the text of any file the registry
  kept (up to 256 KiB each) and saves it as the next version. A version is added only when the
  asset hash changes. A skill's description follows its `SKILL.md` front matter. Repository assets
  cannot be edited: the repository is the source of their text.
- **Uses come from content.** A repository asset uses a library asset when its hash equals one of
  that asset's versions, and is behind when that version is not the latest. Nothing links them,
  so a file copied by hand counts the same as one a setup will write, and a repository that
  changes its copy stops counting at its next scan.
- **Removing** marks the library asset removed, frees its name and leaves repositories alone.

## Setups

A setup is a set of library assets, each pinned to one of its versions, for the coding agents it
configures (`packages/registry/src/setups.ts`). Owners and admins manage them.

- **Pins move by hand.** A new version in the library shows on the setup as an update, and the
  setup keeps writing the pinned version until someone moves the pin. An asset that leaves the
  library keeps its pin, since its versions are kept, but cannot be pinned anew.
- **The preview is the writers' output.** The registry reads each pinned version's files and
  runs `writeAssets` from `packages/adapters` for the setup's coding agents, so the page shows
  exactly the files a setup writes, and what it cannot write and why.

## Pages

The workspace's pages read the registry through server functions in `apps/web/src/lib/registry.ts`,
each of which checks membership first, so a non-member gets the same "not found" as a missing
workspace.

- **Overview** counts what the registry holds and shows a matrix of repositories by the coding
  agents each one configures.
- **Projects** group repositories, and a project's page shows the same matrix for its
  repositories and the agents in them. Owners and admins create, edit and delete projects and
  choose their repositories; everyone else in the workspace sees them.
- **Repositories** lists them with their scan status; a repository's page shows its agents, the
  assets they read grouped by kind, and the problems the last scan found.
- **Agents** lists every agent and subagent by runtime.
- **Library** lists the library's assets by kind, with how many repository assets carry one of
  their versions and how many of those are behind.
- **Setups** lists them with how many assets each pins and how many have updates; a setup's page
  shows its pins, moves one to the latest version, and previews the files it writes.
- **An asset's page** shows the text of each of its files and every earlier version. For a
  repository asset it also shows the agents that read it, the library assets it matches, and how
  many other assets have the same content; for a library asset, the repository assets that use it.
  An asset with two versions or more offers "Compare versions": any two, as a line diff per file
  (added, removed and changed files). The server function computes it with `diffLines` from the
  `diff` package, imported inside the handler so it stays out of the browser bundle. A file whose
  text is not kept shows only that it changed.

Pages refresh themselves while a scan of what they show is waiting or running.

## What comes next

- **Applying setups** (phase 2 in `docs/spec.md`): a pull request that writes a setup into a
  repository, merging into configuration files that hold more than the setup's part, then drift
  shown in the app and the CLI.

## Deploys

`main` deploys to staging after CI passes, and a published GitHub release deploys production
(`.github/workflows/deploy.yml`). D1 migrations are applied before the new code goes live.
