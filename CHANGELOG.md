# Changelog

Notable changes to Gateweave Agents, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/agents/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

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
