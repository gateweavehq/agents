# Changelog

Notable changes to Gateweave Agents, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/agents/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

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
