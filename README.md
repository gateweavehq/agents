# Gateweave Agents

See which agents work where, keep their prompts, skills, plugins, scripts and MCP servers in one
place, apply them to any repository in a click, and run your own teams of agents on Cloudflare.

Gateweave Agents is part of [Gateweave](https://gateweave.com), the family of open-source business
tools that run on Cloudflare, next to [Gateweave Track](https://github.com/gateweavehq/track).

> **Status: early development.** Accounts, workspaces, members and invitations work. Workspaces
> connect to GitHub, and the agents configured in each repository (Claude Code, Codex, Gemini
> CLI, Cursor) and what they read are found and kept up to date on every push, and can be browsed
> by project, by repository, by agent and by asset. A workspace library keeps versions of the
> assets worth sharing and shows which repositories carry each one and which are behind, and
> setups pin them for a set of coding agents, preview the files they write, apply them to a
> repository by pull request and show where a repository has drifted from them since. Ready-made
> setups, kept as plain folders in [setups/](setups/), are added to a workspace in one click,
> and the [CLI](packages/cli) applies a setup to a working tree and checks it in CI. Workspaces
> keep their own model provider keys and environment sets (variables, and secrets whose values
> are stored encrypted), and define agents that Gateweave runs with a model, instructions from
> the library, an environment set and MCP servers. Agents work in teams, delegating to, asking
> and reporting to each other along the edges of a graph. Members chat with an agent or a team,
> and every answer is a run with its trace and estimated cost, the runs a team's agents led to
> nested inside it. Triggers start an agent's runs from another service's signed webhooks or on a
> schedule, if wanted only for issues with a label, and an agent with a sandbox works in a
> checkout of its repository and proposes its work as a pull request. See
> [docs/spec.md](docs/spec.md) for the plan.

## Tech stack

[TanStack Start](https://tanstack.com/start) · React 19 · Tailwind CSS 4 ·
[Better Auth](https://better-auth.com) · [Drizzle ORM](https://orm.drizzle.team) ·
Cloudflare Workers, Durable Objects and D1 · TypeScript 7 · Vitest · Biome

## Getting started

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
pnpm install
pnpm doctor      # checks your toolchain and setup, and explains how to fix anything missing
pnpm dev:setup   # creates .dev.vars with a random secret, migrates the local database
pnpm dev         # http://localhost:4720
```

Sign up with any email and password, then create a workspace. To enable "Sign in with GitHub",
uncomment and fill in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.dev.vars`. To connect
workspaces to GitHub, create a GitHub App as [docs/github-app.md](docs/github-app.md) describes.

Workspaces keep their model provider keys and environment secrets encrypted with the server's
`SECRETS_KEY`, which `pnpm dev:setup` generates for local development. On a deployed Worker, set
it once with `openssl rand -base64 32 | pnpm wrangler secret put SECRETS_KEY` and keep it: if it
changes, workspaces have to add their keys and secret values again.

Chat sends each agent's requests straight to its model provider. To send them through a
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) instead, for its logs,
caching and rate limits, set `AI_GATEWAY_URL` to
`https://gateway.ai.cloudflare.com/v1/<account id>/<gateway>`, and `AI_GATEWAY_TOKEN` if the
gateway is authenticated.

To offer [Workers AI](https://developers.cloudflare.com/workers-ai/) models to every workspace,
with no key of their own, set the secret `WORKERS_AI_TOKEN` (a Cloudflare API token with the
Workers AI permission) and `CLOUDFLARE_ACCOUNT_ID`, or leave the account out and it is taken from
`AI_GATEWAY_URL`. Your Cloudflare account pays for those runs, so leave both out unless you mean
that. Set the token with `pnpm wrangler secret put WORKERS_AI_TOKEN`.

To let agents have a sandbox, a Linux machine per conversation where they run commands and edit
files, add the `SANDBOX` binding and the `containers` entry that the `staging` environment in
`wrangler.jsonc` has to the environment you deploy. Deploying then needs Docker, which builds
`sandbox/Dockerfile`, and your Cloudflare account pays for the
[Containers](https://developers.cloudflare.com/containers/) time; each workspace has at most three
sandboxes at once, and each stops after 15 minutes without use. To offer them only to some
workspaces, list their ids in `SANDBOX_WORKSPACES`, separated by commas. To cap what they cost, set
`SANDBOX_DAILY_MINUTES` (each workspace's minutes per UTC day) and `SANDBOX_MONTHLY_BUDGET` (US
dollars per UTC month for the whole server). The budget prices sandbox time at the most Cloudflare
charges for its machine, about $0.074 an hour, so your bill comes in under it. Set
`SANDBOX_ALERT_EMAIL` as a secret to get an email at 80% and at 100% of the budget (this needs
email, above). Turns that would go over a limit are refused with a message that says which one. An agent's sandbox can check out
one of the workspace's repositories when the server is set up as a GitHub App (see above), and
propose its work as a pull request. The Worker mints a token for that repository alone and adds it
as the clone leaves, so the token never enters the sandbox. For the one push a pull request needs,
it mints a token that writes, and only to the conversation's own branch. An agent can also take its
turns with Claude Code, Codex or OpenCode, which the image installs, in place of Gateweave's own
loop. They run in its sandbox with the workspace's Anthropic or OpenAI key, which the Worker adds
to their requests on the way out, so the key never enters the sandbox either.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Run `pnpm verify` before you
open a pull request.

## License

[AGPL-3.0](LICENSE). Contributions are made under the [CLA](CLA.md), which covers every Gateweave
project.
