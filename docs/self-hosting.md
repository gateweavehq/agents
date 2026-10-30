# Self-hosting

Agents runs on your own Cloudflare account as one Worker. It uses:

- a D1 database for accounts and the list of workspaces;
- a Durable Object for each workspace's registry and for each conversation with an agent;
- if you turn sandboxes on, a container for each conversation whose agent has one.

Agents call models with each workspace's own provider keys, so model usage is billed to the
workspace's accounts with the providers, not to yours. Only Workers AI (optional) and sandboxes
(optional, Workers Paid plan) cost your account more than the Worker itself.

## Deploy from the command line

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
git clone https://github.com/gateweavehq/agents.git
cd agents
pnpm install
pnpm wrangler login
pnpm run deploy
```

`pnpm wrangler` runs the Wrangler version Agents pins, from the repository root. The Worker and its
database are named `gateweave-agents`. To use other names, change `name` and `database_name` in
`wrangler.jsonc` before the first deploy.

The first deploy does three things:

1. It creates the D1 database and the Durable Object namespaces.
2. It generates `BETTER_AUTH_SECRET`, which is never shown.
3. It applies the migrations.

Every later `pnpm run deploy` builds, applies new migrations, and only then deploys. Durable
Objects migrate their own storage when each one wakes.

Then give the server a key for the secrets that workspaces entrust to it, such as model provider
keys:

```sh
openssl rand -base64 32 | pnpm wrangler secret put SECRETS_KEY
```

Keep it. If it changes, workspaces have to add their keys and secret values again.

Open the Worker's address, create an account and then a workspace. Anyone who can reach the
address can sign up and create workspaces of their own. A workspace is only visible to its members.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard (Workers &
Pages › your Worker › Settings › Variables and Secrets), or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

Keep tokens, keys and email addresses as secrets. The limits can be plain variables.

| Name                     | What it does                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`     | Signs sessions. Required.                                                                                        |
| `BETTER_AUTH_URL`        | The address people use, such as `https://agents.example.com`. Inferred from each request when unset.             |
| `SECRETS_KEY`            | Encrypts model provider keys and environment secrets (32 random bytes, base64). Model keys are off without it.   |
| `GITHUB_CLIENT_ID`       | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                                                     |
| `GITHUB_CLIENT_SECRET`   | The client secret of the same GitHub OAuth app.                                                                  |
| `GITHUB_APP_*`           | The six settings of the GitHub App that connects workspaces to repositories; see [github-app.md](github-app.md). |
| `EMAIL_FROM`             | Turns on email (invitations, password reset), such as `Gateweave Agents <agents@example.com>`.                   |
| `AI_GATEWAY_URL`         | Sends model calls through a Cloudflare AI Gateway: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`.   |
| `AI_GATEWAY_TOKEN`       | The gateway's token, when it is authenticated.                                                                   |
| `WORKERS_AI_TOKEN`       | Offers Workers AI models to every workspace, paid by your account. A Cloudflare API token with Workers AI.       |
| `CLOUDFLARE_ACCOUNT_ID`  | The account that pays for Workers AI. Taken from `AI_GATEWAY_URL` when unset.                                    |
| `SANDBOX_WORKSPACES`     | The ids of the workspaces that may use sandboxes, separated by commas. Every workspace when unset.               |
| `SANDBOX_DAILY_MINUTES`  | Minutes of sandbox time each workspace may use in a day (UTC).                                                   |
| `SANDBOX_MONTHLY_BUDGET` | US dollars the server may spend on sandboxes in a month (UTC).                                                   |
| `SANDBOX_ALERT_EMAIL`    | Who hears when sandboxes have spent 80% and then all of the monthly budget. Needs email.                         |

### Your own domain

In the dashboard, open the Worker and add a custom domain under Settings › Domains & Routes. Or
add `"routes": [{ "pattern": "agents.example.com", "custom_domain": true }]` to `wrangler.jsonc`.
Then set `BETTER_AUTH_URL` to that address, and use it in the GitHub apps' URLs.

### Email

Agents sends email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
Onboard the sender's domain once with `pnpm wrangler email sending enable example.com`, then set
`EMAIL_FROM` to an address on it. Without email, Agents works, but invitations have to be accepted
from a link that an admin copies, and nobody can reset a forgotten password.

### Sandboxes

A sandbox is a Linux machine for each conversation with an agent that has one. The agent runs
commands and edits files there, and Claude Code, Codex and OpenCode run there too. To turn
sandboxes on:

1. Add the `SANDBOX` binding and the `containers` entry that the `staging` environment in
   `wrangler.jsonc` has to the environment you deploy.
2. Deploy from a machine with Docker, which builds `sandbox/Dockerfile`.

Your account pays for the [Containers](https://developers.cloudflare.com/containers/pricing/) time,
which needs the Workers Paid plan. Each sandbox is a `standard-1` instance, at most about $0.074 an
hour while it runs. Each workspace has at most three sandboxes at once, and each stops 15 minutes
after its conversation's last turn. To keep the bill in hand:

- `SANDBOX_WORKSPACES` limits sandboxes to the workspaces you invite.
- `SANDBOX_DAILY_MINUTES` limits each workspace's minutes per day.
- `SANDBOX_MONTHLY_BUDGET` limits the server's spending per month. Agents prices sandbox time at
  the most it can cost, so Cloudflare's bill stays under the budget. Set `SANDBOX_ALERT_EMAIL` to
  hear at 80% and at 100%.

## Updating

```sh
git pull
pnpm install
pnpm run deploy
```

The deploy applies new D1 migrations before the new code goes live.
