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
> repository by pull request and show where a repository has drifted from them since. See
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

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Run `pnpm verify` before you
open a pull request.

## License

[AGPL-3.0](LICENSE). Contributions are made under the [CLA](CLA.md), which covers every Gateweave
project.
