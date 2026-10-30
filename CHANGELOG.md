# Changelog

Notable changes to Gateweave Agents, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/agents/releases) carries the same
notes. Publishing a release deploys it to Gateweave Cloud.

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
