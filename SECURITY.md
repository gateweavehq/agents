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

- Access to a workspace's data without membership, including through the sync gateway
  (`/api/sync/*`) or WebSocket handshakes from other origins.
- Authentication and session handling.
- Anything that lets one workspace member act with another member's identity or role.
