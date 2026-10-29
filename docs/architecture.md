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
  in the app and assets in the library (phases 2 and 3). Runs have a table of their own (see
  "Runs"), and teams will too.

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
- **Writing.** Commits, branches and pull requests through the REST API
  (`packages/github/src/writes.ts`), for applying setups.
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
- **Applying is planned, not guessed.** `planApply` decides how those files land in a repository
  (pure, like the writers): files it owns are replaced, symlinks and non-folders in the way are
  reported and left alone, and in the four MCP configuration files only the setup's own servers
  are merged in, so a repository's other servers and settings survive.

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
- **What a scan records.** Besides agents and assets, every file it read: path, blob id, size and
  whether it is a symlink (`repository_files`), with the text of each new one kept by blob id.
  Every file a setup writes is one the adapters want (a test in `packages/adapters` holds the
  writers to it), so drift needs nothing else. Only files that changed since the last scan are
  written.
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
- **Ready-made setups are folders.** `setups/<slug>/` at the repository root holds a
  `setup.json` and the files of its assets (see `setups/README.md`). The app bundles them into
  the Worker as text (`apps/web/src/server/ready-made.ts`) and reads each with `readSetupFolder`.
  Tests in `packages/adapters/test/ready-made.test.ts` hold every folder to the same rules: it
  reads, writes cleanly for its coding agents, is found again by `detect`, and carries no secret.
- **Adding one is one write.** `importSetup` runs in a single transaction: for each asset it
  reuses the library asset of the same kind and name when one of its versions already has these
  files, adds a version when the files differ, and creates the asset otherwise. It then creates
  a setup pinning the result. Adding the same setup twice therefore makes no new versions. An
  owner or admin reaches it from the Setups page.

## Applying setups

Applying a setup to a repository opens a pull request (`packages/registry/src/apply.ts`). Owners
and admins apply them, and [github-app.md](github-app.md#applying-a-setup) has the user's view.

- **The default branch is never written.** The registry reads its head, plans the files with
  `planApply` from `packages/adapters`, commits them on top of that head with a tree based on the
  head's (so no other file changes), and points a new `gateweave/<setup>-<id>` branch at the
  commit. Files go into the tree as content, so a commit is two requests however many files it
  changes. Shared configuration files are merged, not replaced, and their text comes from the
  registry's blobs when the last scan kept it. Any other file is compared by Git blob id and never
  downloaded.
- **Each application is a row** in `setup_applications`: the repository, the setup, the pins, the
  files it leaves the setup owning (by blob id, for drift), the branch and commit, and the pull
  request with its state. Every GitHub outcome is written in a transaction of its own as soon as
  it is known, never across an await.
- **Applying again** with the pull request still open checks it on GitHub first. If it was merged
  or closed without a webhook saying so, the row catches up and a new pull request is opened. If
  someone else pushed to its branch, the registry refuses. Otherwise a new commit replaces the
  branch's, and nothing happens when the open pull request already writes the same files.
- **Refusals are answers.** `applySetup` returns `{ status: "refused", message }` instead of
  throwing: an error loses its class on its way out of the Durable Object, and the message is meant
  for the person who asked. One setup is applied to one repository at a time per instance.
- **A merge queues a forced scan** of the repository, whether a webhook or applying again
  reported it. It is forced because the push's own scan may have read the merge before the merge
  was recorded, and an unforced scan skips a head it has read.

## Drift

Drift is how a repository compares with a setup merged into it (`packages/registry/src/drift.ts`).
It is computed when a page asks, from what the registry already holds, so it cannot go stale and
needs no GitHub request.

- **The baseline** is the newest merged pull request that applied the setup there, with the files
  it left the setup owning, by blob id. A later pull request that is still open is shown beside
  it, and one closed without merging changes nothing.
- **The comparison** plans the setup's current files against the files the last scan recorded,
  with `planApply`, exactly as applying it again would. Each file that plan would change is
  **behind** when the repository still holds what the merge left (or the setup did not own the
  file then), **changed** when it holds something else, and **missing** when the file is gone. A
  file the setup owned that applying would now leave alone, such as one replaced by a symlink,
  is changed too. In a shared configuration file only the setup's own servers count, so a server
  someone else added there is not drift.
- **The state** of a setup in a repository is its most urgent file's: missing, changed, behind,
  then in sync. Until a scan has read the merge it is **unscanned**, rather than every file
  looking missing. A repository's state in the lists is the most urgent of its setups'.
- **Applying again** from either page opens a pull request, or updates the open one, through the
  same dialog as **Apply**.

## Model providers

A workspace brings its own keys for the model providers its agents use (Anthropic, OpenAI and
Google), so usage is billed to the workspace's accounts. An owner or admin adds them on the
Models settings page. **Workers AI** is the exception: it needs no key of the workspace's (see
"Workers AI" below). Everything about keys (saving, sealing, checking) takes only the three keyed
providers, `KEYED_PROVIDERS` in `packages/model/src/vocabulary.ts`; `MODEL_PROVIDERS` is those
and Workers AI, for what an agent definition may name.

- **Sealed in the registry.** A key is encrypted with AES-256-GCM before it is stored, under a
  key derived with HKDF from the server's `SECRETS_KEY` secret and the workspace's Durable Object
  id, with the key's place as additional data (`packages/registry/src/secrets.ts`). A key sealed
  in one workspace does not open in another, and a sealed value copied to another row does not
  open there either. Without `SECRETS_KEY` the page says so and keys cannot be added.
