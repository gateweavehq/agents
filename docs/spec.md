# Gateweave Agents: product spec

> **Status: agreed.** Phase 1 (the registry) is being built. Decisions are recorded at the end.

## The problem

Teams now work with several AI agents at once: Claude Code, Codex, Gemini CLI, Cursor and agents
they build themselves. Each one is configured separately, in each repository, in its own format:
instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`), skills, plugins, scripts, MCP servers and
environment variables. Nobody can answer simple questions:

- Which projects use which repositories, and which agents work in each one?
- Which prompts, skills, plugins, scripts and MCP servers does each agent use? Are they the same
  everywhere, or has every repository drifted?
- What did the agents do, through which tools, and what did it cost?

Setting up a new repository with a team's agent standards means copying files by hand. And teams
that want their own multi-agent systems (a lead agent that delegates to specialists, reviewers
that check their work) have to build the runtime, the messaging and the debugging tools
themselves.

## What Gateweave Agents is

One product with two layers that share a data model:

1. **Registry and setups.** An inventory of projects, repositories and the coding agents
   configured in them, plus one library of prompts, skills, plugins, scripts, MCP servers and
   environment sets. A **setup** bundles assets for one or more agents and applies them to a
   repository in each agent's own format, through a pull request. Applying one takes a click; teams
   can also compose their own. Drift between a repository and its setup is visible.
2. **Runtime.** Define agents and teams of agents and run them on Cloudflare: hierarchies,
   an explicit graph of who may talk to whom, tools from the library and MCP, and any model through
   one gateway. Chat with an agent or a team, and debug every run step by step.

It follows the Gateweave principles: Cloudflare-native, local-first and open source (AGPL-3.0),
with a hosted version in Gateweave Cloud.

## Concepts

| Concept    | What it is                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| Workspace  | The team, shared with every Gateweave product: one account, members and roles                                   |
| Project    | A product or initiative; groups repositories                                                                    |
| Repository | A GitHub repository (others later), with the agent configuration found in it                                    |
| Agent      | A configured agent: its runtime, model, instructions, tools, permissions and environment                        |
| Runtime    | Where an agent runs: an external coding agent (Claude Code, Codex, Gemini CLI, Cursor) or the Gateweave runtime |
| Asset      | A versioned item in the library: prompt, skill, plugin, script, MCP server or environment set                   |
| Setup      | A bundle of assets for one or more agents that can be applied to repositories                                   |
| Team       | A graph of agents with roles (lead, member, reviewer) and allowed communication; teams nest                     |
| Run        | One execution of an agent or team: messages, delegations, tool calls, tokens, cost and result                   |
| Connection | An integration: the GitHub app, model providers, MCP servers                                                    |

Assets are versioned, and agents and setups pin versions, so a change to a shared skill is a
reviewable update rather than a silent one.

### Agents are members

An agent in the Gateweave runtime is also a member of the workspace, with an `agent` role an admin
creates and scopes. In other Gateweave products it acts through the same mutations people use, so
validation, permissions and the audit trail apply unchanged (see Track's `docs/ecosystem.md`).
A triage agent in Track is the first real job for this.

### Teams and communication

A team is a directed graph. Each edge says one agent may **delegate** to, **ask**, or **report**
to another. Nothing else is allowed, which keeps large teams understandable and stops loops. A
team can be a member of another team, which gives hierarchies: a lead agent delegates to team
leads, who delegate to specialists. The team graph is the same picture in the editor, in the chat
and in the debugger.

## Pages

| Page         | What it shows and does                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Overview     | Projects, active agents, recent runs, cost and anything that needs attention (drift, failures)                          |
| Projects     | Each project with its repositories, the agents working in them and the setups applied                                   |
| Repositories | Agent configuration found in each repository, drift from its setup, and "Apply setup"                                   |
| Agents       | Every agent: runtime, model, instructions, tools, permissions, and where it is used                                     |
| Teams        | A visual editor for team graphs: roles, edges (delegate, ask, report) and nesting                                       |
| Library      | Prompts, skills, plugins and scripts: versions, diffs and where each is used                                            |
| MCP          | Registered MCP servers, the tools they expose, their health, and which agents use them                                  |
| Environment  | Variable sets per environment, secrets by reference, and which agents or repositories use them                          |
| Setups       | Ready-made setups to apply in one click, and a builder for custom ones                                                  |
| Chat         | Talk to an agent or a team; delegations and tool calls appear inline as they happen                                     |
| Runs         | A trace of every run: messages, sub-agent spans, tool calls, inputs and outputs, timing, tokens and cost; replay a step |
| Settings     | Workspace, members, model providers, the GitHub connection and billing                                                  |

Debugging lives in Runs: a run opens as a timeline of spans, the way a distributed trace does.

## Supported agents

The registry reads and writes each agent's own files, so teams keep using the tools they have:

- **Claude Code:** `CLAUDE.md`, `.claude/skills`, `.claude/settings.json`, plugins and `.mcp.json`.
- **Codex** and other agents that read `AGENTS.md`.
- **Gemini CLI:** `GEMINI.md` and its settings.
- **Cursor:** `.cursor/rules`.

Each format is a small adapter with tests, so adding an agent does not touch the core. Formats
change often; each adapter tracks the vendor's current documentation.

## Architecture

The same shape as Track: one Worker per product and one Durable Object per workspace.

- **Interface and API.** TanStack Start on Workers, the same stack as Track. Better Auth for
  accounts; later a shared Gateweave identity Worker so one sign-in covers every product.
- **Registry data** (projects, repositories, agents, assets, setups, teams) lives in a
  per-workspace Durable Object with SQLite. Pages read it through server functions at first, and
  it moves to Track's sync engine when realtime matters (see "Decisions").
- **Runtime.** Each running agent is a Cloudflare Agents SDK agent (a Durable Object with its own
  state, storage and scheduling). Team messages are RPC calls between those objects, checked
  against the team graph. Long, multi-step jobs run as Workflows, so they survive restarts.
- **Models** go through Cloudflare AI Gateway: OpenAI, Anthropic, Google and Workers AI behind one
  endpoint, with caching, rate limits, fallbacks and logs.
- **Tools.** MCP servers through the Agents SDK's MCP client; scripts and code in Cloudflare
  Sandboxes; secrets in Secrets Store, referenced by name and never copied into prompts.
- **Traces.** Every run records its events in its Durable Object. Cost and usage roll up into
  Analytics Engine, and traces export over OpenTelemetry.
- **GitHub app.** Reads repositories to find agent configuration, and opens pull requests to apply
  setups. It asks for the narrowest permissions that allow this.
- **CLI** (`@gateweave/agents`). Applies a setup locally, checks a repository for drift in CI, and
  can report coding-agent sessions where the agent supports it (Claude Code exports OpenTelemetry,
  for example).

## Phases

The registry comes first: it ships fast, is useful at once and needs little infrastructure. The
runtime is designed alongside it, so the data model fits both.

1. **Registry.** Connect GitHub, scan repositories for agent configuration, group them into
   projects, and show the Overview, Projects, Repositories and Agents pages. This answers "which
   repository uses which agents" on day one, with no setup.
2. **Library and setups.** Versioned assets, ready-made and custom setups, applying them by pull
   request, and drift detection in the app and the CLI.
3. **Runtime.** Agents and teams in the Gateweave runtime, AI Gateway, MCP and environment pages,
   Chat and Runs.
4. **Agents in Gateweave products.** Agents as workspace members acting in Track, starting with
   issue triage.
5. **Cloud runners.** Coding agents in Sandboxes, started on a schedule or by an event, such as a
   new issue labeled for an agent.

## Decisions

- **Repository layout** (AGT-1, 2026-10-28). This repository holds the product. Code it shares
  with Track (auth, rate limiting, email, the Worker test harness, UI primitives) is copied in
  and owned here, the way shadcn/ui components are, rather than published as packages. With two
  consumers, a package would add releases and versioning to code that still changes every week.
  Fixes to shared code, auth above all, are checked against both repositories.
- **Sync comes later.** Registry data is written mostly by the server (GitHub scans and
  webhooks), so optimistic local writes buy little in phase 1, and extracting Track's sync engine
  now would churn Track right after its launch. When Agents needs realtime (chat and runs in phase
  3), the engine is extracted from the Track monorepo as `@gateweave/sync` and published to npm.
- **Single sign-on** across products comes with Gateweave ID, which replaces each product's own
  accounts in Gateweave Cloud. Until then each product has its own sign-in.
- **Local port.** 4720, following the Gateweave 47xx convention (site 4700, Track 4710).
