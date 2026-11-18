# Changelog

Notable changes to Gateweave Agents, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/agents/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

## [0.29.0] - 2026-11-18

Library assets are easier to reuse in a coding agent, and a sign-in redirect stays on this site
even when its path contains dot segments. There is no migration in this release.

### Added

- **Copy the text of a library asset.** A stored prompt has a Copy prompt button, a Markdown file
  has Copy Markdown, and another stored text file has Copy file. An asset without stored content
  has no copy action. A failed clipboard write tells the person to select the visible text.
  ([#268](https://github.com/gateweavehq/agents/pull/268))

### Fixed

- **Sign-in cannot return to another site through a resolved path.** A path whose dot segments
  become `//example.com` or `/\\example.com` is refused after resolution. Ordinary same-site
  parent segments still work.
  ([#266](https://github.com/gateweavehq/agents/pull/266))

### If you run your own

- **Update.** No database migration or new environment variable is required.

## [0.28.3] - 2026-11-18

Cloudflare removes sixteen Workers AI models on 20 November 2026: Agents stops offering them and
says so when an agent still set to one runs. There is no migration in this release.

### Fixed

- **No list offers a Workers AI model that Cloudflare is removing.** The agent dialog, Connect
  Track and Settings › Models leave out the sixteen models that stop answering on 20 November
  2026, among them `@cf/moonshotai/kimi-k2.6`, which the triage guide recommended, and
  `@cf/qwen/qwen3-30b-a3b-fp8`. Work on Track issues now starts from
  `@cf/deepseek-ai/deepseek-v4.1-flash-1017` when the provider is Workers AI.
  ([#263](https://github.com/gateweavehq/agents/pull/263))
- **An agent whose model was removed says what happened.** Its run used to end with "Workers AI
  could not answer." It now says that Cloudflare removed the model and to choose another in the
  agent's settings. ([#263](https://github.com/gateweavehq/agents/pull/263))
- **A run's trace names the agent a turn was delegated to**, where it printed the agent's id.
  ([#262](https://github.com/gateweavehq/agents/pull/262))
- **A turn shows as running from the moment it is sent.** While a sandbox started, the chat looked
  idle and had no Stop button, and a stop pressed in those seconds was not heard. It now stops the
  turn. ([#262](https://github.com/gateweavehq/agents/pull/262))
- **The audit log's sentence for a pin move names both versions.**
  ([#262](https://github.com/gateweavehq/agents/pull/262))

### Changed

- **The ready-made Gateweave Mail setup's skill** follows Mail 0.2.0, where an agent sends on its
  own unless an owner or admin chooses a list or approval for everything, and gains the section on
  templates. A workspace that already added the setup keeps the skill it has until it adds the
  setup again. ([#264](https://github.com/gateweavehq/agents/pull/264))

### If you run your own

- **Change agents that run on a removed model before 20 November 2026.** The removed models are
  `@cf/moonshotai/kimi-k2.6`, `@cf/moonshotai/kimi-k2.7-code`, `@cf/zai-org/glm-5.2`,
  `@cf/zai-org/glm-5.3-flash`, `@cf/deepseek-ai/deepseek-v4-flash-0731`,
  `@cf/deepseek-ai/deepseek-v4-pro-0813`, `@cf/nvidia/nemotron-3-120b-a12b`,
  `@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/qwen/qwq-32b` and seven older ones
  ([the full list](https://developers.cloudflare.com/changelog/post/2026-11-05-planned-model-deprecations/)).
  Agents does not change an agent's model for you, because prices differ: open the agent under
  **Agents**, choose **Edit**, and pick another model.
- Until that day a run on Kimi K2.6 or Qwen3 30B still works, and still counts toward
  `WORKERS_AI_DAILY_DOLLARS`.

### Internal

- An agent's setting for working on files without a sandbox, kept dark.
  ([#259](https://github.com/gateweavehq/agents/pull/259))

## [0.28.2] - 2026-11-16

Fixes "Use vN" on an agent's page, which reset the agent's engine and memory. There is no
migration in this release.

### Fixed

- **Moving a pin to its latest version no longer resets the agent's engine and memory.** "Use vN"
  on an agent's page saved the whole agent from a list of fields that left out the engine and
  memory, so an agent running on Claude Code, Codex or OpenCode went back to Gateweave's own loop
  and its memory was turned off, without a word. Moving a pin is now its own call, which names the
  asset and the version and changes nothing else. Open pages keep the old behaviour until they are
  reloaded. ([#260](https://github.com/gateweavehq/agents/pull/260))

### Changed

- **The audit log says which pin moved.** Its entry names the asset and the two versions, where it
  used to list the fields of a whole save.
  ([#260](https://github.com/gateweavehq/agents/pull/260))

### If you run your own

- **Check agents whose pins were moved from the agent's page.** An agent with a sandbox that should
  run on Claude Code, Codex or OpenCode, or with memory on, may have been reset: open it and look
  at its engine and memory. In Settings › Audit log such a change reads as an agent updated with
  the engine or memory among its fields, at the time a pin was moved.
- **Reload open pages after updating.**

### Internal

- Two pieces for running an agent on a repository's files without a sandbox, which nothing uses
  yet: reading a tree and a file and making a commit through GitHub's API
  ([#257](https://github.com/gateweavehq/agents/pull/257)), and a store for those files in the
  conversation's own storage ([#258](https://github.com/gateweavehq/agents/pull/258)).

## [0.28.1] - 2026-11-16

Puts back a guard that v0.28.0 dropped by mistake, and lets the schema generator run again.
There is no migration in this release.

### Fixed

- **A server function's request from another origin is refused again.** The framework refuses
  such a request unless the browser says it comes from the app's own origin. v0.28.0 added a file
  that replaced the framework's default without listing that guard, so for some hours it did not
  run. The session cookie is `SameSite=Lax`, which browsers keep off another site's `POST`
  requests, and everything that changes something is a `POST`, so a page on an unrelated site
  could not act as a signed-in person in such a browser. A page on another host of the same site (another
  subdomain of the deployment's domain) could have, for what a workspace's pages change.
  ([#254](https://github.com/gateweavehq/agents/pull/254))
- **`pnpm auth:schema` runs again.** Since v0.28.0 it stopped with "Drizzle's session cannot be
  reached". Only this developer command was affected.
  ([#253](https://github.com/gateweavehq/agents/pull/253))

### If you run your own

- **If you run v0.28.0, update.**

## [0.28.0] - 2026-11-16

A server no longer needs a `SECRETS_KEY` set by hand before workspaces can keep their keys, and a
database failure no longer shows or logs a statement's values. There is no migration in this
release. **If you run your own server without a `SECRETS_KEY`, read the last section before
updating: this release turns secret storage on for it.**

### Added

- **Secrets without a `SECRETS_KEY`.** A server with no `SECRETS_KEY` refused to keep a model
  key, an environment secret or a GitLab token, which made adding one in the dashboard the first
  hand step after the Deploy button. Such a server now encrypts under a key made from
  `BETTER_AUTH_SECRET`, when that secret is at least 32 characters and varied enough. A
  `SECRETS_KEY` that is set is always the one used. Once one is set, values kept without it are
  encrypted again under it as they are next used.
  ([#250](https://github.com/gateweavehq/agents/pull/250))
- **From zero to a first pull request.** A page in the docs walks from the Deploy button to an
  agent's first pull request, with what each step needs and the times that were measured.
  ([#250](https://github.com/gateweavehq/agents/pull/250))

### Changed

- **A `SECRETS_KEY` that goes missing is named.** A workspace holding values encrypted with a
  `SECRETS_KEY` the server no longer has keeps nothing new and says that the key is missing,
  instead of asking for each value again. Putting the key back restores them.
  ([#250](https://github.com/gateweavehq/agents/pull/250))

### Fixed

- **A failed database query no longer carries its values.** When a query failed for good, the
  error held the statement and its values. A failed read of a session was logged with the
  session's token among them, and a failed read for a page showed them on the error page. The
  token alone does not sign anyone in: the cookie also carries a signature made with the
  server's secret. A failure now carries a reference only. The log has the kind of failure and
  the statement without its values under the same reference, and the page shows a plain sentence
  with it. To see whether a server ever logged one, search its logs for `Failed query:`.
  ([#249](https://github.com/gateweavehq/agents/pull/249))

### If you run your own

- **Without a `SECRETS_KEY`, this release turns secret storage on**, if your
  `BETTER_AUTH_SECRET` is long and varied enough. One secret then both signs sessions and opens
  what workspaces stored, and changing it makes all of that unreadable. Set a `SECRETS_KEY` for
  anything beyond a first try, or set `SECRETS_FROM_AUTH_SECRET=off` to keep storage off as
  before. [Self-hosting](docs/self-hosting.md#the-key-that-encrypts-workspaces-secrets) has both.
- **With a `SECRETS_KEY`, nothing to do.**

## [0.27.2] - 2026-11-15

A run that is still going opens on the first click, and a database read that fails in passing is
asked again instead of becoming an error page. There is no migration in this release.

### Fixed

- **Opening a run while it is still going.** A run that has not ended shows how long it has taken
  so far, read from the clock. The server and the browser read it at different moments, the page
  took the difference for a fault and drew itself again, and a click on a run in that moment
  opened nothing. The Runs page and a run's own page now keep what the server sent.
  ([#247](https://github.com/gateweavehq/agents/pull/247))
- **A page failing because one database read did.** When a single read from D1 failed, the page
  was an error although asking again would have worked. A plain read (one `SELECT` statement,
  which is what the app's pages send) that fails with one of the errors Cloudflare documents as
  passing is now sent up to three times, a moment apart. Everything else is sent once, as before:
  writes, a read that begins with `WITH`, several statements in one, and any other error. Each
  resend is logged by the kind of failure, never with the database's own message.
  ([#245](https://github.com/gateweavehq/agents/pull/245))

### If you run your own

- **Nothing to do.**

## [0.27.1] - 2026-11-15

An invitation's buttons no longer do nothing when pressed early. There is no migration in this
release.

### Fixed

- **Joining by an invitation on a slow connection.** Join, Decline and Switch account on the
  invitation page, and "Email me a link", work only once the page's script has run, but they
  looked ready before that. Pressed then, they did nothing and said nothing, and the person
  stayed on the invitation. They are now disabled until the page is ready, as the buttons on the
  sign-in page already were.
  ([#241](https://github.com/gateweavehq/agents/pull/241))

### If you run your own

- **Nothing to do.**

## [0.27.0] - 2026-11-15

Agents can keep notes between runs. A workspace has a memory that its people can read and
correct, and an agent with the Memory switch on can add to it and look things up. This release has
two migrations, in each workspace's own registry, which apply themselves.

### Added

- **Memory.** A workspace keeps short notes: facts, decisions and preferences, each with who or
  what wrote it, in which run, and when. An agent on the Gateweave engine with the new Memory
  switch on gets three tools: `remember`, `recall` (by keyword, in any language) and `forget`
  (only what it wrote itself). The switch is off for every existing agent. The new Memory page
  lists the notes with search and filters; every member can read them, and owners and admins can
  add, edit and delete them. ([#239](https://github.com/gateweavehq/agents/pull/239))
- **Notes from outside wait for a person.** An agent reads what outsiders wrote: an issue, a
  web page, a trigger's event. So what it notes is used at once only when a person's chat
  message started the run and the agent filed the note as its own or as about that person (the
  note's scope, which the agent chooses; what the text says is not judged). Anything it files
  under the workspace or a repository, and anything from a run a trigger started, waits
  on the Memory page until an owner or admin approves or dismisses it, and no agent recalls it
  before that. Recalled notes are handed to the model as notes with their source, never as
  instructions. ([#239](https://github.com/gateweavehq/agents/pull/239))

### Changed

- **The README opens with what it does for you**: assign an issue to an agent, get a pull
  request back, with a frame of one real run that links to its recording.
  ([#238](https://github.com/gateweavehq/agents/pull/238))

### If you run your own

- **Nothing to do** beyond updating. The registry's migrations (`0039` and `0040`, the notes and
  their search index) apply themselves when a workspace is next used. Notes are text in the
  workspace's own storage: no vector index and no new binding. What an agent notes in a chat is
  readable by every member of the workspace, which the agent form and the Memory page say.
  Deleting an account removes the notes filed as about that person and those agents wrote in
  that person's runs. It does not remove a note someone else wrote about the workspace that
  happens to name them: an owner or admin deletes those on the Memory page. The audit log keeps
  the first 80 characters of a note from when it was added and from each edit, except for notes
  filed as about a person, of which it keeps no text.

## [0.26.0] - 2026-11-15

Gateweave Track is connected in one step: choose what the agent is, approve it in Track, and it
is ready. No key or secret is copied by hand. This release has one migration, in each
workspace's own registry, which applies itself.

### Added

- **Connect Track in one step.** "Triage Track issues" and "Work on Track issues" used to take
  seven steps across the two products, with an agent's key and a webhook's secret copied between
  tabs. Now you choose the model (and, for work, the repository and the engine), press Connect
  Track, and approve in Track, where you pick the workspace and the team. Track makes the agent
  member and its webhook and hands their key and secret to this server alone, so neither is ever
  shown, typed or in an address. The agent, its Track tools and its trigger are then made
  together. Saying no in Track makes nothing. If anything fails after Track has made its part,
  this server asks Track to take it back, and when it cannot, it says exactly what may be left
  there and where to remove it. Only an owner or admin can connect, the approval is good for ten
  minutes and for the person who started it, and the audit log records the connection. It needs
  Gateweave Track 0.39.0 or later; for an older Track, "Set it up by hand" is the way it was.
  ([#236](https://github.com/gateweavehq/agents/pull/236))

### If you run your own

- **Nothing to do** beyond updating. The registry's migration (`0038`, an empty table for
  connections waiting to be approved) applies itself when a workspace is next used. The dialog
  starts with Gateweave Cloud's Track; for a Track you run, open "Another Track" and give its
  address.

## [0.25.1] - 2026-11-14

A run that a trigger started is readable: the event it came from is a card, not a wall of JSON.
There is no migration in this release.

### Fixed

- **A trigger's message is shown as an event.** A run started by a webhook or a schedule used to
  open with the trigger's prompt as if a person had written it: the whole event on one line, a
  code fence as plain characters, and long values running out of the bubble and off the page. It
  is now a card that says what was sent and by whom, with the issue as a link for a Gateweave
  Track event, and the event itself formatted in a closed section that scrolls. What the agent is
  told has not changed. Conversations from before this release are shown the same way.
  ([#233](https://github.com/gateweavehq/agents/pull/233))
- **Tool calls say what they acted on:** `read_file docs/roadmap.md`, not `read_file` six times.
  An argument that looks like a credential is never shown. A command shows only its program and,
  for a build tool or git, the one known word after it (`pnpm check`, `git status`), never what
  it was given: no pattern can tell a password from any other word.
  ([#233](https://github.com/gateweavehq/agents/pull/233),
  [#235](https://github.com/gateweavehq/agents/pull/235))
- **Links in messages** open only `http` and `https` addresses, and nothing in a message can
  widen the page. ([#233](https://github.com/gateweavehq/agents/pull/233))

### If you run your own

- **Nothing to do.**

## [0.25.0] - 2026-11-14

The public demo opens with a progress screen instead of a still login page, and its banner is now
a bar at the bottom. There is no migration in this release.

### Added

- **The demo shows what it is doing while it opens.** It takes about seven seconds to make a
  visitor's workspace, and the login page used to stay still the whole time. A screen now lists the
  real steps in order: a private account, the Acme workspace, three sample repositories, a team of
  three agents, their past conversations, and opening it on this device. The last two finish only
  when the server answers and the overview has rendered. It has a "Try again" when something
  fails, and honours reduced motion.
- **A demo bar and a welcome card.** The bar at the bottom says how long until the sandbox is
  deleted, starts over, and links to Gateweave Cloud, the repository and the self-hosting guide;
  it can be hidden for the tab. A card on the first visit suggests three things to try. Like the
  rest of the demo, both appear only when `AGENTS_DEMO` is `"1"`.
  ([#231](https://github.com/gateweavehq/agents/pull/231))

### Fixed

- **The overview no longer scrolls sideways on a phone.** The screen-reader text in the runtime
  table's cells widened the page to 849 px.
  ([#231](https://github.com/gateweavehq/agents/pull/231))

### Changed

- Dependencies updated, with Vitest held at 5.0.5.
  ([#227](https://github.com/gateweavehq/agents/pull/227),
  [#230](https://github.com/gateweavehq/agents/pull/230))

### If you run your own

- **Nothing to do.**

## [0.24.0] - 2026-11-13

Gateweave Agents has a public demo, and Gateweave Cloud's Worker runs near its databases in the
EU. There is no migration in this release.

### Added

- **A public demo** at [agents-demo.gateweave.com](https://agents-demo.gateweave.com). "Open the
  demo" gives each visitor a private workspace named Acme: three sample repositories with the
  coding agents a scan finds in them, a library, a setup with real drift, a wiki, a team of three
  agents and past runs with their traces. Agents answer from a script, never a model, and the chat
  says so. Email, keys, secrets, sandboxes, webhooks, triggers and sign-in are off. A sandbox is
  deleted after a day, and starts are limited per network. All of it stays off unless
  `AGENTS_DEMO` is `"1"`, which only Gateweave's `demo` environment sets.
  ([#226](https://github.com/gateweavehq/agents/pull/226))

### Changed

- **Gateweave Cloud runs its Worker near its databases.** They are in the EU and answer from
  Frankfurt, and a page from far away made its queries across an ocean, one after another. The
  Worker now runs near Frankfurt; static files still come from the nearest data center. Track did
  the same in its 0.35.3, where opening its demo from the US took 14 seconds instead of 23.
  ([#228](https://github.com/gateweavehq/agents/pull/228))

### If you run your own

- **Nothing to do.** Leave `AGENTS_DEMO` unset. If your database is far from your team,
  `docs/self-hosting.md` ("Keeping data in one jurisdiction") now says how to run the Worker near
  it.

## [0.23.0] - 2026-11-13

A server can now keep every workspace in one of Cloudflare's jurisdictions, and Gateweave Cloud
keeps its workspaces in the EU. This release has one D1 migration.

### Added

- **Workspaces in a jurisdiction.** Set `DURABLE_OBJECT_JURISDICTION` (such as `eu`) and each
  workspace's registry and conversations, with their chats, runs, traces and sealed keys, are kept
  in that jurisdiction, as are the sandboxes' Durable Objects, the sandbox meter and the rate
  limits. New workspaces are made there. The daily run moves older ones, three at a time: each is
  paused for a few seconds while its objects are copied and checked (ten minutes at most, should a
  move die half way), and one with a turn or a wiki under way waits for the next day. The copies it leaves behind are sealed and kept until the
  workspace is deleted. Sandboxes' containers are not bound by it: Cloudflare starts them wherever
  it has capacity. See "Keeping data in one jurisdiction" in `docs/self-hosting.md`.
  ([#223](https://github.com/gateweavehq/agents/pull/223), [#224](https://github.com/gateweavehq/agents/pull/224))

### Changed

- **Gateweave Cloud's workspaces are in the EU.** agents.gateweave.com keeps its workspaces in the
  `eu` jurisdiction, like its database since 0.22.1, and its repository wikis are written by a new
  Workflow made in the EU. Staging moved first.

### If you run your own

- **Nothing to do** unless you want a jurisdiction. The migration adds an empty table, and without
  the setting nothing moves. To keep repository wikis in the jurisdiction too, give the Workflow in
  `wrangler.jsonc` a `"jurisdiction"` and a new `name`.

## [0.22.1] - 2026-11-13

Gateweave Cloud's Agents now keeps its database in the EU. Nothing changes for a copy you run
yourself, and this release has no migration.

### Changed

- **Gateweave Cloud's database is in the EU.** agents.gateweave.com's D1 database (accounts,
  sessions, the list of workspaces) moved to one created with Cloudflare's `eu` jurisdiction, which
  guarantees where it runs and stores data. The old one was in Eastern North America. Everything was
  copied over, including what was written while the release deployed. Staging moved first.
  Workspaces' registries and conversations live in Durable Objects, which move separately.
  ([#220](https://github.com/gateweavehq/agents/pull/220), [#221](https://github.com/gateweavehq/agents/pull/221))

### If you run your own

- **Nothing to do.** The top level of `wrangler.jsonc`, which is what you deploy, is as it was; only
  the `cloud` and `staging` environments changed.

## [0.22.0] - 2026-11-13

Admins can now see who changed their workspace, and when. This release has one D1 migration.

### Added

- **Audit log.** Settings has a new Audit log page for owners and admins. It lists who invited,
  removed or promoted whom and who joined or left; who saved or removed a model key, set or removed
  a secret (by name, never its value) or changed an environment set or telemetry; who connected or
  disconnected GitHub, GitLab or an MCP server, and who changed a trigger or set up Track triage
  or Track work; who created, changed or deleted an agent, a team or a setup, and who had a setup
  open a pull request; and who deleted a project or a library asset. The newest come first. It
  names people as the server knows them now, so someone who deleted their account appears as
  "Deleted member". Entries are kept for a year. Chats, scans and runs are not in it.
  ([#218](https://github.com/gateweavehq/agents/pull/218))

### If you run your own

- **`pnpm run deploy` applies the migration** (`0011_audit_log`) before the new code goes live.
- The log holds the addresses invitations went to, for a year, and forgets one when that person
  deletes their account. If your privacy policy lists what Agents keeps, add it; see Audit log in
  `docs/architecture.md`.

## [0.21.0] - 2026-11-12

A backup Worker in the same Cloudflare account can now back up every workspace's registry and
conversations. There is no migration in this release, and nothing changes until such a Worker binds
to it.

### Added

- **A way in for backups.** D1 can be backed up from outside the Worker, but a workspace's registry
  and its conversations live in Durable Objects only the Worker's own code can read. The Worker now
  exports a named entrypoint, `Backup`, for a backup Worker such as Gateweave Backup's. It lists each
  workspace's registry and conversations, and runs a SQLite dump's reads in one, inside a
  transaction it always rolls back, so a backup sees one moment and can change nothing. It reads
  only what D1 and the registry still list, so a deleted conversation is never woken. It has no
  route: only a Worker in the same account with a service binding to it can call it.
  ([#216](https://github.com/gateweavehq/agents/pull/216))

### If you run your own

- **To back up your workspaces,** bind a backup Worker to the entrypoint
  (`"services": [{ "binding": "AGENTS_APP", "service": "<your Worker>", "entrypoint": "Backup" }]`);
  see Backups in `docs/self-hosting.md`. The copies hold people's conversations with agents: keep
  them as you keep the database.

## [0.20.0] - 2026-11-12

AI agents can ask a repository's wiki a question over MCP, at no cost to the workspace. There is no
migration in this release.

### Added

- **`ask_wiki_question`.** It takes DeepWiki's arguments: a repository, or a list of up to 10, and a
  question. It answers with the pages of their wikis that bear on the question, best first. No model
  runs on the server: the agent that asks reads the pages and answers, so a question needs no key
  and costs the workspace nothing. ([#212](https://github.com/gateweavehq/agents/pull/212))
- **`list_wiki_repos`.** It lists the repositories with a wiki in your workspaces, with how many
  pages each has and the commit it was written from.
  ([#212](https://github.com/gateweavehq/agents/pull/212))

### If you run your own

- **Nothing to do for this release.**

## [0.19.0] - 2026-11-12

A wiki of each repository, written with the workspace's own model key, and an MCP endpoint that AI
agents sign in to with OAuth to read it, with the tools DeepWiki has. This release has one D1
migration and one Durable Object migration.

### Added

- **Repository wikis.** An owner or admin has a wiki written for any repository the workspace
  connects, private ones included, on the new **Wiki** page or from a repository's page. They choose
  a model from a provider the workspace has a key for. Every member reads it: numbered pages with
  the source files each was written from, citations linked to those lines at the commit, and the
  model, tokens and estimated cost. `.devin/wiki.json` steers it as it steers DeepWiki. Writing again
  keeps the current wiki readable until the new one is done, and a wiki that can't be written says
  why. ([#210](https://github.com/gateweavehq/agents/pull/210))
- **An MCP endpoint for AI agents.** `/mcp` lets an AI agent work with Agents as the person who
  connected it. It signs in with OAuth, and the person approves it on a consent page. Its tools
  only read: `list_workspaces`, and `read_wiki_structure` and `read_wiki_contents`, which keep
  DeepWiki's names, arguments and answers. An agent set up for DeepWiki's MCP server reads a
  workspace's wikis unchanged. It never takes a browser's session cookie.
  ([#208](https://github.com/gateweavehq/agents/pull/208),
  [#210](https://github.com/gateweavehq/agents/pull/210))

### If you run your own

- **Deploying creates the wiki Workflow**, `gateweave-agents-wiki`, and applies D1 migration `0010`
  for the OAuth server. The workspace registries add their wiki tables when each one wakes.
- **`/mcp` needs `BETTER_AUTH_URL`.** Tokens are bound to one address, so without it `/mcp` answers
  404 and nothing else changes.
- **The workspace slugs `mcp` and `oauth` are now reserved**, so no new workspace takes them. The
  new routes would hide pages of a workspace that already has one, so check before you update:
  `SELECT slug FROM organization WHERE slug IN ('mcp', 'oauth')` on the D1 database.
- **Model usage stays the workspace's.** A wiki costs the workspace one model request to plan it and
  one per page, with its own key.

## [0.18.0] - 2026-11-11

The account that runs a server can now close sign-up and keep a list of who may make an account.
This release has four migrations, and nothing changes on a server until its owner changes it.

### Added

- **Sign-up by invitation, with a list.** The account that runs the server sees a section, **This
  server**, on its account page. Choosing **By invitation** there lets in only addresses on the
  owner's list (`ada@example.com`) or at a domain on it (`@example.com`, which covers that domain and
  not its subdomains), addresses with a pending invitation to a workspace, and, where the owner turns
  on **Trust**, anyone who signs in through the server's OpenID Connect provider. GitHub is never
  trusted that way. Everyone else is told the same words, however they come and whether or not the
  address has an account. The list holds up to 5,000 entries with notes, shows whether an account
  exists yet for each, and changing anything needs a sign-in from the last day. A trigger in D1 holds
  the same rule for any path that makes an account. ([#205](https://github.com/gateweavehq/agents/pull/205))
- **Ask for access.** If `SIGN_UP_REQUEST_URL` is set to an https address, the sign-in pages link to
  it as "Ask for access" while sign-up is by invitation. Gateweave Cloud points it at its waitlist.
  ([#205](https://github.com/gateweavehq/agents/pull/205))
- **A server always has an owner.** While sign-up is by invitation, the owner's account can't be
  deleted, since nobody else could open sign-up again. On an open server, deleting it passes
  ownership to the oldest account left. ([#205](https://github.com/gateweavehq/agents/pull/205))

### If you run your own

- **Nothing changes unless you change it.** An upgrade leaves a server with accounts open, with its
  oldest account as the owner. Deploying applies migrations `0006` to `0009`.
- **The list holds addresses of people who may not have an account yet.** The self-hosting guide says
  so, for your own privacy notice. ([#205](https://github.com/gateweavehq/agents/pull/205))

## [0.17.0] - 2026-11-11

A ready-made setup for Gateweave Mail, and applying a setup now merges into a repository's `.vscode/mcp.json` instead of
replacing it. There is no migration in this release.

### Added

- **A ready-made Gateweave Mail setup.** It adds Mail's skill and MCP server to a repository, for Claude Code, Codex,
  Gemini CLI, Cursor and GitHub Copilot, so their agents can read sign-up codes, wait for mail and send it. Adding it
  asks for your Mail's MCP address. The agent's key is read from `GATEWEAVE_MAIL_KEY` and never written to the
  repository. The setup has no instructions, so it leaves a repository's `AGENTS.md` and `CLAUDE.md` alone.
  ([#202](https://github.com/gateweavehq/agents/pull/202))
- **A setup can ask for an MCP server's address.** For a server that every install runs at its own address, an
  `askUrl` in `setup.json` makes the Setups page ask for it when the setup is added. The address is checked as one
  typed on the MCP page is. The CLI takes it as `--url <server>=<url>` from its next release.
  ([#202](https://github.com/gateweavehq/agents/pull/202))

### Fixed

- **Applying a setup no longer replaces `.vscode/mcp.json`.** It replaced the whole file, so the repository's other
  servers and its `inputs` were lost. Only the setup's own servers are merged in now, as in the other MCP files.
  ([#202](https://github.com/gateweavehq/agents/pull/202))

### If you run your own

- **Nothing to do for this release.**
- **CI's browser tests install Chromium alone** when Ubuntu's package mirror can't be reached.
  ([#203](https://github.com/gateweavehq/agents/pull/203))

## [0.16.6] - 2026-11-07

Whoever runs a server with no email can now help someone back in. There is no migration in this release.

### Fixed

- **A way back in without email.** Without email nobody could reset a forgotten password, and `/forgot-password` told
  them to ask whoever runs the server, who had nothing to do about it. The self-hosting guide now says how: find the
  person's `id` in a list, run one statement, and pass on the link it prints. The link works once, for an hour. Using it
  signs the person out everywhere, as a reset does with email. ([#196](https://github.com/gateweavehq/agents/pull/196))

### If you run your own

- **Nothing to do for this release.** Nothing changes on a server that sends email.
- **`CONTRIBUTING.md` now says where a newcomer can start.** ([#194](https://github.com/gateweavehq/agents/pull/194))

## [0.16.5] - 2026-11-07

People now hear by email when the tries at their password run out. There is no migration in this release.

### Security

- **An email when the tries at a password run out.** Whoever holds a copy of a session can use up the person's
  allowance, which keeps them from changing their password in settings for a while. They now get an email at the first
  refusal, saying what happened and what to do, at most once a day and only at an address they have verified. The
  refusal doesn't wait for it, and it is the same as before. ([#190](https://github.com/gateweavehq/agents/pull/190))

### If you run your own

- **Nothing to do for this release.** With no email set up, nothing changes.
- **The self-hosting guide now says where your database lives and how to choose.** A D1 database stays where it was
  made, so this is worth reading before your first deploy. ([#189](https://github.com/gateweavehq/agents/pull/189))

## [0.16.4] - 2026-11-07

Reading a session takes one trip to the database instead of two. There is no migration in this release.

### Performance

- **One query fewer each time a session is read.** Better Auth read the session, then the person, as two queries, and
  each is a trip to D1's primary from wherever the Worker runs: measured at about 19 ms from Frankfurt, 109 from
  Virginia, 240 from Tokyo and 290 from Sydney with the primary in Eastern Europe.
  ([#187](https://github.com/gateweavehq/agents/pull/187))

### If you run your own

- **Where your database lives matters more than this does.** A D1 database stays where it was created, and every read
  and write of a session goes there. Nothing to do for this release, but if your people are far from it, that is where
  the time goes.

## [0.16.3] - 2026-11-07

Tries at a password are now held per person where a session asks for one, and the account settings can end every session
at once. There is no migration in this release.

### Security

- **A stolen cookie could guess at the password from as many addresses as it could be sent from.** Better Auth counts
  per client address, at five tries a minute. Changing a password and deleting an account now also share an allowance
  per person: 10 at once, refilling over an hour, within 30 that refill over a day. Over it, they answer 429 with the
  code `TOO_MANY_PASSWORD_TRIES`, and the page says so in words. It is spent before the password is checked, so the
  right password counts too and is refused once it has gone. ([#184](https://github.com/gateweavehq/agents/pull/184))
- **"Sign out everywhere" in the account settings.** It asks for no password and ends every session of the account, this
  browser's too, because a stolen cookie may be a copy of this browser's and nobody can tell.
  ([#185](https://github.com/gateweavehq/agents/pull/185))

### If you run your own

- **Nobody can lock a person out with their address alone.** Only a request with a session for that account spends the
  allowance, and signing in is not part of it. Whoever holds the cookie can spend it, which keeps the person from
  changing their password in settings for a while. A password reset asks for no session, and signing out everywhere asks
  for no password.

## [0.16.2] - 2026-11-07

One auth route that no page uses is closed, and a test now notices when a Better Auth upgrade adds a route. There is no
migration in this release.

### Security

- **`/link-social` now answers 404.** It added another way into an account on a session alone, and no page uses it.
  Signing in goes on linking an account by itself where that is safe.
  ([#182](https://github.com/gateweavehq/agents/pull/182))
- **An upgrade can no longer open a route unnoticed.** A test lists every route that answers, and a new one fails until
  someone decides whether it stays open. ([#182](https://github.com/gateweavehq/agents/pull/182))

### If you run your own

- **If you call `/api/auth/link-social` by hand, it stops working.** Nothing in the app does.

## [0.16.1] - 2026-11-07

A chat left open stops once its person has left the workspace. There is no migration in this release, and updating is
recommended.

### Security

- **A chat left open went on working after its person left the workspace.** The check for membership ran only when the
  socket opened. Someone who left, or was removed, could go on getting answers from that tab, on the workspace's key and
  with its tools, until their session ended. Each message now needs them to still be a member, and sockets opened before
  updating are covered too. ([#180](https://github.com/gateweavehq/agents/pull/180))

### Fixed

- **A chat that can't go on now says so.** If its person was removed, the page says the conversation can no longer be
  used, puts the words back in the box and links to their workspaces. Before, the message ran its turn and the page then
  fell to "Workspace not found" with the words lost. ([#180](https://github.com/gateweavehq/agents/pull/180))
- **A chat whose socket dropped while its session ended no longer retries for ever.** A laptop that slept through it is
  the usual case. The page now asks the server why when a socket closes, and says the session ended before anyone writes
  to it. A dropped socket with nothing wrong reconnects as before.
  ([#180](https://github.com/gateweavehq/agents/pull/180))

### If you run your own

- **Nothing to set.** Each message on a chat socket already read the session from D1, and that read now also looks at
  membership.
- **`HEAD /api/chat/:slug/:conversationId` is new.** It answers whether a socket would open, with the same 401, 403 or
  404 the handshake gets, and reaches no conversation. A rule of your own in front of the Worker that allows only `GET`
  there would stop the page telling a closed chat from a dropped one.

## [0.16.0] - 2026-11-07

People can change their name and password on their account page, and a chat left open no longer loses a message when its
session ends. There is no migration in this release.

### Added

- **Your name and password on the account page.** Someone who signs in through GitHub or a sign-in provider has no
  password here, and the page says so. A name they change stays theirs: the provider's is read only when the account is
  made. ([#176](https://github.com/gateweavehq/agents/pull/176))

### Fixed

- **A chat left open lost messages once its session ended.** Changing a password in another tab was enough. The first
  message after it showed "WebSocket closed mid-stream" with the box already empty, and later ones showed Stop with no
  reply. The words now come back to the box. If the browser still has a session, the chat goes on with it and says the
  message was not sent, which one key press sends again. If it has none, the page says the session ended and links to
  sign-in, which comes back to the conversation. ([#178](https://github.com/gateweavehq/agents/pull/178))

### Security

- **A new password needs the current one, at five tries a minute.** The change emails the person and ends every other
  session, whatever the request asks, since whoever knew the old password may be the one asking.
  ([#176](https://github.com/gateweavehq/agents/pull/176))
- **A name is 1 to 100 characters, at sign-up too, and a rename changes nothing else.** Ten a minute.
  ([#176](https://github.com/gateweavehq/agents/pull/176))

### If you run your own

- **Anyone holding a session can now rename that account,** within the rules above. There is no setting for it.
- **On a server without email, the password email is not sent.** Everything else about the change still happens.

## [0.15.4] - 2026-11-07

Agents' pages now say what a browser may do with them. There is no migration in this release.

### Security

- **Pages sent no security headers,** so any site could put Agents in a frame under its own buttons, and a script that
  got into a page could load and send anything. A conversation shows what a model wrote, so that limit matters here.
  Every answer now gets `X-Content-Type-Options`, `Referrer-Policy` and, over HTTPS, `Strict-Transport-Security`. A page
  also gets `X-Frame-Options`, `Cache-Control: private, no-store` and a Content-Security-Policy with a nonce made for
  that response. ([#174](https://github.com/gateweavehq/agents/pull/174))

### If you run your own

- **A member's picture shows only from GitHub or your sign-in provider's own host.** From anywhere else, their initials
  show instead.
- **Leave Web Analytics' automatic setup and Rocket Loader off for this hostname.** A zone setting that adds scripts to
  a page does nothing here or gets in the way. See "Your own domain" in `docs/self-hosting.md`.
- **A browser that has seen `Strict-Transport-Security` keeps to HTTPS on that host for a year,** which sign-in already
  needed.

## [0.15.3] - 2026-11-07

Someone signing up can no longer choose the address of their picture. There is no migration in this release.

### Security

- **An email sign-up could set any picture address,** and other members' browsers then fetched it, which told that
  server when they were looking and from where. The sign-up form sends no picture, so it is now dropped. GitHub's and a
  provider's stay. Pictures already stored are not changed. ([#172](https://github.com/gateweavehq/agents/pull/172))

## [0.15.2] - 2026-11-07

Closes the account routes a stolen session cookie could use and the app does not. Self-hosted copies should update.
There is no migration in this release.

### Security

- **A stolen cookie could delete an account without its password.** Deleting an account asks for the password only where
  there is one, and Better Auth's `/unlink-account` removed a password on a recent session alone. On an account that
  also signs in with GitHub or a provider, a cookie under a day old could do both. The route is now closed.
  ([#170](https://github.com/gateweavehq/agents/pull/170))
- **A stolen cookie could try passwords.** `/verify-password` and `/change-password` took one from any session. The app
  has no use for either, and both are closed. ([#170](https://github.com/gateweavehq/agents/pull/170))
- **Other routes that any session could call and the app has no use for are closed:** `/update-user`, `/list-sessions`,
  `/list-accounts`, `/get-access-token`, `/refresh-token` and `/account-info`. An account keeps none of a provider's
  tokens, so the token routes had nothing to give. ([#170](https://github.com/gateweavehq/agents/pull/170))

### Changed

- **These routes now answer 404,** for anyone who called them by hand. The app has no page for any of them, and changing
  a password still goes through a reset. ([#170](https://github.com/gateweavehq/agents/pull/170))

## [0.15.1] - 2026-11-07

The members page no longer says an invitation was emailed before that is known. There is no migration in this release.

### Changed

- **A mail that fails to send now says why in Workers Logs,** with Cloudflare's error code and without the address. It
  used to log only a stack, with no reason. ([#168](https://github.com/gateweavehq/agents/pull/168))

### Fixed

- **The members page said an invitation had been emailed, though it couldn't know.** The mail goes in the background, so
  an invitation to an address that had bounced before looked sent when it wasn't. The page now says the mail is on its
  way and offers the link in case it doesn't arrive. ([#168](https://github.com/gateweavehq/agents/pull/168))

## [0.15.0] - 2026-11-07

People can delete their own account, and deleting a conversation no longer shows an error after it worked. This release
has two D1 migrations, which `pnpm run deploy` applies before the new code goes live. Neither changes a row. Between the
migrations and the new code, deleting a workspace answers an error and changes nothing, so try again after the deploy.

### Added

- **Delete your own account, on `/settings/account`.** The conversations you started go, with their messages and
  sandboxes, in every workspace you are in or leave from this version on. Your runs stay in each workspace's usage under
  "A former member", and hold no words. What you set up for the team stays with it, such as agents and the tokens you
  connected, so disconnect those first or revoke them at the service. If you are the only owner of a workspace, hand it
  over or delete it first. ([#164](https://github.com/gateweavehq/agents/pull/164))

### Changed

- **A workspace now keeps an owner in the database,** so two owners leaving at once can't leave it with none.
  ([#164](https://github.com/gateweavehq/agents/pull/164))

### Fixed

- **Deleting a conversation showed the error "destroyed" and stayed on the page, though the conversation was gone.**
  Deleting a workspace also logged a failure for each of its conversations. The object's own `destroyed` line stays in
  Workers Logs, since that is how it ends. ([#165](https://github.com/gateweavehq/agents/pull/165))
- **A scanned repository's file could stall reading its front matter.** A line of 200,000 blanks took about 23 seconds
  in Node when the front matter was not valid YAML. ([#166](https://github.com/gateweavehq/agents/pull/166))
- **CI's token is read-only by default.** ([#166](https://github.com/gateweavehq/agents/pull/166))

## [0.14.2] - 2026-11-07

A deployment with no `BETTER_AUTH_URL` now marks its cookies `Secure`. No migration.

### Fixed

- **Session cookies had no `Secure` on a deployment without `BETTER_AUTH_URL`.** The setting is optional, and without it
  a browser could send the cookie over plain HTTP, such as on the first request to a custom domain. Now it can't, unless
  this is local dev. Cookies keep their names, so nobody is signed out. Sign-in needs HTTPS on your own domain, as it
  already did with the setting, and the guide now says so. ([#162](https://github.com/gateweavehq/agents/pull/162))

### Changed

- **The README shows the product on its first screen,** with a recording in the reader's color scheme and the Deploy
  button. ([#161](https://github.com/gateweavehq/agents/pull/161))

## [0.14.1] - 2026-11-06

Branches now build on a copy made with the Deploy button, and a deployment without its secret no longer runs. No
migration.

### Fixed

- **Every push to a branch of a button's copy failed its build.** The button turns Preview builds on, and Wrangler will
  not build a Preview without a `previews` block in `wrangler.jsonc`. So each branch showed a failed build, Dependabot's
  included. Those builds now pass. (#159)
- **A deployment missing the database or `BETTER_AUTH_SECRET` now answers 503,** says why, and serves nothing else. A
  deployed Worker needs the secret to deploy, so this reaches a Preview given a database and no secret of its own.
  (#159)

### Changed

- **The self-hosting guide says what a Preview gets:** none of the Worker's bindings or secrets, where it used to say
  Previews share the database. It says how to give them what they need, and that Dependabot's pull requests on a copy
  are not needed. `update-copy` keeps Dependabot's file out once a copy has deleted it. (#159)

### Upgrading

No migration. If you gave a Preview a database, give Previews a secret of their own, or they now answer 503: `pnpm
wrangler preview base-config secret put BETTER_AUTH_SECRET`. Anyone with an account on such a Preview should treat its
sessions as forgeable until then.

## [0.14.0] - 2026-11-06

A copy made with the Deploy button can now update. Until now `git pull` refused there, so whoever pressed the button
stayed on that version. No migration.

### Added

- **`scripts/update-copy.mjs` brings a button's copy up to a release.** The button makes a copy in one new commit, with
  no history in common with this repository. The script takes the latest release into the copy as one commit and pushes
  nothing, and a copy can skip releases, however old it is. What the copy changed stays: the Worker's and database's
  names, the name in `package.json`, and having no workflows. Anything else that conflicts is named for you to fix. The
  self-hosting guide has the commands. (#157)

### Upgrading

No migration, and nothing changes for Gateweave Cloud or for a deployment from a clone, which keeps updating with `git
pull`. If you made your copy with the button, this is also how it gets v0.13.1's fix that keeps settings through a
deploy: read that entry first, because a limit set as a plain variable may already be gone.

## [0.13.1] - 2026-11-06

A server's settings now stay through a deploy, and a chat stops taking messages once its session has ended. If you set a
spending limit on a self-hosted server as a plain variable, read this one: it may have been gone since your last deploy.
No migration.

### Fixed

- **Settings made in the dashboard stay through a deploy.** Wrangler removes a plain-text variable it does not find in
  `wrangler.jsonc` unless `keep_vars` says otherwise, and ours did not. So every deploy took away what had been set as a
  Text variable, without a word. A limit that is not set is no limit, so `SANDBOX_MONTHLY_BUDGET` or
  `SANDBOX_DAILY_MINUTES` set that way stopped holding, with sandboxes still running. Secrets were not affected, and
  neither was Gateweave Cloud. (#155)
- **A chat stops taking messages once its session has ended.** A chat left open kept running on someone's authority
  after they signed out, had the session revoked, reset their password or were signed out through ID. Each message now
  checks the session first and the socket closes if it has gone. A turn already under way finishes, and an idle socket
  stays open until it sends something. (#154)

### Changed

- **Updated dependencies,** among them agents 0.32, ai 7.0.159, wrangler 4.156 and croner 11. `pnpm check` now fails
  when agents or `@cloudflare/ai-chat` resolves to more than one copy. (#143, #150, #152)
- **The self-hosting guide says where the Git account is on the Deploy form.** (#155)

### Upgrading

No migration. After updating, look through the Worker's variables in the dashboard and set again what has gone, first of
all any limits. A variable taken out of `vars` in `wrangler.jsonc` now stays on the Worker until someone removes it in
the dashboard, so taking a limit out of `vars` no longer lifts it by itself.

## [0.13.0] - 2026-11-05

A deployment can now link its legal notice, privacy policy and terms. Updating a self-hosted copy needs no migration,
and nothing changes until you set them. (#148)

### Added

- **Links to your legal pages.** Three optional settings, `LEGAL_NOTICE_URL`, `PRIVACY_POLICY_URL` and `TERMS_URL`, are
  linked from the pages around signing in, the workspace list and the workspace menu. With `TERMS_URL` set, the sign-in
  page also says that continuing means agreeing to them. Agents comes with no legal pages of its own and never links to
  Gateweave's. (#148)

### Upgrading

No migration. To show links, set any of the three addresses; see `docs/self-hosting.md`.

## [0.12.4] - 2026-11-05

Sessions and invitations past their time now go by themselves. Updating a self-hosted copy needs no migration and no
new setting.

### Fixed

- **What was past its time stayed.** Better Auth removes a session or a verification only when something looks it up, so
  one nobody came back for stayed for good, with the address and browser it came from, and an invitation kept the address
  it was sent to. A daily Cron Trigger now deletes them, in batches. Nothing anyone can see changes. (#146)

### Upgrading

Deploying creates the Cron Trigger, at 03:29 UTC, from `wrangler.jsonc`. If you keep your own copy of that file, add
`"triggers": { "crons": ["29 3 * * *"] }`, or the rows stay. It counts toward your account's limit of Cron Triggers. The
first run deletes everything already past its time.

## [0.12.3] - 2026-11-05

A Worker with nothing to do with Agents could use up the limits of every other Worker. Updating a self-hosted copy
needs no migration and no new setting.

### Fixed

- **One Worker could use up what another needs.** Every Worker on Cloudflare reaches Agents from one address, so its
  limits counted them all as one caller, and enough junk from any of them could stop a provider's logout or Track's
  deliveries to a trigger. A Worker is now counted by its zone, which Cloudflare sets and a sender cannot change.
  Anyone else is counted by their address as before, whatever they claim. (#144)

## [0.12.2] - 2026-11-04

Signing out at a provider could leave someone signed in here. Updating a self-hosted copy needs no migration and no
new setting.

### Fixed

- **A provider's logout could be lost.** If the provider stopped waiting for the answer, Workers cancelled the
  request and the session stayed. A logout that has arrived is now seen through. When Agents cannot fetch the
  provider's keys at that moment it answers 503 rather than 400, so that a provider can try again, and nothing ends
  until the token has been checked. (#140)

## [0.12.1] - 2026-11-04

Better Auth 1.7.16, a security release, so anyone running a copy should update. Updating a self-hosted
copy needs no migration and no new setting.

### Security

- **Better Auth 1.7.16.** Email verification and email-change links worked for an account other than the
  one they were issued to. Generic OAuth profiles are now bound to the ID token's subject, which signing
  in through an OpenID Connect provider rests on, and organization roles no longer take whitespace. (#138)

## [0.12.0] - 2026-11-04

People can sign in through any OpenID Connect provider, such as Gateweave ID, and three security
fixes, so anyone running a copy should update. Updating a self-hosted copy applies two D1 migrations,
one of which deletes the GitHub tokens earlier versions stored, and needs no new setting unless you
want the new sign-in.

### Added

- Set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, and the sign-in page gets a button for
  that provider, named by `OIDC_PROVIDER_NAME`. Without them nothing changes. An existing account links
  only when the provider says the address is verified and Agents has verified it too, none of the
  provider's tokens are kept, and a provider that is down costs only its own button. The provider can
  end sessions through back-channel logout, and signing out of Agents leaves someone signed in to
  their provider. A chat already open outlives its session, because the chat socket checks the
  session only when it opens. See "Sign in through an OpenID Connect provider" in
  `docs/self-hosting.md`. (#134)

### Security

- Every signed-in page carried the session's token in its HTML, where a saved page or anything that
  keeps a copy of the document would have it too. The cookie is `HttpOnly` to keep it from there, and
  no page reads it, so pages no longer get it. Better Auth's `/get-session` still answers a script
  with it, so this keeps the token out of documents, not out of reach of a script already running in
  the page. (#135)
- Signing in with GitHub stored GitHub's access token, unencrypted, in `account`. Nothing read it:
  the GitHub integration makes an exchange of its own. Agents now keeps none of them, and a migration
  deletes the ones already stored. (#136)
- The sign-in, sign-up and reset pages work only through their script. Pressed before it had run, on a
  slow connection for example, the browser sent the form itself as a GET, so the password landed in
  the address bar, the browser's history and any log of requests. Their buttons now stay disabled
  until the script has run. (#133)

## [0.11.0] - 2026-11-02

Workspaces can read GitLab repositories, from gitlab.com or a self-managed GitLab. Updating a
self-hosted copy applies a migration in each workspace's registry, which runs on its own, and
needs no new setting.

### Added

- Settings, GitLab connects a GitLab with an access token (`read_api` and `read_repository`),
  which is encrypted and never shown again. Its projects become repositories, scanned for agents
  and assets as GitHub repositories are, and a push webhook, whose secret token the page shows
  once, rescans the default branch on every push. Applying setups and sandboxes stay with GitHub
  repositories for now, and say so for GitLab ones. (#131)

### Fixed

- On a phone, the settings tabs scroll sideways; the last ones could not be reached. (#131)

## [0.10.0] - 2026-11-02

MCP servers that sign in with OAuth connect with a button instead of an API key. Updating a
self-hosted copy applies a migration in each workspace's registry, which runs on its own, and
needs no new setting.

### Added

- On the MCP page, an owner or admin can connect a remote server through its own OAuth sign-in,
  as the MCP authorization spec describes: the app finds the server's authorization server,
  registers itself as a client, and signs in with PKCE. Agents that pin the server then use the
  connection, and act on the server as the person who connected it, which the page says. The
  tokens are encrypted, never shown, and refreshed when the server stops taking them. A
  connection is only used at the URL it was made for, and "Disconnect" forgets it. (#129)

## [0.9.0] - 2026-11-02

Owners can delete a workspace, and a new workspace shows how to get going. Updating a
self-hosted copy needs no migration; `INVITATION_CONTACT` is an optional new setting.

### Added

- An owner can delete a workspace in Settings > Workspace, after typing its name. It deletes its
  members and invitations, its registry with its keys and secrets, and every conversation with
  its messages, traces and sandbox. The GitHub App installation stays on GitHub until someone
  uninstalls it there. (#126)
- `INVITATION_CONTACT`, an email address or an https URL, is where a workspace asks to be invited
  to Workers AI or sandboxes. Settings > Models links to it when they are by invitation, with the
  workspace's name and id in the message. (#127)

### Changed

- The empty Chat page tells an admin of a workspace with no model key to add one first, and
  links to Settings > Models. (#127)

### Fixed

- Deleting a workspace deleted its registry but left each conversation's messages, traces and
  sandbox behind, where nothing could reach them. (#126)

## [0.8.0] - 2026-11-02

Setups write GitHub Copilot and Devin files, and a server can offer Workers AI to the workspaces it
invites, within a daily limit for each. Updating a self-hosted copy needs no migration; the
Workers AI limits are optional settings (see below).

### Added

- Setups can target GitHub Copilot and Devin. Copilot gets `AGENTS.md`, its own path-specific
  instructions in `.github/instructions`, the shared `.agents/skills` and `.vscode/mcp.json`.
  Devin gets `AGENTS.md`; its MCP servers live in a file it keeps out of Git and its docs name no
  folder for skills, so a setup says those are not written for it. (#122)
- `WORKERS_AI_WORKSPACES` limits Workers AI to the workspaces a server invites (`sandbox` invites
  those `SANDBOX_WORKSPACES` invites), and `WORKERS_AI_DAILY_DOLLARS` limits what each may spend
  on it in a day (UTC), at its list prices. A turn past either is refused, saying why, and
  Settings > Models shows the day's spend. Gateweave Cloud invites its sandbox workspaces, up to
  $20 a day each, once its Workers AI token is set. (#123)

### Changed

- Settings > Models says Workers AI is offered to "this workspace" rather than "every
  workspace", since a server may invite only some. (#123)

## [0.7.0] - 2026-11-02

Two more coding agents in scans, MCP servers that run as a local command, run traces in your own
observability tool, replaying a run from a step, and usage across workspaces for whoever runs the
server. Updating a self-hosted copy applies migrations in each workspace's registry, which run on
their own, and needs no new setting; the usage events are optional (see below).

### Added

- Scans find GitHub Copilot (`.github/copilot-instructions.md`, path-specific instructions,
  prompt files, custom agents, chat modes, `.vscode/mcp.json` and skills) and Devin, which
  Windsurf became (`.devin/rules`, Windsurf's rules as legacy, global rules and
  `.devin/config.json`). Both are read-only: setups do not write them yet. (#116)
- An agent with a sandbox can use MCP servers that run as a local command, such as
  `npx -y @acme/mcp`: each turn starts the command in the conversation's sandbox and talks to it
  over its standard input and output. Its environment takes the agent's environment set's
  variables, never a secret, since the sandbox holds none: a server that names a secret is left
  out of the turn, saying which. (#118)
- Settings > Telemetry sends each run's trace to an OpenTelemetry endpoint over OTLP/HTTP, such
  as Honeycomb, Grafana or Datadog: the run, its model requests with GenAI attributes for model,
  tokens and cost, its tool calls and its team's calls, a team's turn as one trace. No message
  text and no tool input or output is sent; the endpoint's headers are encrypted. A failed send
  is tried again a few times, and the page shows how the last one went. (#119)
- On a run's page, "Replay from here" on a model request starts a new conversation with the
  run's conversation up to that request, answered by the agent as it is now, so a change to its
  instructions or model shows. The replay links back to the run, which lists its replays. Only
  whoever started a run may replay it, and owners and admins a trigger's run too. Runs from
  before this version, and runs of Claude Code, Codex and OpenCode, cannot be replayed. (#120)
- A server can bind a Workers Analytics Engine dataset as `USAGE` to get one event per run that
  ends, indexed by workspace, with its agent, model, tokens, cost and sandbox time, for charts
  and billing across workspaces; `docs/self-hosting.md` has the fields and a query. Gateweave
  Cloud binds one. (#117)

## [0.6.2] - 2026-11-02

A small fix to run traces, and a safer test dependency. Updating a self-hosted copy needs no
migration and no new setting.

### Fixed

- In a run of an agent whose engine is OpenCode, a tool call that a subagent's requests ran
  during, such as `task`, shows under the model request that called it, not under the subagent's
  last request. (#114)

### Security

- undici, which only local development and tests use through Miniflare, is updated to 7.30.1 for
  its advisories. Deployed Workers never included it. (#112)

## [0.6.1] - 2026-11-02

A security follow-up to v0.6.0: secrets stored before it are tied to their servers' address too,
and stay closed if that fails. Updating a self-hosted copy applies a migration in each
workspace's registry, which runs on its own, and needs no new setting. (#108, #110)

### Security

- A secret stored before v0.6.0 had no address yet, so until it was first used, an admin could
  point a server that names it at their own host and check it there. Each workspace now ties
  those secrets once, as it first starts after the update, to the address of the servers that
  use them. A secret whose servers sit at more than one address is marked as contested on the
  Environment page and goes only to one of those addresses until someone enters it again. (#108)
- If that one-time pass fails in a workspace, its secrets that have no address yet are refused
  to every address until someone enters them again, and the workspace's owners and admins see
  when it failed. A copy self-hosted from `main` between #108 and #110 whose pass had already
  failed is not closed after the fact: enter those secrets again. (#110)
- The registry no longer has a call that hands out opened secret values; they leave it only for
  a check or a turn, after the address check. (#108)

## [0.6.0] - 2026-11-02

Sandboxes are held tighter: what an agent's model requests may ask of the provider is checked
before the workspace's key goes on, and the limits on sandboxes hold when turns begin together.
MCP servers' header secrets are tied to the address they were first sent to. Agents also has
its own icon. Updating a self-hosted copy applies a migration in each workspace's registry, which
runs on its own, and needs no new setting. (#104, #105, #107)

### Security

- A model request from a sandbox is read before the workspace's key is added. It must be plain
  JSON of at most 16 MB, name the agent's own model, and use only tools the engine runs itself:
  no provider-run tools such as MCP connectors, web search or code execution, no images or files
  fetched by URL, and nothing that reads what the provider stored (OpenAI's previous responses,
  item references and files, Google's cached content) or costs more (priority tiers, faster or
  regional inference). Headers are an allowlist. A refused request answers 403 and shows in the
  run's trace with the reason. Claude Code's turns set each of its model variables to the agent's
  model, so it no longer reaches for Haiku or another fallback. (#105, #107)
- A secret named in an MCP server's headers is sent only to the origin it was first sent to.
  Anyone who may edit a library MCP server could point it at another host, while its secrets were
  often entered by someone else; a server at another origin is now left out of checks and turns,
  saying which secret was entered for another address, until someone enters the value again.
  Secrets stored before the update are tied to the origin of their next send. (#107)
- The limit on a workspace's sandboxes and its daily sandbox minutes are checked again inside
  the write that starts a run, so turns that begin together can no longer go past them. (#105)

### Added

- Agents has its own icon, a team of three agents, linked, on the dark tile of the new Gateweave
  mark, and an Apple touch icon for the home screen. (#104)

## [0.5.1] - 2026-11-01

A security fix: only someone who controls a GitHub account can connect its installation of the
GitHub App to a workspace. Updating a self-hosted copy needs no migration and no new setting, but
its GitHub App needs one more permission.

### Security

- Connecting a GitHub App installation now needs control of the account it is installed on: an
  active admin of the organization, or the owner of the personal account. Before, any person
  GitHub lists the installation for could connect it, and GitHub lists it for anyone with read
  access to one of its repositories. Add the **Organization › Members: Read** permission to the
  app, and have each organization accept it; until then, connecting an organization is refused.
  Installations already connected stay connected. (#100)

## [0.5.0] - 2026-11-01

An agent's model requests from its sandbox are now counted as they leave it, so the Runs page
shows every request Claude Code, Codex and OpenCode make, those of their subagents too, and each
run shows the sandbox time it took and what that is estimated to cost. Updating a self-hosted copy
needs no migration and no new setting.

### Added

- Each run with a sandbox shows the sandbox time it accounts for: from its start until its
  conversation's next turn, or until the sandbox's 15 idle minutes after it ended, so the runs
  add up to what the daily limit counts. Runs and a run's page show what it is estimated to cost
  at the machine's list price, apart from the models' cost. (#97)

### Changed

- The model requests of an agent whose engine is Claude Code, Codex or OpenCode are metered where
  they leave the sandbox, with the usage each answer reports, instead of from what the CLI prints.
  A Codex turn now shows one span per request rather than one for the whole turn, and requests
  that were refused, failed or cut off are in the trace with what they used. (#96)
- OpenCode's `task` tool is on again: its subagents' requests are counted like any other. (#96)

## [0.4.1] - 2026-11-01

A trigger limited to one Track member's issues shows that member by name. Updating a self-hosted
copy applies a migration in each workspace's database, which runs on its own; there is no D1
migration and no new setting.

### Changed

- A trigger's assignee shows by the name Track gives them, with their id as a hint, in the
  agent's trigger list and in the trigger dialog. "Work on Track issues" stores the agent
  member's name when it sets up, and Track's events about the member's issues keep it current,
  so a trigger set up earlier gets a name the next time Track tells it about one of their issues.
  This needs Gateweave Track 0.14.1 or later. (#94)

## [0.4.0] - 2026-10-31

An agent working on an assigned Track issue now goes on when a person comments on it: it answers
the question, makes the change asked for and pushes it to the same pull request. Updating a
self-hosted copy applies a migration in each workspace's database, which runs on its own; there
is no D1 migration and no new setting. A "Work on Track issues" set up before this version keeps
starting each assignment anew until you change its trigger, as `docs/track-work.md` says under
"Set up before comments continued the work".

### Added

- A trigger can keep one conversation per issue. Its deliveries about an issue it has seen go on
  in that issue's conversation, with its history, its sandbox branch and its pull request. While
  the agent is still on a turn about the issue, Agents asks the sender to try again later. (#90)
- The ready-made "Work on Track issues" listens to comments too, with one conversation per issue.
  A person's comment on an issue assigned to the agent continues its work, and its instructions
  say how to answer one. Comments by agents and by Track itself start no run. (#90)

### Changed

- The sandbox has pnpm and Yarn through Corepack, so an agent can run a repository's own checks,
  such as `pnpm verify`. (#88)

### Fixed

- Claude Code in a sandbox no longer adds "Generated with Claude Code" to an agent's pull
  requests or a co-author to its commits, whatever the repository's settings say. Codex and
  OpenCode add neither. (#89)
- A dialog taller than the window, such as a trigger's, scrolls inside itself, so its title and
  its buttons stay in reach. (#92)

## [0.3.0] - 2026-10-31

Assign a Gateweave Track issue to an agent, and it works on it in a sandbox, opens a pull request
and reports back on the issue. Updating a self-hosted copy applies a migration in each
workspace's database, which runs on its own; there is no D1 migration and no new setting. The
ready-made setup needs Gateweave Track v0.13.0 or later.

### Added

- A ready-made "Work on Track issues", next to triage under Agents, Ready-made. From Track's
  address, an agent member's key, a repository, an engine and a model, it makes an agent with a
  sandbox on that repository, Track's MCP server with the key, and a trigger for the issues
  assigned to that member, up to 20 runs a day. The agent comments on the issue as it starts,
  with a link to its run, moves it to In Progress, opens a pull request titled with the issue's
  key and ending "Fixes <key>", comments with it and moves the issue to In Review. When the issue
  is unclear, it asks whoever assigned it and stops. See `docs/track-work.md`. (#84)
- Triggers can be limited to the issues assigned to one Track member: on `issue.updated` only
  when the change just assigned them, and other events about an issue while it is theirs. (#84)
- A trigger's run is told its page in the app, so an agent can link it where it reports. (#84)

### Changed

- The ready-made triage agent's instructions let it use a link or a short list in its comments,
  now that Track shows them as Markdown. Agents set up before keep their instructions until you
  edit them in the library. (#86)

## [0.2.0] - 2026-10-30

OpenCode answers much sooner. It runs as a server that each sandbox starts once, instead of a new
process for every message. It can also call Google's models.

### Added

- OpenCode agents can use Google's Gemini models with the workspace's Google key. (#77)
- A Deploy to Cloudflare button in the README and the self-hosting guide, with what to fill in on
  its form. (#79)

### Changed

- An OpenCode turn runs on `opencode serve`, which the conversation's sandbox starts with its
  first turn and keeps for the next ones. On Gateweave Cloud's machines, a turn on a running
  server took 2.5 s instead of 25 s, and the first turn in a new sandbox 11 s instead of 46 s. The
  server starts over when the agent's model, instructions or tools change. (#80)
- Each step before OpenCode gets the message has a time limit. If the server does not come up,
  the turn fails and says which step was late, instead of waiting until the turn's one-hour
  limit. (#81)

## [0.1.1] - 2026-10-30

Gateweave Cloud offers sandboxes to the workspaces it invites. Self-hosted servers are unchanged.

### Changed

- Gateweave Cloud's production deploys the new `cloud` environment of `wrangler.jsonc`. It adds
  sandboxes for invited workspaces, with at most 120 minutes a day for each workspace and $100 a
  month for the server. The top level, which self-hosters deploy, still runs no sandboxes. (#74)

## [0.1.0] - 2026-10-30

The first release of Gateweave Agents. It shows which coding agents work in which repositories and
what they read, keeps their instructions, skills and MCP servers in one library, applies them to
repositories, and runs agents and teams of agents on Cloudflare with each workspace's own model
keys. Publishing it deploys Gateweave Cloud's agents.gateweave.com, which runs no sandboxes yet.

### Added

- Accounts, workspaces, members and invitations, with owner, admin and member roles, and sign-in
  with email or GitHub.
- GitHub: a workspace connects repositories through a GitHub App. The agents configured in each
  one (Claude Code, Codex, Gemini CLI, Cursor) and the files they read are found, and kept up to
  date on every push. They can be browsed by project, repository, agent and asset.
- The library keeps versions of the assets worth sharing, and shows which repositories carry each
  one and which are behind.
- Setups pin assets for a set of coding agents. A setup previews the files it writes, applies them
  to a repository by pull request, and shows where the repository has drifted since. Ready-made
  setups from `setups/` are added in one click.
- The CLI, `@gateweave/agents`, applies a setup to a working tree and checks in CI that the tree
  still holds it.
- Model provider keys (Anthropic, OpenAI, Google), kept encrypted, and Workers AI when the server
  offers it.
- Environment sets: variables, and secrets whose values are stored encrypted.
- Agents that Gateweave runs, each with a model, instructions from the library, an environment set
  and MCP servers.
- Teams of agents that delegate to, ask and report to each other along the edges of a graph.
- Chat with an agent or a team. Every answer is a run with its trace and estimated cost, and the
  runs a team's agents led to are nested inside it.
- Triggers start an agent's runs from another service's signed webhooks, or on a schedule. They can
  be limited to some event types or labels. Track triage is ready-made.
- Sandboxes, when the server runs them: a Linux machine for each conversation.
  - An agent with a sandbox works in a checkout of its repository and proposes its work as a pull
    request. No GitHub token or model key enters the sandbox.
  - Claude Code, Codex and OpenCode can take an agent's turns there.
  - A server can offer sandboxes only to the workspaces it invites, and limit their minutes per day
    and its spending per month.
- Self-hosting on your own Cloudflare account with `pnpm run deploy`; see
  [docs/self-hosting.md](docs/self-hosting.md).
