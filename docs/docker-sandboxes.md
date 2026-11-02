# Docker Cloud Sandboxes as a sandbox backend

A decision record for AGT-55: whether Gateweave Agents should run its sandboxes on Docker's
cloud sandboxes, part of the Docker Agentic Platform, instead of or beside the Cloudflare
container it uses today (see "Sandboxes" in [architecture.md](architecture.md)).

## Decision

**Not now.** Gateweave Cloud does not use Docker's sandboxes for its customers' conversations,
and nothing is built yet. Once Docker calls the Sandboxes API generally available, a
`DockerSandboxBackend` may come as an option **for self-hosters only**, who bring a Docker
token of their own. The one-time compute credit on the owner's Docker account is for internal
experiments only.

## Why

### It would fit technically

Docker's sandboxes are microVMs for coding agents, driven over HTTPS: a control API
(`https://connect.docker.com/sandboxes/v1`) creates, stops and snapshots them, and an endpoint
of each sandbox runs commands and processes and reads and writes files. That covers what the
runtime asks of a sandbox: `SandboxPort` (`packages/runtime/src/sandbox-tools.ts`) needs only
`run`, `readFile` and `writeFile`, and `CheckoutPort` (`checkout.ts`) adds a checkout, which is
commands. Published ports and egress rules by host and port are there too.

### Its terms rule out Gateweave Cloud

The [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)
(last updated 26 August 2026) licenses the services "for Customer's internal business purposes"
(§2.1). Among its use restrictions (§3.3), a customer may not "distribute, license, sublicense,
lease, rent, loan, or otherwise transfer the Services to any third party", nor access them "for
the purpose of developing or operating products or services intended to be offered to third
parties in competition with the Services". Gateweave Cloud would run other organizations'
agents on them, and Docker's own console already runs Claude Code, Codex and OpenCode with an
MCP catalog: that is both. A self-hoster running their own agents on their own Docker account is
their internal use, which the terms allow.

### It is experimental

Docker's documentation for the Sandboxes API and its SDK calls them experimental (checked
1 November 2026; the only claim of general availability found was a third-party post that the
docs contradict). The Agreement says of early access products that they "may be inoperable or
incomplete". A backend we would have to keep working is not worth building on that.

### It would weaken what the sandbox promises

What it would cost, compared with today's container:

| Today (Cloudflare container)                                                                                                        | Docker cloud sandbox                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No internet: every request goes through `SandboxOutbound`, which lets package registries through and refuses the rest with a reason | Allow and deny rules by host and port; no way to send traffic through our own proxy, so no per-request decision or reason |
| Holds no secret: model keys, environment and MCP headers stay in the Worker                                                         | A CLI engine calling models from inside would need a key there: a revocable token we issue, not none                      |
| Reached only by its conversation, over RPC, with no route                                                                           | A published port is a public HTTPS URL, with no Docker sign-in in front of it                                             |
| Stops 15 minutes after its last call, and lives as long as it is used                                                               | Lives at most 24 hours from creation                                                                                      |
| Limited by our own rules (three per workspace at once)                                                                              | Account defaults of 10 at once and 50 stored                                                                              |

## If it comes back

When Docker calls the API generally available, a `DockerSandboxBackend` behind the same ports
would be a self-hoster's opt-in, with these conditions:

- The operator supplies the Docker token; Gateweave Cloud never holds one for a customer.
- Egress is set to the same allow list `decideOutbound` uses (package registries only), and
  the trace says the rules are Docker's, not ours.
- No published ports.
- Model and GitHub credentials enter the sandbox only as short-lived tokens the server issues
  and revokes when the turn ends, and the docs say so where sandboxes are turned on.
- A conversation that outlives a sandbox's 24 hours gets a new one, as after the 15-minute stop
  today.

Look again at the terms then: the decision for Gateweave Cloud stands only as long as §2.1 and
§3.3 read as they do now.

## Sources

- The Agreement, read 2 November 2026: §2.1 (License Grant), §2.4 (Early Access), §3.3 (Use
  Restrictions), §3.4 (sandbox governance is the customer's to configure).
- Docker's documentation, read 30 October and 1 November 2026 (AGT-55): the
  [Agentic Platform](https://docs.docker.com/agentic-platform/), the
  [Sandboxes API](https://docs.docker.com/ai/sandboxes-api/), its
  [concepts](https://docs.docker.com/ai/sandboxes-api/concepts/) (lifetime, limits, ports, egress)
  and the [v1 reference](https://docs.docker.com/reference/api/sandboxes/latest/).
