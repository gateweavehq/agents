# Docker cloud sandboxes as a sandbox backend

A decision record for AGT-55: whether Gateweave Agents should run its sandboxes on Docker's
cloud sandboxes, part of the Docker Agentic Platform, instead of or beside the Cloudflare
container it uses today (see "Sandboxes" in [architecture.md](architecture.md)).

## Decision

**Not now.** Gateweave Cloud does not use Docker's sandboxes for its customers' conversations,
and nothing is built yet. Once Docker calls the Sandboxes API generally available, a
`DockerSandboxBackend` may come as an option **for self-hosters only**, who bring a Docker
token of their own.

## Why

### Its interface would mostly fit

Docker's sandboxes are microVMs for coding agents, driven over HTTPS: a control API
(`https://connect.docker.com/sandboxes/v1`) creates, stops and snapshots them, and an endpoint
of each sandbox runs commands and processes and reads and writes files. A conversation reaches
its sandbox through `Sandbox` (`packages/runtime/src/conversation-agent.ts`), which joins
`CheckoutPort` (`checkout.ts`: commands, files and a checkout), `PushPort` (`push`,
`pull-requests.ts`), `EnginePort` (`startEngine`, a stream of the CLI's events, `stopEngine` and
`engineExit`, `engines.ts`) and `destroy`. Commands, files, processes and their output streams
map onto Docker's API. What does not is the way out: checkout, push and the engines depend on
`SandboxOutbound` adding the GitHub token and the model key to requests as they leave, which
Docker's sandboxes offer no place for (see below).

### Its terms rule out Gateweave Cloud

The [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)
(last updated 26 August 2026) licenses the services "for Customer's internal business purposes"
(§2.1). Among its use restrictions (§3.3), a customer may not "distribute, license, sublicense,
lease, rent, loan, or otherwise transfer the Services to any third party", nor access them "for
the purpose of developing or operating products or services intended to be offered to third
parties in competition with the Services". Gateweave Cloud would run other organizations'
agents on them, and Docker's own console runs Claude Code, Codex and OpenCode with an MCP
catalog (Docker's Agentic Platform documentation, read 30 October 2026 for AGT-55): that is
both. A self-hoster running their own agents on their own Docker account reads as internal use,
but operators should check the terms for themselves.

### It is experimental

Docker's documentation for the Sandboxes API and its SDK calls them experimental (checked
1 November 2026; the only claim of general availability found was a third-party post that the
docs contradict). The Agreement's §2.4 says of early access products that they "may be
inoperable or incomplete". A backend we would have to keep working is not worth building on that.

### It would weaken what the sandbox promises

Today's container against a Docker cloud sandbox:

- **Egress.** Today every request goes through `SandboxOutbound`, and `decideOutbound`
  (`outbound.ts`) lets through only downloads from package registries, git's fetches of the
  conversation's repository on github.com and the push `push` makes, the engine's requests to its
  model's provider while a turn runs, and the engine tools' host; it refuses the rest with a
  reason. Docker has allow and deny rules by host and port, with no way to send traffic through
  our own proxy: no per-request decision or reason.
- **Secrets.** Today the sandbox holds none: the model key and the repository's GitHub token
  are added to requests on the way out, and the environment and MCP headers stay in the Worker.
  On Docker, checkout and push would need a GitHub credential inside the sandbox, and a CLI
  engine a model key.
- **Reach.** Today only its conversation reaches it, over RPC, with no route. On Docker a
  published port is a public HTTPS URL with no Docker sign-in in front of it.
- **Lifetime.** Today it stops 15 minutes after its last call and lives as long as it is used.
  A Docker sandbox lives at most 24 hours from creation.
- **Limits.** Today our own rules apply (three per workspace at once); Docker's account defaults
  are 10 at once and 50 stored.

## If it comes back

When Docker calls the API generally available, a `DockerSandboxBackend` behind the same ports
would be a self-hoster's opt-in, with these conditions:

- The operator supplies the Docker token; Gateweave Cloud never holds one for a customer.
- Egress is allowed only to what `decideOutbound` allows: package registries, github.com, the
  provider of the agent's model, and the engine tools' host. A host rule cannot do what our
  per-request checks do (`checkModelRequest`, the turn's own model only; `checkPush`, only the
  conversation's branch, moved forward), so the backend must make up for them: a GitHub token
  scoped to the one repository and revoked when the turn ends, and a model key limited to what
  the agent may spend. The docs must say what is lost.
- No published ports.
- Credentials enter the sandbox only as short-lived tokens the server issues and revokes when
  the turn ends, and the docs say so where sandboxes are turned on.
- A conversation that outlives a sandbox's 24 hours gets a new one, as after the 15-minute stop
  today.

Look again at the terms then: the decision for Gateweave Cloud stands only as long as §2.1 and
§3.3 read as they do now.

## Sources

- The Agreement, read 2 November 2026: §2.1 (License Grant), §2.4 (Early Access) and §3.3 (Use
  Restrictions).
- Docker's documentation, read 30 October and 1 November 2026 (AGT-55): the
  [Agentic Platform](https://docs.docker.com/agentic-platform/), the
  [Sandboxes API](https://docs.docker.com/ai/sandboxes-api/), its
  [concepts](https://docs.docker.com/ai/sandboxes-api/concepts/) (lifetime, limits, ports, egress)
  and the [v1 reference](https://docs.docker.com/reference/api/sandboxes/latest/).
