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

## What comes next

The registry (phase 1 of the spec) adds:

- A **per-workspace Durable Object** with SQLite that holds the registry: projects, repositories,
  the agents and assets found in them. The Worker reaches it only after checking D1 membership,
  as Track's gateways do. Pages read it through server functions; it is not synced to the browser
  yet (see "Decisions" in the spec).
- A **GitHub App**. Installing it on an account or organization links that installation to a
  workspace in D1. Webhooks and scans read each repository's agent configuration with the
  narrowest permissions that allow it.
- **Format adapters**: small, pure modules that turn the files of one agent (Claude Code, Codex,
  Gemini CLI, Cursor) into the registry's data model, each tested against real examples.

## Deploys

`main` deploys to staging after CI passes, and a published GitHub release deploys production
(`.github/workflows/deploy.yml`). D1 migrations are applied before the new code goes live.
