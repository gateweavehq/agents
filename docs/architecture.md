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
Models settings page.

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
- **Each turn connects anew** (`packages/runtime/src/tools.ts`). `beginTurn` reads the agent's
  servers with the agent, before anything awaits, and returns each with its headers' values filled
  in from the opened environment set, in memory for that turn like the key. A server whose
  variables are not all there is left out, with which ones. The runtime connects to the rest at
  once with `@ai-sdk/mcp`, ten seconds each to connect and list their tools, and closes every
  connection when the turn ends. It does not use the Agents SDK's `addMcpServer`, which would
  keep the headers, secrets included, in the conversation's SQLite.
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
  that gateway with the workspace's key, and `cf-aig-metadata` names the workspace, agent and
  conversation so its logs and analytics split by workspace. `AI_GATEWAY_TOKEN` is for an
  authenticated gateway. The gateway is reached by URL rather than through an `ai` binding,
  because the binding always calls Cloudflare: local development and the tests would need a
  Cloudflare login. Without the setting, requests go straight to the provider.
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
  offers, and so is each tool call, under the model request that made it, with the sizes of its
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
  pinned instructions with their text, its environment set and its MCP servers.
- **Chat** lists the caller's own conversations, the latest first, and starts one with any
  agent run by Gateweave. A conversation's page streams the reply, can stop it, and says when the
  agent cannot answer and why. An agent's page has a Chat button too.
- **Runs** lists runs, the latest first, fifty at a time (`apps/web/src/lib/runs.ts`): owners
  and admins see everyone's, since they answer for what runs spend, and members see their own. A
  run's page shows its summary and its trace as a timeline of connections, model requests and
  tool calls, and links the conversation only for the member who started it. The Overview sums
  the last 30 days of runs.
- **Environment** lists the environment sets with their variables, their secrets as set or
  missing (never a value), values kept for names that are no longer secrets, and the agents that
  run with each. Members see all of it; owners and admins create and edit sets and set, replace
  and remove values.
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
- **The rest of the runtime** (phase 3 in `docs/spec.md`): the MCP page, with each server's
  tools and health (AGT-32), and teams (AGT-27).

## Deploys

`main` deploys to staging after CI passes, and a published GitHub release deploys production
(`.github/workflows/deploy.yml`). D1 migrations are applied before the new code goes live.
