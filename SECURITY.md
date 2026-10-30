# Security policy

## Supported versions

Gateweave Agents is in early development. Security fixes go into `main` and the latest release only.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/agents/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
We aim to reply within three working days, and will keep you updated while we work on a fix,
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- Access to a workspace's data without membership: through its pages and server functions, the
  chat gateway (`/api/chat/*`, including WebSocket handshakes from other origins), or the
  workspace's and conversations' Durable Objects, which have no public route.
- Secrets leaving where they belong: model provider keys and environment secrets (encrypted with
  the server's `SECRETS_KEY`) reaching a page, a log, a run's trace or a sandbox, or a GitHub
  token reaching a sandbox.
- Getting out of a sandbox: reaching the internet beyond the package registries it allows,
  writing to a repository other than its own, or pushing to a branch other than its
  conversation's.
- Webhooks accepted without a valid signature, or replayed: the GitHub App's
  (`/api/github/webhooks`) and triggers' (`/api/triggers/*`).
- Getting around a server's sandbox limits (invitations, time and budget), which its operator pays
  for.
- Authentication and session handling.
- Anything that lets one workspace member act with another member's identity or role.
