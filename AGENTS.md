# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It is the single source
of truth for how the project is built; `CLAUDE.md` and other tool-specific files only add to it.

## The project

Gateweave Agents shows which AI agents work in which repositories, keeps their prompts, skills,
plugins, scripts and MCP servers in one place, and will run teams of agents on Cloudflare. It is
part of [Gateweave](https://gateweave.com), next to
[Gateweave Track](https://github.com/gateweavehq/track). Everything ships as one Worker.

Read [docs/spec.md](docs/spec.md) for what the product is meant to become and
[docs/architecture.md](docs/architecture.md) for how it is built today.

## Repository map

| Path                | What lives there                                                            |
| ------------------- | --------------------------------------------------------------------------- |
| `apps/web`          | The Worker: TanStack Start UI, Better Auth, D1, the gateway to the registry |
| `packages/model`    | The registry's vocabulary, entities and input schemas (zod). No server code |
| `packages/adapters` | Turn a repository's files into a scan: one adapter per coding agent. Pure   |
| `packages/registry` | `RegistryDO`: each workspace's projects, repositories, agents and assets    |
| `packages/github`   | The GitHub App's client: JWT, installation tokens, OAuth, webhooks          |
| `packages/runtime`  | `ConversationAgent`: each conversation with an agent run by Gateweave       |
| `packages/cli`      | `@gateweave/agents`: applies and checks a setup in a working tree           |
| `docs/`             | The product spec, the architecture and setting up the GitHub App            |
| `scripts/`          | Repository tooling (`doctor`)                                               |
| `.claude/skills/`   | Step-by-step playbooks for recurring tasks (plain Markdown, any agent)      |
| `wrangler.jsonc`    | The Worker's config, at the root because the Deploy button reads it there   |

Wrangler commands that use the build output (`deploy`, `versions upload`, `preview`) must run
from the repository root, where the build leaves its pointer next to `wrangler.jsonc`. Use
`pnpm wrangler …`, which does that.

## Commands

Requirements: Node.js 24 (see `.node-version`; 22+ works) and pnpm 12. Run from the repository
root unless noted.

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies                                                         |
| `pnpm doctor`     | Check the local toolchain and setup, with fixes for anything missing         |
| `pnpm dev:setup`  | One-time: create `.dev.vars` and migrate the local D1 database               |
| `pnpm dev`        | Run the app on http://localhost:4720 (Workers, D1 and Durable Objects local) |
| `pnpm check`      | Biome lint and format check (`pnpm format` fixes most findings)              |
| `pnpm typecheck`  | Type-check every package (regenerates Wrangler and route types first)        |
| `pnpm test`       | Run every test suite                                                         |
| `pnpm build`      | Production build                                                             |
| `pnpm verify`     | Everything CI runs: check, typecheck, test, build                            |
| `pnpm run deploy` | Build, apply D1 migrations, deploy                                           |
| `pnpm wrangler`   | The pinned Wrangler, run from the repository root                            |

Scope a command to one package with `pnpm --filter <name> <script>`, for example
`pnpm --filter @gateweave/agents-web test`. Run `pnpm verify` before you consider a change done.

## Invariants

These are load-bearing. Breaking one breaks users' data or security, usually silently.

1. **Workspaces are private.** Every server function that reads or changes workspace data checks
   the caller's membership in D1 first (`currentMember` in `apps/web/src/server/access.ts`).
   Non-members get the same "not found" as a missing workspace.
2. **The registry has no public route.** `RegistryDO` trusts its caller, so the Worker reaches
   it (`registryFor`) only after that membership check. It still validates every input against
   the schemas in `packages/model`. Conversations (`ConversationAgent`) have no public route
   either: `apps/web/src/server/chat.ts` checks the session, the membership and that the
   conversation is the caller's, then passes the request on without its cookies.
3. **Registry writes stay synchronous.** Each runs inside `ctx.storage.transactionSync` with
   Drizzle's sync API (`.get()`, `.all()`, `.run()`), so it applies whole or not at all. Never
   `await` in the middle of a write. A scan awaits GitHub first and writes after, in a
   transaction of its own. Durable Object SQLite binds at most 100 parameters per
   query: join, or loop, instead of passing a list of ids to `inArray`.
4. **Server code never reaches the browser bundle.** In server functions, import server modules
   dynamically inside the handler, as `apps/web/src/lib/session.ts` does.
5. **One Better Auth instance per isolate, built on first use** (`getAuth()`). workerd forbids
   I/O in global scope, and `test/startup-logs.test.ts` fails if a cold start logs an error.
6. **Migrations are append-only.** Generate them with Drizzle Kit and commit them. Never edit a
   migration that has been merged. Follow `.claude/skills/schema-change/SKILL.md`.
7. **GitHub installation ids are not trusted until GitHub vouches for them.** Anyone can call
   the setup URL with any id. Link an installation to a workspace only after a user token shows
   the person can reach it, as `apps/web/src/server/github/flow.ts` does, and act on webhooks
   only after their signature checks out.
8. **Secrets stay local.** Never commit `.dev.vars` or print its contents. Secrets the app holds
   for workspaces (model keys, environment-set secrets, later MCP credentials) are sealed with
   `packages/registry/src/secrets.ts` before they are stored, opened only in the registry when a
   request needs them (a chat turn gets its key from `beginTurn`, in memory), and never sent to
   the browser, to files or to prompts and logs. Members see a key's last four characters, and
   which secrets of an environment set have a value, never the value.

## Code shared with Track

Auth, rate limiting, email, the Worker test harness and the UI primitives were copied from
[gateweavehq/track](https://github.com/gateweavehq/track) at `96e2263` (v0.2.0) and are owned
here now, the way shadcn/ui components are. When you fix a bug in one of them, check whether
Track has the same bug, especially in auth and rate limiting. They become shared packages only
when a third product needs them (see "Decisions" in `docs/spec.md`).

## Code style

- TypeScript is strict, with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions.
- Biome formats: tabs, 100 columns, double quotes. Don't hand-format; run `pnpm format`.
- Validate untrusted input at the boundary with zod. Inside, trust the types.
- Prefer `#private` fields, named exports and small modules. Default exports only where a
  framework requires them.
- Comments explain why, not what. Match the tone and density of the file you are editing.
- Generated files are not edited by hand: `routeTree.gen.ts`, `worker-configuration.d.ts`,
  `apps/web/src/server/db/auth-schema.ts` (`pnpm --filter @gateweave/agents-web auth:schema`),
  and everything under `migrations/` and `packages/registry/drizzle/` except the hand-written
  `migrations.d.ts`.
- Dependencies are pinned to exact versions. Shared ones go in the `catalog:` of
  `pnpm-workspace.yaml`. `drizzle-orm` stays on 0.45: the 1.0 migration format does not work
  with Wrangler's D1 migrations.
- UI code copied into the repository (components, blocks, hooks) must come from an MIT or
  Apache-2.0 source, such as shadcn/ui, Magic UI or SmoothUI. Note the source and keep its
  copyright notice in a comment at the top of the file. Paid or restricted kits (Aceternity UI,
  shadcn.io blocks, shadcnstudio Pro) cannot ship in an AGPL repository.

## Testing

- Test behavior through public APIs, not internals.
- `packages/registry` tests run inside workerd (`@cloudflare/vitest-plugin`) against a real
  `RegistryDO`. Call it over RPC; for a call expected to throw, use `runInDurableObject`, because
  the test pool reports an exception thrown inside a Durable Object as unhandled. Alarms may run
  on their own before `runDurableObjectAlarm` does, so assert on what a scan left behind, not on
  whether the alarm was still waiting.
- `packages/runtime` tests run inside workerd too, against a real `ConversationAgent` and
  `RegistryDO` over a real WebSocket. The model's API is a spy on `fetch`, which works because
  the Durable Object and the test share an isolate there.
- `packages/model` and `packages/github` tests run in Node.
- `packages/cli` tests run in Node and call `run` on folders in the system's temporary folder.
- `packages/adapters` tests run in Node, on in-memory repositories. Every test that checks output
  also checks that `scanResult` accepts it.
- `apps/web` has unit tests in `src/` and Worker tests in `test/`. The Worker tests build the app
  and run it in workerd through Miniflare, with every outbound request failing as a deployed
  Worker's request to its own hostname does; see `test/agents-worker.ts`. Tests that connect
  GitHub pass a `FakeGitHub` (`test/fake-github.ts`), which answers for github.com and
  api.github.com and checks the app's JWT, PKCE and who can reach which installation. Give its
  repositories `files` to test scans; it serves their branches, trees and blobs. Tests that use
  model keys pass a `FakeModels` (`test/fake-models.ts`), which lists models for the keys it
  knows and streams Anthropic's answers for chat.
- Every bug fix gets a test that fails without the fix. Never weaken or skip a test to make a
  change pass.

## Git and pull requests

- `main` is protected: changes land through pull requests with a green `check`, squash or rebase
  merged. Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), with a
  scope when it helps: `feat(web): list repositories by project`. Explain why in the body.
- Fill in the pull request template. A CLA bot asks first-time contributors to sign once.
- Follow `.claude/skills/open-pull-request/SKILL.md` for the full flow.
- Work is planned on the Gateweave board, team AGT. Mention the issue key (`AGT-2`) in the pull
  request.

## Playbooks

Each folder in `.claude/skills/` holds a `SKILL.md` for a recurring task. They are plain Markdown,
so any agent can follow them:

| Skill               | Use it to                                                  |
| ------------------- | ---------------------------------------------------------- |
| `schema-change`     | Change the D1 schema with a migration                      |
| `add-adapter`       | Teach the scanner a new agent or file format               |
| `run-locally`       | Start the app and check a change in a real browser         |
| `open-pull-request` | Take a change from a branch to a merged-ready pull request |