- **Only the registry opens one**, when a request needs it. Server functions get the provider,
  the last four characters, who added it and when, and the last check, never the key.
- **Checking a key** lists the provider's models with it (`listProviderModels` in
  `packages/registry/src/providers.ts`) and records whether that worked, how many models there
  are, or the provider's refusal in a sentence. A check that finishes after the key was replaced
  is dropped.
- **Losing `SECRETS_KEY` loses the keys.** A check then says the key cannot be opened, and it
  has to be added again.
  Sealed values carry a version, so a rotation scheme can be added beside this one.

### Workers AI

Workers AI models run on Cloudflare's own GPUs and cost the workspace nothing directly: the
**deployment pays** through its Cloudflare account, and only when it opts in. Gateweave Cloud's
production leaves it off for now; a self-hoster turns it on.

- **Turning it on** takes a secret `WORKERS_AI_TOKEN` (a Cloudflare API token with the Workers AI
  permission, never in `wrangler.jsonc`) and the account that pays: the var
  `CLOUDFLARE_ACCOUNT_ID`, or else the account in `AI_GATEWAY_URL`. Without both, Workers AI is
  not offered, and says so: the agent dialogs label it "(not on this server)", Settings > Models
  says the server does not offer it, and a turn of an agent that uses it is refused up front with
  "This server does not offer Workers AI". `workersAiOffered` in `packages/model/src/workers-ai.ts`
  decides, for the registry, the runtime and the app alike.
- **No key.** Workspaces never save one, and Settings > Models has no key form for it. The
  registry's `beginTurn` hands the runtime `key: null` for it; the runtime reads the token and
  account from its own environment. The token is never stored, never returned by a server
  function and never in a page; the registry only sees whether it is set.
- **Reached by URL**, like AI Gateway, because the `AI` binding always calls Cloudflare. The
  runtime uses Cloudflare's OpenAI-compatible REST API through `@ai-sdk/openai-compatible`
  (`packages/runtime/src/models.ts`): `https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1`,
  `Authorization: Bearer <WORKERS_AI_TOKEN>`, with `includeUsage` on. With `AI_GATEWAY_URL` set,
  the request goes to the same URL with a `cf-aig-gateway-id` header naming the gateway, plus
  `cf-aig-metadata` and (for an authenticated gateway) `cf-aig-authorization`, as for the other
  providers.
- **Usage.** Streamed, every chunk carries a `usage` object with that chunk's increment, and the
  last chunk before `[DONE]` carries the totals for the request, which is the one the AI SDK
  keeps. A test pins this shape, so a change in the SDK cannot silently undercount.
- **Models** are Workers AI's own ids, such as `@cf/meta/llama-4-scout-17b-16e-instruct`. The
  lists in the agent dialog and on Settings > Models come from the catalog
  (`GET /accounts/<account>/ai/models/search?task=Text Generation`, in
  `packages/runtime/src/workers-ai.ts`), made with the deployment's token and keeping the models
  whose `function_calling` property is `"true"`, because agents need tools. Any id can still be
  typed.
- **Prices** for six models are in `MODEL_PRICES` (`packages/model/src/prices.ts`), from the
  catalog's `price` property. Other Workers AI models get no estimate, as an unlisted model of any
  provider does.

## Agents run by Gateweave

Owners and admins define agents in the app (runtime `gateweave`). Each one is a row in `agents`,
with no repository and its own id as its key, and a row in `agent_definitions` beside it
(`packages/registry/src/definitions.ts`).

- **The model** is a provider and the provider's id for it. The form lists the models the
  workspace's key can use (`listModels`), and takes any id, so an agent can be defined before the
  key is added.
- **Instructions** are a library asset of kind instructions or prompt, pinned to a version as a
  setup's assets are, and all text. The agent reads it through `agent_assets`, so the asset's
  page lists the agent. A new version in the library changes nothing until someone moves the pin.
- **MCP servers** are pinned like instructions, each optionally limited to some of its tools (see
  "MCP servers"). The form offers the tools of the server's last check on the MCP page; a server
  never checked keeps the list its pin has and says to check it first, so saving the form never
  drops a limit it could not show.
- **A sandbox**, off by default, gives each of the agent's conversations a Linux machine to run
  commands and edit files in (see "Sandboxes").
- **A turn reads one snapshot** (`agentSnapshot`): the model and the pinned instructions' text, in
  one synchronous read, so a turn never mixes two versions of an agent.
- **Removing an agent** marks it removed, as scans do, so its id stays known to whatever names
  it later, such as runs.

## Environment sets

An environment set is what an agent run by Gateweave runs with: variables and secrets. Owners and
admins manage them on the Environment page (`packages/registry/src/environment.ts`).

- **A set is a library asset** of kind `env-set` with one file, `environment.json`:
  `{ "variables": { "NAME": "value" }, "secrets": ["NAME"] }`. Names match `^[A-Z_][A-Z0-9_]*$`,
  there are at most 200 entries, and a name is a variable or a secret, never both. The registry
  writes the file with sorted keys, so the same content is the same bytes: an edit that changes
  nothing makes no version, and variables are versioned, shown and diffed like any asset. Secret
  values are never in the file. A set cannot be edited as plain files or copied from a
  repository, which would bypass those rules.
- **Secret values** are sealed (see "Model providers") in `env_secrets`, with the place
  `env-sets/<asset id>/<name>`. They belong to the set, not to a version, so moving a pin keeps
  them. A value can be set only for a name that is a secret in the set's current version. When an
  edit drops a name, its value is kept and shown as unused until someone removes it, so a typo
  fixed back finds its value again.
- **An agent picks one set**, pinned to a version like its instructions (`agent_definitions`,
  and `agent_assets` for the asset's page). A new version changes nothing until the pin moves.
  `agentSnapshot` does not carry it.
- **The runtime opens it.** `resolveEnvironment(agentId)` returns the pinned version's variables
  and the opened secrets, with the names that have no value (or whose value no longer opens)
  as `missing`. No page or server function calls it; the others only see `set` or `missing`.
- **Without `SECRETS_KEY`** the page says so and values cannot be set; sets with only variables
  work as they are.

## MCP servers

An agent run by Gateweave gets its tools from remote MCP servers in the library
(`packages/registry/src/mcp-servers.ts`).

- **A server is a library asset** of kind `mcp-server` with one file, `.mcp.json`, holding one
  server in the shape Claude Code reads: `{ "headers": {…}, "type": "http" | "sse", "url": "…" }`,
  written with sorted keys so the same settings are the same bytes. Owners and admins add one in
  the library or copy one a scan found. Its settings are edited in a form, not as text, so the
  rules below always hold, and saving the same settings makes no version.
- **No secret in the file.** The URL is https (plain http only for the machine itself), with no
  user, query or fragment, which is where tokens hide. Each header's value names a variable of
  the agent's environment set, as in `Bearer ${API_TOKEN}`, with only text before it. A scan
  keeps no header values at all, so a copied server's headers read as variables named after
  them, and Codex's `bearer_token_env_var` as an `Authorization: Bearer` header
  (`readMcpConnection` in `packages/adapters`).
- **An agent pins up to ten servers**, each to a version like its instructions
  (`agent_mcp_servers`, and `agent_assets` for the asset's page). Pinning refuses a server the
  runtime could not reach: one that runs as a local command, or whose URL breaks the rules above.
  The agent's page shows each server's transport and URL, or why it cannot be reached, and the
  variables its headers use, each marked set or missing in the agent's environment set.
- **A pin can limit the agent to some of the server's tools** (`tools` on the pin, a JSON list of
  the server's own tool names; null is all of them). An agent that reads text nobody vetted, such
  as issue bodies, should hold only the tools its job needs, so a prompt hidden in that text
  cannot reach the rest. The list is the agent's, not the server's: it moves with the pin to a
  newer version, and a name the server does not offer is just absent. Names are checked as input
  (no spaces, no repeats, at least one); an empty list is not "no tools", so it is refused.
- **Each turn connects anew** (`packages/runtime/src/tools.ts`). `beginTurn` reads the agent's
  servers with the agent, before anything awaits, and returns each with its headers' values filled
  in from the opened environment set, in memory for that turn like the key. A server whose
  variables are not all there is left out, with which ones. The runtime connects to the rest at
  once with `@ai-sdk/mcp`, ten seconds each to connect and list their tools, keeps only the tools
  the pin allows before they reach the model, and closes every connection when the turn ends. It
  does not use the Agents SDK's `addMcpServer`, which would keep the headers, secrets included, in
  the conversation's SQLite.
- **No redirects.** The MCP client refuses them with `redirect: "error"`, which Workers do not
  take, so the runtime gives it a `fetch` with `redirect: "manual"`: a 3xx is a failure, and the
  agent's headers never reach the address it names.
- **Tools are named `<server>__<tool>`**, with the characters providers refuse replaced by `_`,
  so two servers cannot clash. A turn makes at most ten model requests (`MAX_STEPS`): the first,
  and one after each round of tool calls. Tool calls a stopped turn left without a result are
  dropped from the next turn's history, which providers would refuse.
- **A server that cannot be reached** is a failed span in the trace, with why in our words (its
  credentials refused, nothing at its URL, a redirect, no answer in time), never what it said.
  The turn goes on without it.
- **A check** (`checkMcpServer` in the same file) connects the way a turn does, with one shared
  connect path, and lists the server's tools. An owner or admin runs it from the MCP page; the
  server function asks `mcpCheckTarget` for the server at its current version, with the headers
  filled in from the environment set of an agent that pins it (one pinned to the current version
  if there is one, else any live agent, else no environment), runs the check in the Worker and
  keeps the result with `recordMcpCheck` in `mcp_checks`: when, which version, whether it worked,
  the tools with their descriptions (cut to a sensible size), and the error in our words. The
  headers live in that request's memory and never reach the browser; the check keeps no header
  value and nothing the server said but its tools' names and descriptions. Servers that run as a
  local command are listed as unavailable and cannot be checked until cloud runners (AGT-9).

## Sandboxes

An agent with a sandbox works on a Linux machine of its own in each conversation: it runs
commands and reads, writes, edits, finds and searches files there. It is the first part of cloud
runners (phase 5, AGT-9). A deployment offers sandboxes when it binds `SANDBOX` with a container;
staging does, production and self-hosted deploys leave them off until their operator opts in.

- **One container per conversation.** `RunnerSandbox` (`packages/runtime/src/sandbox.ts`) is a
  Durable Object with a container, named like its conversation and reached only by it, over RPC.
  It has no route. The container starts on the first call, from `sandbox/Dockerfile` (Debian
  with Node.js 24, Python 3, git, ripgrep, curl, jq and the shim `@cloudflare/sandbox` 1.0 talks
  to), as a `standard-1` instance, and stops after 15 minutes without a call; its disk goes with
  it. Deleting the conversation stops it at once.
- **No internet, but packages.** The container starts with `enableInternet: false`, and all of its
  HTTP and HTTPS goes to `SandboxOutbound`, a `WorkerEntrypoint` of the app's Worker, through the
  container's own certificate authority. `decideOutbound` (`packages/runtime/src/outbound.ts`)
  lets GET and HEAD to package registries through (npm, PyPI, crates.io, Go's module proxy) and
  answers everything else with a 403 that says why, which the command prints. A redirect goes
  back to the command, so each address it leads to is decided on too. The sandbox holds no secret
  of the workspace's: the key, the environment set and MCP headers stay in the Worker.
- **The tools** (`packages/runtime/src/sandbox-tools.ts`): `run_command` (a bash line, in a
  directory, stopped by `timeout` after 120 seconds unless the model asks for up to 600, its
  output clipped to its first and last 15 KB), `read_file` (numbered lines, 2,000 at a time),
  `write_file`, `edit_file` (an exact replacement, found once unless every place is asked for),
  `find_files` and `search` (ripgrep). File paths stay under `/workspace`; that keeps the tools on
  the work, not a wall, since a command reaches the whole machine, which holds nothing else. They
  reach the container through `SandboxPort`, which the tests fill with files in memory.
- **The trace** has a span for each call, under the server name `sandbox`, with its sizes and
  never its content, like an MCP tool's. A turn with a sandbox may take 40 model requests
  (`MAX_SANDBOX_STEPS`) instead of 10, since its work goes in many small steps.
- **The registry decides.** The agent's `sandbox` setting is in `agent_definitions` and its
  snapshot. `beginTurn` refuses a turn that needs a sandbox where the server binds none, and one
  that would make more than three of the workspace's conversations hold one at once
  (`MAX_WORKSPACE_SANDBOXES`): a conversation holds one from a run marked `sandbox` until 15
  minutes after its last such run ended. An ask over a team's edge has no tools, so it needs no
  sandbox.
- **A repository in the sandbox** (AGT-41). An agent with a sandbox can choose a repository the
  workspace's GitHub App reaches (`agent_definitions.repository_id`). On the conversation's first
  tool call, `withCheckout` (`packages/runtime/src/checkout.ts`) asks the sandbox to clone it into
  `/workspace/repo` from its default branch, blobs on demand, onto `gateweave/<conversation>`,
  and the model is told so after the agent's instructions. A checkout that fails is that tool's
  answer, and the next call tries again. The conversation keeps the repository it first checked
  out; one chosen later is for later conversations. The container's disk goes when it idles, so
  the next checkout starts over.
- **The token never enters the sandbox.** Git's requests go out through `SandboxOutbound` like any
  other. `decideOutbound` lets through only git's smart HTTP fetch of that one repository
  (`info/refs` for `git-upload-pack`, and the pack), refusing pushes and the rest of github.com.
  For those it allows, the Worker asks the sandbox which repository it checked out and mints an
  installation token scoped to that repository with `contents: read`
  (`GitHubApp.repositoryToken`). The Worker adds the token as the request leaves, so no command
  can print it. The registry refuses the turn when the app no longer reaches the repository, or
  when the server is not set up as a GitHub App.
- **Pull requests from the sandbox** (AGT-42). A turn whose sandbox has a repository also has
  `open_pull_request {title, body}` (`packages/runtime/src/pull-requests.ts`). The sandbox commits
  every change with the title as the message, by the agent at `noreply@gateweave.com`, with the
  repository's own hooks. It refuses when the work has no commit the default branch lacks, then
  runs `git push` of `gateweave/<conversation>` (`RunnerSandbox.push`). The Worker then opens a
  pull request against the default branch with a token for `pull_requests: write` and
  `contents: read`, or updates the one the branch has open; the sandbox never makes it. GitHub
  lists only the first for these calls, but refuses a pull request with "not all refs are
  readable" without the second. A sandbox that stopped and starts again (after 15 minutes without
  use) clones the repository afresh and goes on from the branch as the conversation last pushed
  it, so its next push adds to the same pull request. The pull request goes on the run
  (`runs.pull_request`), and Runs and Chat link to it.
- **Only that push gets through.** `RunnerSandbox` opens a push window, in memory, for as long as
  its own `git push` runs. Only then does `decideOutbound` let `git-receive-pack` through, with a
  token for `contents: write`. Before the pack goes on, `SandboxOutbound` reads the ref updates it
  starts with (`pushedRefs`) and refuses anything else (`checkPush`):
  - more than one ref, or any ref but the conversation's branch;
  - deleting the branch;
  - an update from a commit other than the one the conversation last pushed, so commits someone
    else pushed are never dropped.

  A push it cannot read, encoded or over 50 MB, is refused too. A command the agent runs can never
  push, even while the window is open, to anything but that branch.

## Chat

Members talk to agents run by Gateweave on the Chat page. Each conversation is a Durable Object
of its own, `ConversationAgent` (`packages/runtime`), built on the Agents SDK's `AIChatAgent`: it
keeps the messages in its SQLite, streams the reply over a WebSocket, and picks a stream back up
after a reconnect.

- **A conversation belongs to the member who started it.** The registry keeps the index
  (`conversations`: the agent, who started it, the title and when), and nobody else lists, opens
  or deletes it, admins included. The Durable Object is named `<workspace id>:<conversation id>`.
- **No public route.** The browser connects to `/api/chat/<slug>/<conversation id>` and reads
  `…/get-messages` first. The gateway (`apps/web/src/server/chat.ts`) takes only GET, requires
  the app's own Origin on WebSockets, checks the session, the membership in D1 and the
  conversation's owner, and passes the request on without its cookies. Anyone else gets the 404
  a missing conversation gets.
- **Each turn asks the registry** (`beginTurn`). It records the turn (the first message titles
  the conversation) and returns the agent's snapshot with the workspace's key for its provider,
  opened, or a sentence saying why the agent cannot answer: it was removed, or the workspace has
  no key. The key stays in memory for that turn.
- **The model** is called with the AI SDK (`streamText`) and the provider's own package, with the
  agent's pinned instructions as the system prompt. Stopping a turn aborts the model's request. A
  provider's refusal becomes a sentence of ours chosen by its status (`describeFailure` in
  `packages/runtime/src/models.ts`); the provider's message, which can quote the key, is neither
  shown nor logged.
- **AI Gateway, when the deployment names one.** With `AI_GATEWAY_URL`
  (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`), every model request goes through
  that gateway with the workspace's key (Workers AI: the deployment's token, see "Workers AI"),
  and `cf-aig-metadata` names the workspace, agent and conversation so its logs and analytics
  split by workspace. `AI_GATEWAY_TOKEN` is for an authenticated gateway. The gateway is reached
  by URL rather than through an `ai` binding, because the binding always calls Cloudflare: local
  development and the tests would need a Cloudflare login. Without the setting, requests go
  straight to the provider.
- **Replies are Markdown**, rendered with `react-markdown` and GitHub's extensions. An image in
  a reply shows as a link instead, so a reply cannot make the browser fetch an address it chose
  (which could carry the conversation away in its query).
- **Deleting a conversation** removes its row, then destroys its Durable Object with the
  messages and traces. Its runs stay (see "Runs").
- **Tools** come from the agent's MCP servers (see "MCP servers"). The conversation shows each
  call as its server and tool, running, done or failed; what went in and came back is in the
  messages, for the model, and not shown.

## Runs

Every turn that reaches the model is a run. The registry keeps a summary of each, and the
conversation's Durable Object keeps its trace (`packages/runtime/src/trace.ts`).

- **The registry opens the run.** `beginTurn` adds a `runs` row (`running`, the agent, model,
  conversation and member) in the write that opens the key, and returns its id. A turn the
  registry refuses (no key, the agent removed) is not a run.
- **The trace stays with the conversation**: a span per model request in the conversation's own
  SQLite (`trace_runs`, `trace_spans`), written as each step starts and ends, with its timing,
  tokens, cache reads, estimated cost, finish reason, time to the first token and AI Gateway's
  log id (`cf-aig-log-id`). Connecting to each MCP server is a span too, with how many tools it
  gives the agent (after its allowlist), and so is each tool call, under the model request that made it, with the sizes of its
  input and output. A trace holds no message text and no tool input or output, so it is private
  to the conversation without being secret: it goes when the conversation is deleted, and admins
  can read it while it lasts.
- **The runtime closes the run** once, from whichever of the AI SDK's `onEnd`, `onAbort` and
  `onError` comes first: `succeeded`, `failed` (with our sentence, never the provider's),
  or `stopped`. It sums the model spans and reports them with `finishRun`, which changes only a run
  still `running`, so a late or repeated report changes nothing.
- **A restart can cut a run short.** When a conversation wakes, it closes the runs it finds still
  open as `interrupted`, at the last moment its trace saw them move, and reports them. A
  conversation nobody opens again never wakes, so the registry marks runs older than an hour
  `interrupted` itself, with no end, before it lists or sums them. If the conversation does wake
  later, its report still fills in what the run used, once.
- **Cost is an estimate**, in millionths of a dollar: each request at the list prices of the day
  it ran (`packages/model/src/prices.ts`), with cache reads and writes at their own rates and the
  long-context rates when a request crosses its model's threshold. A model the table does not
  list gets no estimate, and neither does a run that used one; the Overview says how many runs it
  left out. The provider's bill and AI Gateway's logs stay the record.
- **Runs outlive their conversations.** Deleting a conversation clears the run's link to it in
  the same write, so the workspace's usage stays counted.

## Teams

A team is a directed graph of agents run by Gateweave (`packages/registry/src/teams.ts`). It
lives in the registry: `teams`, `team_members` and `team_edges`.

- **Members** are agents run by Gateweave or other teams, by id; ids are UUIDs, so an agent's
  never clashes with a team's. One of the agents is the lead, the one a chat with the team talks
  to. In edges, a team stands for its lead.
- **Edges** go from one member to another: `delegate` hands over a task and waits for the result,
  `ask` asks one question that is answered without tools, and `report` sends a message without
  waiting.
- **The whole graph is saved at once.** `setTeamGraph` takes the members, the edges and the lead
  and checks them together in one write, so a page never saves half a change and nothing can
  slip between two checks.
- **Two rules keep every turn finite**, checked in the team and in every team it is part of,
  since a change deep down changes what the teams above it do:
  - a team never contains itself, directly or through the teams in it;
  - `delegate` and `ask` edges, the ones that wait for an answer, never go in a circle once each
    team in the graph stands for its lead. A refusal names the circle, agent by agent. Reports
    may go back up, since nobody waits on them; how far they go is a limit of the runtime.
- **A removed agent stays where it was**, marked, until someone takes it out, so removing an
  agent never changes a graph by itself. It cannot join a team anew or start leading one. A team
  that is in another team cannot be deleted until it is taken out of there.

### A team's turns

A conversation can be with a team (`conversations.team_id`). Each turn is answered by the team's
lead as it is then (`packages/registry/src/team-turns.ts`, `packages/runtime/src/edges.ts`).

- **Where an agent stands** is the path of teams from the one the person talks to down to the
  one it acts in, and the agent. The lead of the team being chatted with stands at the top. The
  registry keeps each run's place (`runs.team_path`), so the runtime never says where a turn is.
- **Its edges are its tools.** A turn gets one tool per edge its agent can take where it stands:
  its own edges in the team it acts in and, when it leads that team, the team's own edges in the
  team above. That is what "a team stands for its lead" means in a turn. Tools are named
  `delegate__<member>`, `ask__<member>` and `report__<member>` and sorted by name, so a turn's
  tools come in the same order each time. Edges to removed agents are left out.
- **Taking an edge is a nested turn** of the agent at the other end. It runs in a new
  conversation of its own, a `ConversationAgent` reached by RPC (`nestedTurn`). It sees only the
  task, question or message, never the conversation that called it.
  - `delegate` gets the agent's MCP tools and its own edges, and the caller waits for the answer.
  - `ask` is one model request without tools or edges, and the caller waits.
  - `report` gets a full turn, and the caller goes on as soon as the registry has begun it. The
    nested conversation stays awake until the turn ends (`keepAliveWhile`).
  - Stopping a turn stops the delegates and asks it waits on; reports go on.
- **The registry decides each one.** The nested turn calls `beginTurn` with the edge it came
  through: the calling run, its span for the call, the edge's kind, team and member. The registry
  checks it against the graphs as they are, from the calling run's stored place, and checks the
  limits. It does so again in the write that opens the run, so two calls at once cannot both
  slip under a limit. A refusal comes back to the calling model as the tool's error, in our
  words.
- **The limits** (`TEAM_TURN_LIMITS`): a message's turns nest at most 4 edges deep, one turn
  takes at most 8 edges, and one message leads to at most 32 nested turns in all. An answer to an
  `ask` takes no edges. Reports may go in a circle, so these limits are what keeps a team from
  running away with the workspace's keys.
- **Nested runs** have the calling run (`parent_run_id`), its span for the call
  (`parent_span_id`), the run of the person's message (`root_run_id`), the edge and the depth.
  The caller's trace has an `edge` span per call, pointing at the run it started. A nested run
  belongs to the member whose message started it all, and counts once in usage, like any run.
- **No public route.** A nested conversation (`conversations.root_id`) is not listed or opened
  by the registry, so the chat gateway sends 404 for it. A turn there without an edge is refused.
  Deleting the person's conversation deletes the nested ones with it, Durable Objects included.

## Triggers

A trigger starts a run of an agent run by Gateweave, or of a team's lead, when another service
posts a webhook to it (`packages/registry/src/triggers.ts`, `apps/web/src/server/triggers.ts`).
Owners and admins make them on the agent's or team's page, each with a name, a prompt and how
many runs it may start a day.

- **Standard Webhooks.** Each trigger has a secret, `whsec_` and 32 random bytes in base64, sealed
  in the registry like a provider key and shown once, when it is made or replaced. A delivery
  carries `webhook-id`, `webhook-timestamp` and `webhook-signature`: an HMAC-SHA256 of
  `id.timestamp.body` under the secret, compared with WebCrypto's `verify` in constant time,
  within five minutes of now. Several `v1,` signatures may come at once, as from a sender
  rotating its secret. A sender that makes its own secret and signs with it, as a Gateweave
  Track webhook does, is pasted in place of the trigger's ("Use the sender's secret").
- **The gateway is the only public way in.** `POST /api/triggers/<workspace id>/<trigger id>`
  counts each client's posts in the isolate, caps the body at 64 KB while reading it, requires
  the three headers, and checks in D1 that the workspace exists before it reaches the registry,
  so no registry is made for a made-up id. Only then does the registry check the signature: the
  gateway trusts nothing about the sender, and a member's session plays no part.
- **One run per event.** The registry keeps each delivery by its `webhook-id` for seven days
  (`trigger_deliveries`). A retry of one that started a run or was skipped gets `202` with that
  run and starts nothing. A retry while its run is starting gets `409` with `Retry-After`, since
  that run may yet fail to begin. One that was over a limit or could not begin is taken again;
  one left starting for a minute, as when the Worker stopped in between, too.
- **Limits.** A trigger starts at most 10 runs a minute and its own number a day (50 unless set,
  up to 1,000), counting the runs that began and those about to, in the write that admits the
  delivery. Past either, the sender gets `429` with `Retry-After`. A workspace has at most 50
  triggers. A paused trigger answers `202` and starts nothing.
- **Event types.** A trigger may be limited to some event types, by the `type` in the event's
  body (`triggers.events`, up to 20, null for every event). An event of another type, or with
  none, answers `202`, starts nothing, and shows as skipped with why, so a sender set to send more
  than the job needs costs no runs. Like a paused trigger's, a skipped event stays skipped when
  its sender retries it.
- **Its own conversation.** An admitted delivery opens a conversation for its run alone, started
  by `trigger:<id>` rather than a member (`conversations.trigger_id`), titled after the trigger
  and the event's `type`. The gateway then calls `triggerTurn` on its `ConversationAgent` over
  RPC, which asks the registry to begin the run (`beginTriggerTurn`) and stays awake until the
  turn ends, as a report's does. The message is the prompt, with each `{{path}}` filled in from
  the event's JSON, and the event after it. A team's trigger starts the lead with the team's
  edges, like a person's message to the team.
- **Nobody's conversation.** No member lists it, opens it in Chat or goes on with it, and
  `beginTurn` refuses it. Its runs (`runs.trigger_id`, nested ones too) belong to the trigger, so
  owners and admins see them and members do not, and the run's page shows its conversation,
  which the server reads from the Durable Object for that page alone.
- **What came lately** shows under each trigger: its last ten deliveries, whether each started a
  run, was skipped, went over a limit or failed, and why.
- **Deleting a trigger** deletes its deliveries; the conversations and runs it started stay. A
  team's triggers go with the team.

### Track triage

The first agent made for a Gateweave product triages new issues in Gateweave Track, set up by an
owner or admin in one dialog on the Agents page ([docs/track-triage.md](track-triage.md)). The
names, the prompt and the tools are in `packages/model/src/track-triage.ts`, the setup in
`packages/registry/src/track-triage.ts`, and the instructions the agent follows in
`apps/web/src/server/track-triage.md`.

- **The key is tried first.** The server function (`apps/web/src/lib/track-triage.ts`) checks
  Track's MCP server with the agent member's key (`gwt_` and 43 characters) and needs the five
  tools triage uses, before the registry makes anything. The check is kept as the server's last
  one, so the MCP page lists its tools at once.
- **One write makes it all:** the instructions, an environment set whose secret
  `TRACK_AGENT_KEY` holds the key, Track's MCP server with `Authorization: Bearer
  ${TRACK_AGENT_KEY}`, the agent pinning all three, and a trigger for it on `issue.created` only,
  50 runs a day. The key
  and the trigger's secret are sealed before the write, the workspace's trigger limit is checked
  before anything is inserted, and a refusal after that throws, so a failure leaves nothing half
  made. A name already in the library gets a number (`track 2`).
- **Track makes the webhook's secret.** The trigger's own is never shown: the dialog's second
  step gives the URL to add in Track and takes the secret Track shows, as "Use the sender's
  secret" does. The webhook names the agent member under "For agent", so Track leaves the
  agent's own changes out and it never triggers itself.
- **Least privilege.** The agent pins Track's server with a tool allowlist of `get_workspace`,
  `get_issue`, `search_issues`, `update_issue` and `add_comment`. An issue is text anyone in the
  Track workspace wrote: the instructions say to read it as data, and the allowlist is what holds
  if a model is talked into more.

## The CLI

`@gateweave/agents` (`packages/cli`) applies a setup kept as files to a working tree, and checks
that a working tree still holds it, for CI. It reads a setup folder with `readSetupFolder`, writes
it with `writeAssets` and plans it with `planApply`, like the app, so a file the CLI writes is the
file the pull request would.

- **The working tree stands in for the repository's tree.** Only the paths the setup writes and
  the folders above them are looked at, with `lstat`, so a symlink is never followed and a
  symlink, file or folder in the way is left alone and reported, as a pull request would leave it.
- **Text is compared in LF.** The CLI writes LF, and reads a checkout's CRLF as LF, so a Windows
  checkout does not look changed.
- **`check` fails on what `apply` would write**: exit code 1 lists each file as missing or
  differing. Paths it would leave alone are warnings, not failures.
- **One file, no dependencies.** Vite bundles the CLI, the workspace packages it uses and the
  ready-made setups into `dist/main.js`, so a version always writes the same files.

## Pages

The workspace's pages read the registry through server functions in `apps/web/src/lib/registry.ts`,
each of which checks membership first, so a non-member gets the same "not found" as a missing
workspace.

- **Overview** counts what the registry holds and shows a matrix of repositories by the coding
  agents each one configures, with each repository's drift.
- **Projects** group repositories, and a project's page shows the same matrix for its
  repositories and the agents in them. Owners and admins create, edit and delete projects and
  choose their repositories; everyone else in the workspace sees them.
- **Repositories** lists them with their scan status and drift; a repository's page shows its
  agents, the assets they read grouped by kind, the problems the last scan found, the setups
  merged into it with their drift, and the pull requests that applied them.
- **Agents** lists every agent and subagent by runtime, and owners and admins define agents run
  by Gateweave there. An agent's page shows where a coding agent is configured and what it reads,
  or how an agent run by Gateweave works: its model, whether the workspace has a key for it, its
  pinned instructions with their text, its environment set and its MCP servers, with "Only: …"
  under a server the agent is limited to some tools of. Owners and admins also see its triggers
  there, as they do on a team's page, and set up the ready-made agents below the list, such as
  [Track triage](#track-triage).
- **Teams** lists the teams with their leads. A team's page draws its graph top-down from the
  lead (`apps/web/src/lib/team-layout.ts`, inline SVG, no graph library): each member one row
  below the nearest member that reaches it, every kind of edge in its own color and dashes. Below
  the drawing, its members and its edges are lists, which is what a screen reader reads. Owners
  and admins create teams, add and take out members, choose the lead and add and remove edges;
  members see them.
- **Chat** lists the caller's own conversations, the latest first, and starts one with any
  agent run by Gateweave or any team. A conversation's page streams the reply, can stop it, and
  says when the agent cannot answer and why. Agent and team pages have a Chat button too.
  - **Tool calls** show under the reply that made them. The conversation stores every call as a
    static part named after its tool, while the live stream calls MCP tools dynamic, so the chat
    reads both (`apps/web/src/lib/tool-calls.ts`).
  - **A conversation with a team** has the team drawn beside it, shrunk to fit, as on the team's
    page. Its members light up while they work: the page asks the registry for the conversation's
    runs still going (`activeRuns`) while a turn runs, and for as long as any is left, as after a
    report. An agent working inside a member team lights that team. Narrower screens open the team
    over the conversation with a button.
  - **Each call over an edge** shows as its kind and the member it went to, read back from the
    tool's name with the team's member names (`readEdgeToolName` in the model package, next to the
    naming the runtime uses).
- **Runs** lists the runs people's messages and triggers started, the latest first, fifty at a time
  (`apps/web/src/lib/runs.ts`): owners and admins see everyone's, since they answer for what runs
  spend, and members see their own. Each shows its total: the tokens and cost of the run and of
  every run its team's edges led to, added up from the runs of the same message. A run's page
  shows its summary, that total, and its trace as a timeline of connections, model requests, tool
  calls and calls over a team's edges. Each call shows the run it started inside the timeline,
  which opens to that run's own trace there, fetched when opened, or on its own page. The page
  links the conversation only for the member who started it; a nested run links the run that
  called it, and a trigger's run shows its conversation on the page. The Overview sums the last 30 days of runs, nested ones included.
- **Environment** lists the environment sets with their variables, their secrets as set or
  missing (never a value), values kept for names that are no longer secrets, and the agents that
  run with each. Members see all of it; owners and admins create and edit sets and set, replace
  and remove values.
- **MCP** lists the library's MCP servers: transport and URL (or why an agent cannot reach it, with
  local commands marked unavailable until cloud runners), the variables its headers need, the
  agents that pin it with their versions, and its last check with the tools it listed. Members see
  all of it; owners and admins get a Check button per remote server.
- **Library** lists the library's assets by kind, with how many repository assets carry one of
  their versions and how many of those are behind. Owners and admins write instructions, prompts
  and skills there, and add MCP servers.
- **Setups** lists them with how many assets each pins and how many have updates, and below them
  the ready-made setups, which an owner or admin adds to the workspace in one click; a setup's page
  shows its pins, moves one to the latest version, previews the files it writes, applies it to a
  repository, shows the drift of each repository it was merged into, and lists its pull requests.
- **An asset's page** shows the text of each of its files and every earlier version. For a
  repository asset it also shows the agents that read it, the library assets it matches, and how
  many other assets have the same content; for a library asset, the agents that pin it and the
  repository assets that use it. A library MCP server has "Edit settings" instead of editing its
  text.
  An asset with two versions or more offers "Compare versions": any two, as a line diff per file
  (added, removed and changed files). The server function computes it with `diffLines` from the
  `diff` package, imported inside the handler so it stays out of the browser bundle. A file whose
  text is not kept shows only that it changed.

Pages refresh themselves while a scan of what they show is waiting or running.

**Settings** has the workspace's members and invitations, its GitHub connection and its model
provider keys.

## What comes next

- **Publishing the CLI** to npm as `@gateweave/agents`, so CI can run `npx @gateweave/agents
  check`. It is built and tested here, and stays private until then.
- **More agents in Gateweave products** (phase 4 in `docs/spec.md`, AGT-8), after
  [Track triage](#track-triage).
- **Workers AI on Gateweave Cloud** (AGT-36 shipped it for self-hosted servers). It stays off in
  Cloud's production until Cloud meters its runs per workspace, since the deployment pays for
  them.
- **Cloud runners** (phase 5, AGT-9), after sandboxes (AGT-40), a repository in them (AGT-41) and
  pull requests from them (AGT-42): runs on a schedule or a label (AGT-43), the vendors' own coding CLIs (AGT-44), and metering each workspace's sandbox
  time before Cloud's production offers them (AGT-45). Sandboxes will also run the MCP servers
  that are local commands.

## Deploys

`main` deploys to staging after CI passes, and a published GitHub release deploys production
(`.github/workflows/deploy.yml`). D1 migrations are applied before the new code goes live.
